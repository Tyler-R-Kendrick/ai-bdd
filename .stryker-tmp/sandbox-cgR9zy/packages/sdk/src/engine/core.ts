// @ts-nocheck
import { join } from 'node:path';
import {
  AiBddError,
  type Diagnostic,
  type Driver,
  type EvidenceStore,
  type PlanStore,
  type Planner,
  type Clock,
  type ModelSet,
  type RecordingStore,
  type Redactor,
  type ResolvedConfig,
  type RunEvent,
  type Runner,
} from '../contracts/index.ts';
import { MIN_SECRET_LENGTH } from '../config/index.ts';
import { uuidv7 } from '../util/index.ts';
import type { EngineModules } from './modules.ts';
import { createUsageMeter, type UsageMeter } from './usage.ts';
import { errorMessage } from './util.ts';

function memo<T>(fn: () => T): () => T {
  let cell: { value: T } | undefined;
  return () => (cell ??= { value: fn() }).value;
}

/** A driver stand-in used when a factory fails to create its driver: it reports DRIVER_UNAVAILABLE on use. */
function unavailableDriver(name: string, err: unknown): Driver {
  const message = `driver "${name}" is unavailable: ${errorMessage(err)}`;
  return {
    id: name,
    version: '0.0.0',
    capabilities: { verbs: [], pixels: false, maskingProven: false, request: false, maxSessions: 1 },
    openSession: () => Promise.reject(new AiBddError('DRIVER_UNAVAILABLE', message, { cause: err })),
    selfCheck: () => Promise.resolve({ ok: false, problems: [message] }),
    dispose: () => Promise.resolve(),
  };
}

/**
 * Shared, lazily wired state of one engine instance. Sibling modules are only touched when first needed
 * (never at engine creation), so creating an engine is cheap and works while siblings are stubs.
 */
export class Core {
  readonly meter: UsageMeter;
  readonly driverMap = new Map<string, Driver>();
  readonly warnings: Diagnostic[] = [];
  closed = false;

  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly secretValues: Record<string, string> = {};
  private readonly driverPromises = new Map<string, Promise<void>>();
  private readonly createdEvidence: EvidenceStore[] = [];
  private sharedEvidencePromise: Promise<EvidenceStore> | undefined;
  private sharedRunnerPromise: Promise<Runner> | undefined;
  private sameModelWarned = false;

  readonly redactor = memo((): Redactor => this.modules.createRedactor({ ...this.secretValues }));
  readonly planner = memo((): Planner => this.modules.createPlanner(this.config, (text) => this.redactor().redact(text)));
  readonly planStore = memo((): PlanStore => this.modules.createPlanStore({ dir: this.config.planDir, readOnly: false }));
  readonly recordings = memo((): RecordingStore =>
    this.modules.createRecordingStore({ dir: this.config.recordingsDir, mode: this.config.recordingsMode }),
  );

  readonly config: ResolvedConfig;
  readonly modules: EngineModules;
  readonly clock: Clock;
  readonly env: Record<string, string | undefined>;
  private readonly driverFactories: ResolvedConfig['drivers'];

  constructor(
    config: ResolvedConfig,
    modules: EngineModules,
    clock: Clock,
    env: Record<string, string | undefined>,
    models: ModelSet | undefined,
    driverFactories: ResolvedConfig['drivers'],
  ) {
    this.config = config;
    this.modules = modules;
    this.clock = clock;
    this.env = env;
    this.driverFactories = driverFactories;
    this.meter = createUsageMeter(models, config.prices);
    // Secrets are resolved from the environment once, here. Values live only in this closure and the redactor.
    for (const [name, spec] of Object.entries(config.secrets)) {
      const value = env[spec.env];
      if (value === undefined || value === '') continue;
      if (value.length < MIN_SECRET_LENGTH) {
        throw new AiBddError('SECRET_TOO_SHORT', `Secret "${name}" (env ${spec.env}) is shorter than ${MIN_SECRET_LENGTH} characters`, {
          details: { name, env: spec.env, minLength: MIN_SECRET_LENGTH },
        });
      }
      this.secretValues[name] = value;
    }
    if (models !== undefined && models.judge.id === models.act.id) {
      this.warnings.push({
        code: 'JUDGE_SAME_AS_ACTOR',
        severity: 'warning',
        message: `The judge model ("${models.judge.id}") is the same model as the actor; judge independence is reduced`,
      });
    }
  }

  readonly secretValue = (name: string): string | undefined => this.secretValues[name];

  get models(): ModelSet {
    return this.meter.models;
  }

  on(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  readonly emit = (event: RunEvent): void => {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // A faulty listener must never break a run.
      }
    }
  };

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, scenarioId?: string): void {
    this.emit(scenarioId === undefined ? { type: 'log', level, message } : { type: 'log', level, message, scenarioId });
  }

  /** Emit the JUDGE_SAME_AS_ACTOR warning once per engine. */
  warnOnce(): void {
    if (this.sameModelWarned || this.warnings.length === 0) return;
    this.sameModelWarned = true;
    for (const w of this.warnings) this.log('warn', `${w.code}: ${w.message}`);
  }

  assertOpen(): void {
    if (this.closed) throw new AiBddError('INTERNAL', 'engine is closed');
  }

  /** Create (once) the drivers with the given configured names. Unknown names are left to the runner to report. */
  async ensureDrivers(names: readonly (string | undefined)[]): Promise<void> {
    await Promise.all(
      [...new Set(names)].map((name) => {
        if (name === undefined || this.driverMap.has(name)) return Promise.resolve();
        const factory = this.driverFactories[name];
        if (factory === undefined) return Promise.resolve();
        let p = this.driverPromises.get(name);
        if (p === undefined) {
          p = (async () => {
            try {
              const driver = await factory.create({
                projectRoot: this.config.projectRoot,
                ...(this.config.baseURL === undefined ? {} : { baseURL: this.config.baseURL }),
                policy: this.config.policy,
                artifactsDir: join(this.config.cacheDir, 'driver'),
              });
              this.driverMap.set(name, driver);
            } catch (err) {
              this.driverMap.set(name, unavailableDriver(name, err));
            }
          })();
          this.driverPromises.set(name, p);
        }
        return p;
      }),
    );
  }

  async newEvidence(): Promise<EvidenceStore> {
    const evidence = await this.modules.createEvidenceStore({ runsDir: this.config.runsDir, runId: uuidv7(this.clock.now()), redactor: this.redactor() });
    this.createdEvidence.push(evidence);
    return evidence;
  }

  /** The lazily created run directory shared by every `runScenario` call of this engine. */
  sharedEvidence(): Promise<EvidenceStore> {
    this.sharedEvidencePromise ??= this.newEvidence();
    return this.sharedEvidencePromise;
  }

  buildRunner(evidence: EvidenceStore): Runner {
    const m = this.modules;
    const redactor = this.redactor();
    const settler = m.createSettler({ clock: this.clock });
    return m.createRunner({
      config: this.config,
      drivers: this.driverMap,
      actor: m.createActor({ model: this.models.act, redactor, settler, config: this.config, evidence }),
      recorder: m.createRecorder({ settler, config: this.config }),
      recordings: this.recordings(),
      asserter: m.createAsserter({ model: this.models.checkgen, redactor, config: this.config, evidence }),
      judge: m.createJudge({ model: this.models.judge, config: this.config, cacheDir: this.config.cacheDir, evidence }),
      settler,
      evidence,
      redactor,
      secretValue: this.secretValue,
      clock: this.clock,
      emit: this.emit,
    });
  }

  sharedRunner(): Promise<Runner> {
    this.sharedRunnerPromise ??= this.sharedEvidence().then((e) => this.buildRunner(e));
    return this.sharedRunnerPromise;
  }

  /** Finalize the lazily created run dir (if any) and dispose every driver. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    if (this.sharedEvidencePromise !== undefined) {
      try {
        await (await this.sharedEvidencePromise).finalize();
      } catch (err) {
        errors.push(err);
      }
    }
    await Promise.allSettled([...this.driverPromises.values()]);
    for (const driver of this.driverMap.values()) {
      try {
        await driver.dispose();
      } catch (err) {
        errors.push(err);
      }
    }
    this.driverMap.clear();
    this.listeners.clear();
    if (errors.length > 0) {
      throw new AiBddError('INTERNAL', `engine close failed: ${errors.map(errorMessage).join('; ')}`, { cause: errors[0] });
    }
  }
}
