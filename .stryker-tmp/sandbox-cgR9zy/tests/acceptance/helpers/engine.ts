// @ts-nocheck
import { createEngine, loadConfig } from '@ai-bdd/sdk';
import type {
  Clock,
  CompileOptions,
  CompileResult,
  DocPlan,
  DriverFactory,
  Engine,
  ModelSet,
  ResolvedConfig,
  RunEvent,
  RunOptions,
  RunReport,
  ScenarioResult,
  ScenarioRunOptions,
} from '@ai-bdd/sdk/contracts';
import { createFakeModels } from '@ai-bdd/testing';
import { virtualClock } from './clock.ts';
import { countByPurpose, type CallRecord } from './calls.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD } from './paths.ts';
import { scenarioId } from './plans.ts';
import { Project, type ConfigOverrides, type RuleLayer } from './project.ts';
import { fakeTarget, type DriverTarget, type PrepareOptions, type PreparedTarget } from './targets.ts';

export interface OpenEngineOptions {
  target?: DriverTarget;
  /** reuse an already prepared target (the caller disposes it) */
  prepared?: PreparedTarget;
  prepare?: PrepareOptions;
  /** rule layers; when given the rule directory is recomposed before the models read it */
  layers?: readonly RuleLayer[];
  overrides?: ConfigOverrides;
  /** environment seen by loadConfig/createEngine; CI is deliberately absent unless a test sets it */
  env?: Record<string, string | undefined>;
  clock?: Clock;
  wrapFactory?: (factory: DriverFactory) => DriverFactory;
  /** append every model call to project.logPath (the `logPath` option of the fake models) */
  log?: boolean;
  /** replace the fake models (e.g. wrapped fakes) */
  models?: (fake: ModelSet) => ModelSet;
}

export interface EngineHandle {
  engine: Engine;
  config: ResolvedConfig;
  project: Project;
  driverId: string;
  prepared: PreparedTarget;
  fake: ModelSet & { calls: unknown[] };
  /** live view of every model call made through this handle's models */
  calls: CallRecord[];
  events: RunEvent[];
  clock: Clock;
  counts(): ReturnType<typeof countByPurpose>;
  callsSince(mark: number): CallRecord[];
  compile(opts?: CompileOptions): Promise<CompileResult>;
  plans(): Promise<DocPlan[]>;
  /** `engine.run` with the harness driver and no implicit compile; `titles` select scenarios by title */
  run(opts?: RunOptions & { titles?: string[] }): Promise<RunReport>;
  /** run one scenario selected by title (or id) */
  runScenario(titleOrId: string, opts?: Partial<ScenarioRunOptions>): Promise<ScenarioResult>;
  close(): Promise<void>;
}

function applyOverrides(config: ResolvedConfig, o: ConfigOverrides, baseURL: string): ResolvedConfig {
  const next: ResolvedConfig = { ...config, baseURL };
  if (o.fixtures === false) next.fixtures = [];
  if (o.extract !== undefined) next.extract = { ...config.extract, ...o.extract };
  if (o.characterize !== undefined) next.characterize = { ...config.characterize, ...o.characterize };
  if (o.judge !== undefined) next.judge = { ...config.judge, ...o.judge };
  if (o.agent !== undefined) next.agent = { ...config.agent, ...o.agent };
  if (o.checks !== undefined) next.checks = { ...config.checks, ...o.checks };
  if (o.settle !== undefined) next.settle = { ...config.settle, ...o.settle };
  if (o.concurrency?.scenarios !== undefined) next.concurrency = { scenarios: o.concurrency.scenarios };
  if (o.policy !== undefined) next.policy = { ...config.policy, ...o.policy };
  if (o.context !== undefined) next.context = o.context;
  return next;
}

let testConfigSeq = 0;

/**
 * Wire loadConfig + createEngine with the Acme fake models and the target's driver. The config is the project's generated test
 * config (`writeTestConfig`, the same file the CLI harness passes as `-c`); the harness hands createEngine its own model set and
 * driver factory explicitly so tests can observe, wrap and replace them.
 */
export async function openEngine(project: Project, opts: OpenEngineOptions = {}): Promise<EngineHandle> {
  const target = opts.target ?? fakeTarget;
  const ownsPrepared = opts.prepared === undefined;
  const prepared = opts.prepared ?? (await target.prepare(opts.prepare));
  if (opts.layers !== undefined) project.setRules(opts.layers);

  const env: Record<string, string | undefined> = { ACME_ADMIN_PASSWORD: opts.prepare?.adminPassword ?? ACME_DEFAULT_ADMIN_PASSWORD, ...opts.env };
  // one file name per engine: an ES module is imported once per file name in this process, and the flags/rules differ per call
  const configPath = project.writeTestConfig({ flags: opts.prepare?.flags ?? [], fileName: `ai-bdd.config.test-${(testConfigSeq += 1)}.mjs` });
  const loaded = await loadConfig({ cwd: project.dir, configPath, env });
  const overrides: ConfigOverrides = { ...prepared.defaults, ...project.options, ...opts.overrides };
  for (const key of ['extract', 'characterize', 'judge', 'agent', 'checks', 'settle', 'policy'] as const) {
    const merged = { ...prepared.defaults[key], ...project.options[key], ...opts.overrides?.[key] };
    if (Object.keys(merged).length > 0) (overrides as Record<string, unknown>)[key] = merged;
  }
  const config = applyOverrides(loaded, overrides, prepared.baseURL);

  const fake = createFakeModels({ rulesDir: project.rulesDir, ...(opts.log === true ? { logPath: project.logPath } : {}) });
  const models = opts.models === undefined ? fake : opts.models(fake);
  const clock = opts.clock ?? (prepared.realTime ? undefined : virtualClock());
  const factory = opts.wrapFactory === undefined ? prepared.factory : opts.wrapFactory(prepared.factory);
  const engine = await createEngine(config, {
    models,
    drivers: { [prepared.driverId]: factory },
    env,
    ...(clock === undefined ? {} : { clock }),
  });
  const events: RunEvent[] = [];
  engine.on((e) => events.push(e));
  const calls = fake.calls as CallRecord[];

  const handle: EngineHandle = {
    engine,
    config,
    project,
    driverId: prepared.driverId,
    prepared,
    fake,
    calls,
    events,
    clock: clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    counts: () => countByPurpose(calls),
    callsSince: (mark) => calls.slice(mark),
    compile: (o) => engine.compile(o),
    plans: () => engine.plans(),
    async run(o = {}) {
      const { titles, ...rest } = o;
      let selectors = rest.selectors;
      if (titles !== undefined) {
        const plans = await engine.plans();
        selectors = titles.map((t) => scenarioId(plans, t));
      }
      return engine.run({ driver: prepared.driverId, compile: false, ...rest, ...(selectors === undefined ? {} : { selectors }) });
    },
    async runScenario(titleOrId, o = {}) {
      const plans = await engine.plans();
      let id = titleOrId;
      try {
        id = scenarioId(plans, titleOrId);
      } catch {
        // already an id
      }
      return engine.runScenario(id, { driver: prepared.driverId, ...o });
    },
    async close() {
      await engine.close();
      if (ownsPrepared) await prepared.dispose();
    },
  };
  return handle;
}

/** Open an engine, run `fn`, always close it. */
export async function withEngine<T>(project: Project, opts: OpenEngineOptions, fn: (h: EngineHandle) => Promise<T>): Promise<T> {
  const h = await openEngine(project, opts);
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/** compile once with a throw-away engine and return the model-call count (the plan stays on disk). */
export async function compileProject(project: Project, opts: OpenEngineOptions = {}): Promise<CompileResult> {
  return withEngine(project, opts, (h) => h.compile());
}

/** Compact, driver-independent summary used to assert identical statuses on fake and Playwright. */
export function statusSummary(r: ScenarioResult): { title: string; status: string; steps: string[] } {
  return { title: r.title, status: r.status, steps: r.steps.map((s) => `${s.kind}:${s.text}=${s.status}${s.error === undefined ? '' : `:${s.error.code}`}`) };
}
