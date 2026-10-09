import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BindingDescriptor,
  Capabilities,
  DriverFactory,
  DriverSession,
  HealthOutput,
  JsonValue,
  ModelSet,
  Observation,
  ResolvedConfig,
  ScenarioResult,
  StepArg,
  StepResult,
  StepKind,
} from '@ai-bdd/contracts';
import { AiBddError, bindingSetHash, normalizeStepText, uuidv7 } from '@ai-bdd/contracts';
import { buildStrategies, createCacheStore } from '@ai-bdd/cache';
import { EvidenceStore, settle } from '@ai-bdd/evidence';
import { createCalibrationJournal, createJudgeCache } from '@ai-bdd/judge';
import { LockStore, createResolver } from '@ai-bdd/lock';
import { createRegistry, type Registry } from '@ai-bdd/registry';
import { createSemanticResolver } from '@ai-bdd/semantic';
import { inferKind, mergeOptions } from '@ai-bdd/spec-directives';
import { expandBindingGlobs } from './bindings.js';
import { createStepState, runPipelineStep, type PipelineDependencies, type StepState } from './pipeline.js';
import { newTrace, span } from './trace.js';

export interface SessionPlugin {
  name: string;
  version: string;
  language: string;
}

export interface OpenSessionInput {
  scenarioId: string;
  scenarioName: string;
  tags: string[];
  driver?: string;
  target?: JsonValue;
  plugin: SessionPlugin;
}

export interface OpenSessionOutput {
  sessionId: string;
  traceId: string;
  driver: string;
  capabilities: Capabilities;
}

export interface StepPayload {
  text: string;
  keyword?: string;
  kind?: StepKind;
  args?: StepArg[];
  options?: Record<string, JsonValue>;
  stepId?: string;
  scenarioId?: string;
}

export interface RegisterBindingsInput {
  sessionId?: string;
  provider: string;
  bindings: BindingDescriptor[];
}

export interface RegisterBindingsOutput {
  bindingSetHash: string;
  accepted: number;
  rejected: Array<{ id: string; reason: string }>;
}

export interface ResolveStepOutput {
  resolution: StepResult['resolution'];
  kind: StepKind;
  kindSource: StepResult['kindSource'];
  next: 'invoke-local' | 'run-step' | 'fail';
  error?: { code: string; message: string; retryable: boolean };
}

export interface ReportBindingResultInput {
  sessionId: string;
  step: StepPayload;
  bindingId: string;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: { message: string; stack?: string };
  judgeAfter?: boolean;
}

export interface SessionManagerOptions {
  config: ResolvedConfig;
  models: ModelSet;
  drivers: Record<string, DriverFactory>;
  now?: () => Date;
  /** Reap stale session ledger entries at start (default true). */
  reapOrphans?: boolean;
}

interface SessionRecord {
  sessionId: string;
  scenarioId: string;
  scenarioName: string;
  tags: string[];
  driverName: string;
  driver: DriverSession;
  traceId: string;
  state: StepState;
  results: StepResult[];
  openedAt: string;
  plugin: SessionPlugin;
  capabilities: Capabilities;
}

/**
 * The session-oriented view of the runtime that the daemon exposes.
 *
 * One session = one scenario instance = one driver session (section 10.1). The
 * manager owns the binding registry, the resolver, the caches, the judge and the
 * evidence store, so plugins only forward steps and report local results.
 */
export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly config: ResolvedConfig;
  private readonly registry: Registry;
  private readonly resolver: ReturnType<typeof createResolver>;
  private readonly cache: ReturnType<typeof createCacheStore>;
  private readonly lock: LockStore;
  private readonly evidence: EvidenceStore;
  private readonly judgeCache = createJudgeCache();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => Date;
  private readonly runId = uuidv7();
  private bindingsLoaded = false;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.registry = createRegistry({ config: { kinds: this.config.kinds } });
    this.lock = LockStore.load(join(this.config.projectRoot, 'ai-bdd.lock.json'));
    this.cache = createCacheStore({
      dir: join(this.config.projectRoot, this.config.cache.dir),
      mode: this.config.cache.mode,
      strategies: buildStrategies(this.config.cache.invalidation, {}),
      now: this.now,
    });
    this.evidence = new EvidenceStore(join(this.config.projectRoot, this.config.evidence.dir, this.runId), {
      runId: this.runId,
      now: this.now,
    });
    this.resolver = createResolver({
      registry: this.registry,
      semantic: createSemanticResolver({
        embedder: options.models.embed,
        extractor: options.models.extract,
        config: {
          threshold: this.config.resolution.threshold,
          margin: this.config.resolution.margin,
          ...(this.config.resolution.semantic.guards !== undefined ? { guards: this.config.resolution.semantic.guards } : {}),
          kinds: this.config.kinds,
          embedCacheDir: join(this.config.projectRoot, this.config.cache.dir, 'embeddings'),
        },
      }),
      lock: this.lock,
      config: {
        threshold: this.config.resolution.threshold,
        margin: this.config.resolution.margin,
        allowAgentSetup: this.config.resolution.allowAgentSetup,
        semantic: { enabled: this.config.resolution.semantic.enabled },
      },
    });
    if (options.reapOrphans !== false) this.reapOrphans();
  }

  get evidenceRunId(): string {
    return this.runId;
  }

  get evidenceRunDir(): string {
    return join(this.config.projectRoot, this.config.evidence.dir, this.runId);
  }

  readEvidence(evidenceId: string): { absolutePath: string } | null {
    const jsonl = join(this.evidenceRunDir, 'manifest.jsonl');
    if (!existsSync(jsonl)) return null;
    for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { evidenceId: string; artifact: { path: string } };
      if (record.evidenceId !== evidenceId) continue;
      const absolutePath = join(this.evidenceRunDir, record.artifact.path);
      // Confine the read to the run directory: a client cannot ask for /etc/passwd.
      if (!absolutePath.startsWith(this.evidenceRunDir)) return null;
      return { absolutePath };
    }
    return null;
  }

  async health(): Promise<HealthOutput> {
    const drivers: HealthOutput['drivers'] = [];
    for (const [name, factory] of Object.entries(this.options.drivers)) {
      try {
        const driver = await factory.create({ sessionId: 'health', scenarioId: 'health', config: {}, driver: name });
        const result = await driver.selfCheck();
        drivers.push({ name, ok: result.ok, problems: result.problems });
      } catch (error) {
        drivers.push({ name, ok: false, problems: [AiBddError.payload(error).message] });
      }
    }
    return { ok: true, version: '0.1.0', drivers, protocol: 1 };
  }

  async openSession(input: OpenSessionInput): Promise<OpenSessionOutput> {
    await this.loadLocalBindings();
    const driverName = input.driver ?? this.config.defaultDriver ?? Object.keys(this.options.drivers)[0];
    if (!driverName) throw new AiBddError('CONFIG_INVALID', 'no driver is configured');
    const factory = this.options.drivers[driverName];
    if (!factory) throw new AiBddError('CONFIG_INVALID', `unknown driver \`${driverName}\``);

    const sessionId = input.scenarioId.length > 0 ? `${input.scenarioId}` : uuidv7();
    const driver = await factory.create({
      sessionId,
      scenarioId: input.scenarioId,
      driver: driverName,
      config: { allowHosts: this.config.policy.allowHosts } as never,
    });
    const session = await driver.openSession({
      sessionId,
      scenarioId: input.scenarioId,
      driver: driverName,
      config: { allowHosts: this.config.policy.allowHosts } as never,
      ...(input.target !== undefined ? { target: input.target } : {}),
    });
    const record: SessionRecord = {
      sessionId,
      scenarioId: input.scenarioId,
      scenarioName: input.scenarioName,
      tags: input.tags,
      driverName,
      driver: session,
      traceId: newTrace().traceId,
      state: createStepState(),
      results: [],
      openedAt: this.now().toISOString(),
      plugin: input.plugin,
      capabilities: driver.capabilities,
    };
    this.sessions.set(sessionId, record);
    this.writeLedger(record);
    return { sessionId, traceId: record.traceId, driver: driverName, capabilities: driver.capabilities };
  }

  /** Bindings published by a language plugin: they win over the agent, never over local ones. */
  async registerBindings(input: RegisterBindingsInput): Promise<RegisterBindingsOutput> {
    const accepted: BindingDescriptor[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    for (const descriptor of input.bindings) {
      try {
        if (!descriptor.id || !descriptor.pattern) {
          rejected.push({ id: descriptor.id ?? '(anonymous)', reason: 'id and pattern are required' });
          continue;
        }
        this.registry.addRemote(input.provider, [descriptor]);
        accepted.push(descriptor);
      } catch (error) {
        rejected.push({ id: descriptor.id, reason: AiBddError.payload(error).message });
      }
    }
    const bindings = this.registry.set().bindings;
    return { bindingSetHash: bindingSetHash(bindings), accepted: accepted.length, rejected };
  }

  async resolveStep(input: { sessionId: string; step: StepPayload }): Promise<ResolveStepOutput> {
    await this.loadLocalBindings();
    const record = this.require(input.sessionId);
    const step = toAstStep(input.step, record);
    const options = mergeOptions({}, {}, {}, step.options);
    const probe = this.registry.matchExact(step.text);
    const inferred = inferKind({
      text: step.text,
      ...(step.keyword !== undefined ? { keyword: step.keyword } : {}),
      options,
      ...(probe.matches[0]?.binding.kind !== undefined ? { bindingKind: probe.matches[0].binding.kind } : {}),
      config: { kinds: this.config.kinds },
    });
    const kind: StepKind = step.kindSource === 'keyword' ? step.kind : inferred.kind;
    const kindSource = step.kindSource === 'keyword' ? step.kindSource : inferred.kindSource;
    const result = await this.resolver.resolve({ ...step, kind, kindSource }, { frozen: false });
    const resolution = result.resolution;
    if (resolution.type === 'ambiguous') {
      return {
        resolution,
        kind,
        kindSource,
        next: 'fail',
        error: { code: 'STEP_AMBIGUOUS', message: resolution.message, retryable: false },
      };
    }
    if (resolution.type === 'unbound') {
      return {
        resolution,
        kind,
        kindSource,
        next: 'fail',
        error: { code: 'SETUP_UNBOUND', message: resolution.message, retryable: false },
      };
    }
    if (resolution.type === 'exact' || resolution.type === 'semantic') {
      const known = this.registry.find(resolution.bindingId) !== undefined;
      const hasFn = this.registry.functions().has(resolution.bindingId);
      if (!known) {
        return {
          resolution,
          kind,
          kindSource,
          next: 'fail',
          error: { code: 'PARAM_EXTRACTION_FAILED', message: `unknown binding ${resolution.bindingId}`, retryable: false },
        };
      }
      return { resolution, kind, kindSource, next: hasFn ? 'run-step' : 'invoke-local' };
    }
    return { resolution, kind, kindSource, next: 'run-step' };
  }

  async runStep(input: { sessionId: string; step: StepPayload }): Promise<StepResult> {
    const record = this.require(input.sessionId);
    const step = toAstStep(input.step, record);
    const trace = span(record.traceId);
    const result = await runPipelineStep(this.dependencies(), step, record.driver, record.state, trace, {
      id: record.scenarioId,
      name: record.scenarioName,
      tags: record.tags,
      steps: [],
      options: {},
      location: step.location,
    });
    record.results.push(result);
    return result;
  }

  async reportBindingResult(input: ReportBindingResultInput): Promise<StepResult> {
    const record = this.require(input.sessionId);
    const step = toAstStep(input.step, record);
    const trace = span(record.traceId);
    const observation = await record.driver.observe({ pixels: false });
    const evidence = await this.evidence.write({
      kind: 'log',
      data: {
        bindingId: input.bindingId,
        status: input.status,
        step: input.step.text,
        durationMs: input.durationMs,
        ...(input.error !== undefined ? { error: input.error.message } : {}),
      },
      ext: 'json',
      stepId: step.id,
    });
    const result: StepResult = {
      stepId: step.id,
      text: step.text,
      kind: step.kind,
      kindSource: step.kindSource,
      status: input.status,
      resolution: { type: 'exact', bindingId: input.bindingId, bindingHash: input.bindingId, params: {} },
      evidence: [{ evidenceId: evidence.evidenceId, kind: 'log', sha256: evidence.artifact.sha256 }],
      durationMs: input.durationMs,
      traceId: trace.traceId,
      traceparent: trace.traceparent,
      ...(input.error !== undefined
        ? { error: { code: 'INTERNAL', message: input.error.message, retryable: false } }
        : {}),
    };
    void observation;
    record.results.push(result);
    return result;
  }

  async closeSession(input: { sessionId: string; status: 'passed' | 'failed' | 'skipped' }): Promise<{ scenarioResult: ScenarioResult }> {
    const record = this.sessions.get(input.sessionId);
    if (!record) throw new AiBddError('NO_SESSION', `unknown session ${input.sessionId}`);
    this.sessions.delete(input.sessionId);
    try {
      await record.driver.close();
    } catch {
      // closing is best effort
    }
    rmSync(this.ledgerPath(input.sessionId), { force: true });
    const scenarioResult: ScenarioResult = {
      scenarioId: record.scenarioId,
      name: record.scenarioName,
      specName: record.plugin.name,
      uri: `plugin:${record.plugin.name}`,
      tags: record.tags,
      status: input.status,
      steps: record.results,
      durationMs: this.now().getTime() - new Date(record.openedAt).getTime(),
      traceId: record.traceId,
      driver: record.driverName,
    };
    return { scenarioResult };
  }

  /** Settles the session's screen, used by drivers and tests. */
  async settle(sessionId: string): Promise<Observation> {
    const record = this.require(sessionId);
    const result = await settle(record.driver, this.config.evidence.settle);
    return result.observation;
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession({ sessionId, status: 'skipped' }).catch(() => undefined);
    }
  }

  private dependencies(): PipelineDependencies {
    return {
      config: this.config,
      registry: this.registry,
      resolver: this.resolver as never,
      cache: this.cache as never,
      models: this.options.models,
      evidence: this.evidence as never,
      driver: { id: 'session', major: 1 },
      judgeCache: this.judgeCache,
      journal: createCalibrationJournal(join(this.config.projectRoot, '.ai-bdd', 'calibration', 'judgments.jsonl')),
      frozen: false,
      strictCache: false,
      now: this.now,
      diagnostics: [],
    };
  }

  private require(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new AiBddError('NO_SESSION', `unknown or expired session ${sessionId}`);
    return record;
  }

  private async loadLocalBindings(): Promise<void> {
    if (this.bindingsLoaded) return;
    this.bindingsLoaded = true;
    for (const file of expandBindingGlobs(this.config)) {
      try {
        const module = (await import(file)) as { register?: (ctx: unknown) => void | Promise<void> };
        if (typeof module.register === 'function') await module.register({ registry: this.registry, config: this.config });
      } catch {
        // a broken local binding file must not take the daemon down
      }
    }
  }

  private ledgerPath(sessionId: string): string {
    // A plugin may use a human-readable scenario id (`features/x.feature#name`),
    // so the ledger filename is sanitised before it becomes a path.
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120);
    return join(this.config.projectRoot, '.ai-bdd', 'sessions', `${safe || 'session'}.json`);
  }

  private writeLedger(record: SessionRecord): void {
    const path = this.ledgerPath(record.sessionId);
    mkdirSync(join(this.config.projectRoot, '.ai-bdd', 'sessions'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, driver: record.driverName, openedAt: record.openedAt })}\n`);
  }

  /** A pid that is gone means the session is an orphan: drop its ledger entry. */
  private reapOrphans(): void {
    const dir = join(this.config.projectRoot, '.ai-bdd', 'sessions');
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        const entry = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number };
        if (entry.pid !== undefined && !isProcessAlive(entry.pid)) rmSync(path, { force: true });
      } catch {
        rmSync(path, { force: true });
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toAstStep(step: StepPayload, record: SessionRecord): {
  id: string;
  text: string;
  normalized: string;
  keyword?: string;
  kind: StepKind;
  kindSource: StepResult['kindSource'];
  args: StepArg[];
  options: Record<string, JsonValue>;
  location: { uri: string; line: number; column: number };
  originChain: [];
} {
  const kind = step.kind ?? 'action';
  return {
    id: step.stepId ?? `${record.scenarioId}#${normalizeStepText(step.text)}`,
    text: step.text,
    normalized: normalizeStepText(step.text),
    ...(step.keyword !== undefined ? { keyword: step.keyword } : {}),
    kind,
    kindSource: step.kind !== undefined ? 'keyword' : 'default',
    args: step.args ?? [],
    options: (step.options ?? {}) as never,
    location: { uri: `plugin:${record.plugin.name}`, line: 1, column: 1 },
    originChain: [],
  } as never;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return new SessionManager(options);
}
