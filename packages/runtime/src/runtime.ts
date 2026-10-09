import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AiBddConfig,
  Diagnostic,
  DriverFactory,
  RunEvent,
  RunReport,
  ScenarioResult,
  Status,
  StepOptions,
} from '@ai-bdd/contracts';
import { AiBddError, uuidv7 } from '@ai-bdd/contracts';
import { createRegistry, type Registry } from '@ai-bdd/registry';
import { createSemanticResolver } from '@ai-bdd/semantic';
import { LockStore, createResolver } from '@ai-bdd/lock';
import { buildStrategies, createCacheStore } from '@ai-bdd/cache';
import { EvidenceStore } from '@ai-bdd/evidence';
import { createCalibrationJournal, createJudgeCache } from '@ai-bdd/judge';
import type { ModelSet } from '@ai-bdd/contracts';
import { resolveConfig } from './config.js';
import { discover } from './discover.js';
import { runScenario, type PipelineDependencies } from './pipeline.js';
import { newTrace } from './trace.js';
import { buildReport, writeReports } from './report.js';

export interface RunOptions {
  globs?: string[];
  tags?: string;
  driver?: string;
  frozen?: boolean;
  strictCache?: boolean;
  noCache?: boolean;
  repeatEach?: number;
  updateLock?: boolean;
  onEvent?: (event: RunEvent) => void;
}

export interface RuntimeOptions {
  projectRoot?: string;
  models: ModelSet;
  drivers: Record<string, DriverFactory>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Version reported in the run report. */
  version?: string;
}

export interface BindingRegistrationContext {
  registry: Registry;
  config: ReturnType<typeof resolveConfig>;
}

/**
 * The runtime owns discovery, the scheduler, the per-step pipeline, caching,
 * evidence and reporting. The daemon and the CLI are thin wrappers over it.
 */
export class Runtime {
  private readonly config: ReturnType<typeof resolveConfig>;
  private readonly options: RuntimeOptions;

  constructor(config: AiBddConfig, options: RuntimeOptions) {
    const projectRoot = options.projectRoot ?? process.cwd();
    this.config = resolveConfig(config, projectRoot, options.env ?? process.env);
    this.options = { ...options, projectRoot };
  }

  get resolvedConfig(): ReturnType<typeof resolveConfig> {
    return this.config;
  }

  async run(runOptions: RunOptions = {}): Promise<RunReport> {
    const config = this.config;
    const now = this.options.now ?? (() => new Date());
    const emit = (event: RunEvent): void => runOptions.onEvent?.(event);
    const runId = uuidv7();
    const startedAt = now().toISOString();
    const diagnostics: Diagnostic[] = [];
    const isCi = (this.options.env ?? process.env).CI !== undefined && (this.options.env ?? process.env).CI !== '';
    const frozen = runOptions.frozen ?? isCi;
    const strictCache = runOptions.strictCache ?? isCi;
    const cacheMode = runOptions.noCache ? 'off' : config.cache.mode;

    const startDriver = runOptions.driver ?? config.defaultDriver;
    emit({
      type: 'run:start',
      runId,
      at: startedAt,
      specs: runOptions.globs ?? config.specs,
      ...(startDriver !== undefined ? { driver: startDriver } : {}),
    });

    // 1. Bindings.
    const registry = createRegistry({ config: { kinds: config.kinds } });
    for (const file of expandBindingGlobs(config)) {
      try {
        const module = (await import(file)) as { register?: (ctx: BindingRegistrationContext) => void | Promise<void> };
        if (typeof module.register === 'function') await module.register({ registry, config });
      } catch (error) {
        diagnostics.push({
          code: 'CONFIG_INVALID',
          severity: 'error',
          message: `could not load bindings from ${file}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // 2. Discovery.
    const discovery = discover(config.projectRoot, runOptions.globs ?? config.specs, config.concepts);
    diagnostics.push(...discovery.diagnostics);
    emit({ type: 'spec:parsed', uri: '*', dialect: 'gauge', scenarios: discovery.documents.reduce((total, doc) => total + doc.scenarios.length, 0), diagnostics: discovery.diagnostics });

    // 3. Caches, resolver, evidence.
    const cache = createCacheStore({
      dir: join(config.projectRoot, config.cache.dir),
      mode: cacheMode,
      strategies: buildStrategies(config.cache.invalidation, {
        ...(config.cache.files !== undefined ? { files: config.cache.files } : {}),
        ...(config.cache.buildChecksum !== undefined ? { buildChecksum: config.cache.buildChecksum } : {}),
        ...(config.cache.manual !== undefined ? { manual: config.cache.manual } : {}),
        ...(config.cache.custom !== undefined ? { custom: config.cache.custom } : {}),
      }),
    });
    const lockPath = join(config.projectRoot, 'ai-bdd.lock.json');
    const lock = LockStore.load(lockPath);
    const semantic = createSemanticResolver({
      embedder: this.options.models.embed,
      extractor: this.options.models.extract,
      config: {
        threshold: config.resolution.threshold,
        margin: config.resolution.margin,
        ...(config.resolution.semantic.guards !== undefined ? { guards: config.resolution.semantic.guards } : {}),
        kinds: config.kinds,
        embedCacheDir: join(config.projectRoot, config.cache.dir, 'embeddings'),
      },
    });
    const resolver = createResolver({
      registry,
      semantic,
      lock,
      config: {
        threshold: config.resolution.threshold,
        margin: config.resolution.margin,
        allowAgentSetup: config.resolution.allowAgentSetup,
        semantic: { enabled: config.resolution.semantic.enabled },
      },
    });
    const runDir = join(config.projectRoot, config.evidence.dir, runId);
    mkdirSync(runDir, { recursive: true });
    const evidence = new EvidenceStore(runDir, { runId, now });

    // 4. Scheduler: one session per scenario, honouring the concurrency setting.
    const driverName = runOptions.driver ?? config.defaultDriver ?? Object.keys(this.options.drivers)[0];
    if (!driverName) throw new AiBddError('CONFIG_INVALID', 'no driver is configured');
    const factory = this.options.drivers[driverName];
    if (!factory) throw new AiBddError('CONFIG_INVALID', `unknown driver \`${driverName}\``);

    const tagFilter = runOptions.tags ? compileTagExpression(runOptions.tags) : undefined;
    const scenarios = discovery.documents.flatMap((document) =>
      document.scenarios
        .filter((scenario) => (tagFilter ? tagFilter(scenario.tags) : true))
        .map((scenario) => ({ document, scenario })),
    );
    const repeatEach = Math.max(1, runOptions.repeatEach ?? 1);
    const queue = Array.from({ length: repeatEach }, () => scenarios).flat();

    const results: ScenarioResult[] = [];
    const judgeCache = createJudgeCache();
    const workerCount = Math.max(1, Math.min(config.concurrency.scenarios, queue.length));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        if (!item) continue;
        const { document, scenario } = item;
        const traceId = newTrace().traceId;
        emit({ type: 'scenario:start', scenarioId: scenario.id, name: scenario.name, tags: scenario.tags, at: now().toISOString() });
        const driver = await factory.create({
          sessionId: scenario.id,
          scenarioId: scenario.id,
          driver: driverName,
          config: { allowHosts: config.policy.allowHosts } as never,
        });
        const session = await driver.openSession({
          sessionId: scenario.id,
          scenarioId: scenario.id,
          driver: driverName,
          config: { allowHosts: config.policy.allowHosts } as never,
        });
        try {
          const deps: PipelineDependencies = {
            config,
            registry,
            resolver: resolver as never,
            cache: cache as never,
            models: this.options.models,
            evidence: evidence as never,
            driver: { id: factory.id, major: 1 },
            judgeCache,
            journal: createCalibrationJournal(join(config.projectRoot, '.ai-bdd', 'calibration', 'judgments.jsonl')),
            frozen,
            strictCache,
            now,
            diagnostics,
          };
          const result = await runScenario(deps, document, scenario, session, traceId);
          const normalized = applyStrictCache(result, strictCache);
          results.push(normalized);
          emit({ type: 'scenario:end', scenarioId: scenario.id, result: normalized, at: now().toISOString() });
        } finally {
          await session.close().catch(() => undefined);
          await cache.commitPending?.().catch(() => undefined);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (runOptions.updateLock || !frozen) await lock.save();
    const manifest = await evidence.finalize();
    const finishedAt = now().toISOString();
    const report = buildReport({
      runId,
      version: this.options.version ?? '0.1.0',
      startedAt,
      finishedAt,
      driver: driverName,
      results,
      diagnostics,
      frozen,
      strictCache,
      runDir,
      rootHash: manifest.rootHash,
      lock,
    });

    const files = await writeReports(report, {
      outDir: join(config.projectRoot, '.ai-bdd'),
      reporters: config.reporters,
      evidenceRunDir: runDir,
    });
    void files;
    emit({ type: 'run:end', runId, exitCode: report.exitCode, at: finishedAt });
    return report;
  }
}

export function createRuntime(config: AiBddConfig, options: RuntimeOptions): Runtime {
  return new Runtime(config, options);
}

/** A scenario that healed fails under --strict-cache (R-K8, section 8.5). */
function applyStrictCache(result: ScenarioResult, strictCache: boolean): ScenarioResult {
  if (!strictCache) return result;
  const healed = result.steps.filter((step) => step.status === 'healed');
  if (healed.length === 0) return result;
  return {
    ...result,
    status: 'failed' as Status,
    steps: result.steps.map((step) =>
      step.status === 'healed'
        ? {
            ...step,
            status: 'failed' as Status,
            error: {
              code: 'CACHE_REPLAY_DIVERGED',
              message: 'the cached act program diverged and the agent healed the step (--strict-cache)',
              retryable: false,
            },
          }
        : step,
    ),
  };
}

/** Minimal Cucumber tag-expression subset: `@a`, `not @a`, `@a and @b`, `@a or @b`, parentheses. */
export function compileTagExpression(expression: string): (tags: string[]) => boolean {
  const tokens = expression.match(/@[\w.:-]+|\(|\)|and|or|not/gu) ?? [];
  let index = 0;
  const parseOr = (): ((tags: string[]) => boolean) => {
    let left = parseAnd();
    while (tokens[index] === 'or') {
      index += 1;
      const right = parseAnd();
      const previous = left;
      left = (tags) => previous(tags) || right(tags);
    }
    return left;
  };
  const parseAnd = (): ((tags: string[]) => boolean) => {
    let left = parseUnary();
    while (tokens[index] === 'and') {
      index += 1;
      const right = parseUnary();
      const previous = left;
      left = (tags) => previous(tags) && right(tags);
    }
    return left;
  };
  const parseUnary = (): ((tags: string[]) => boolean) => {
    const token = tokens[index];
    if (token === 'not') {
      index += 1;
      const inner = parseUnary();
      return (tags) => !inner(tags);
    }
    if (token === '(') {
      index += 1;
      const inner = parseOr();
      if (tokens[index] === ')') index += 1;
      return inner;
    }
    index += 1;
    const wanted = (token ?? '').replace(/^@/u, '');
    return (tags) => tags.map((tag) => tag.replace(/^@/u, '')).includes(wanted);
  };
  const predicate = parseOr();
  return predicate;
}

function expandBindingGlobs(config: ReturnType<typeof resolveConfig>): string[] {
  return config.bindings.flatMap((pattern) => {
    const root = config.projectRoot;
    const matches: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of safeReadDir(dir)) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (matchesPattern(full.slice(root.length + 1), pattern)) matches.push(full);
      }
    };
    walk(root);
    return matches;
  });
}

function safeReadDir(dir: string): Array<{ name: string; isDirectory: () => boolean }> {
  try {
    return Array.from(readdirSync(dir, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: () => entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.includes('**')) {
    const [prefix, suffix] = pattern.split('**');
    const head = (prefix ?? '').replace(/\/$/u, '');
    const tail = (suffix ?? '').replace(/^\//u, '');
    return (!head || path.includes(head)) && (!tail || path.endsWith(tail.replace(/^\*/u, '').replace(/^\./u, '.')));
  }
  return path === pattern;
}

import { readdirSync } from 'node:fs';

/** Writes a report file, used by the CLI. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export type { StepOptions };
