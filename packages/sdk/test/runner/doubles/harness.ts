import type {
  DocPlan,
  DriverFactory,
  Feature,
  FixtureDefinition,
  FuzzyReason,
  ResolvedConfig,
  RecordingsMode,
  RunEvent,
  RunnerDeps,
  Scenario,
  ScenarioRecording,
  ScenarioResult,
  ScenarioRunOptions,
  ScenarioTarget,
  Step,
  StepKind,
  StepRecording,
} from '../../../src/contracts/index.ts';
import { createRunner } from '../../../src/runner/index.ts';
import { normalizeForQuote, sha256Hex } from '../../../src/util/index.ts';
import {
  FakeClock,
  FakeRedactor,
  FakeSettler,
  MemoryEvidence,
  MemoryRecordingStore,
  ScriptedActor,
  ScriptedAsserter,
  ScriptedJudge,
  ScriptedRecorder,
  actProgramFor,
  existsProgram,
} from './collaborators.ts';
import { FakeDriver, FakeWorld, type FakeDriverOptions, type NodeSpec } from './world.ts';

// ───────────────────────── plan model builders

export function mkStep(kind: StepKind, text: string, extra: Partial<Step> = {}): Step {
  return {
    key: `${kind}:${sha256Hex(normalizeForQuote(text)).slice(0, 12)}`,
    kind,
    text,
    grounding: 'quoted',
    sources: [{ chunkId: 'doc#c1', hash: 'h1', relation: 'source', quote: text }],
    params: {},
    ...extra,
  };
}
export const given = (text: string, extra?: Partial<Step>): Step => mkStep('given', text, extra);
export const when = (text: string, extra?: Partial<Step>): Step => mkStep('when', text, extra);
export const thenStep = (text: string, extra?: Partial<Step>): Step => mkStep('then', text, extra);
export const fixtureStep = (text: string, name: string, args: Record<string, string | number> = {}): Step =>
  given(text, { fixture: { name, args } });

export function mkTarget(steps: Step[], over: Partial<Scenario> = {}): ScenarioTarget {
  const scenario: Scenario = {
    id: 'billing--upgrade/upgrade-to-pro',
    featureId: 'billing--upgrade',
    title: 'Upgrade to Pro',
    tags: [],
    sources: [],
    steps,
    review: 'accepted',
    fingerprint: sha256Hex(steps.map((s) => s.text).join('|')),
    ...over,
  };
  const feature: Feature = {
    id: scenario.featureId,
    docUri: 'billing.md',
    sectionId: 'billing.md#s1',
    title: 'Upgrade',
    tags: [],
    sources: [],
    scenarios: [scenario],
    review: 'accepted',
    fingerprint: 'f',
  };
  const plan: DocPlan = {
    schemaVersion: 1,
    docUri: 'billing.md',
    docSha256: 'd',
    extractor: { modelId: 'fake:extract', promptVersion: 'extract-v1' },
    sections: [],
    chunks: [],
    features: [feature],
    notTestable: [],
    rejected: [],
    uncovered: [],
  };
  return { plan, feature, scenario };
}

// ───────────────────────── recording builders

export function entry(step: Step, over: Partial<StepRecording> = {}): StepRecording {
  const base: StepRecording = {
    stepKey: step.key,
    stepTextHash: sha256Hex(normalizeForQuote(step.text)),
    kind: step.kind,
    determinism: 'deterministic',
    fuzzyReasons: [],
    stats: { healCount: 0 },
  };
  if (step.kind === 'then') base.check = existsProgram('status', step.text);
  else if (!step.fixture && step.requiresState !== true) base.act = actProgramFor(step.text);
  return { ...base, ...over };
}

export function fuzzyEntry(step: Step, reasons: FuzzyReason[]): StepRecording {
  const e = entry(step, { determinism: 'fuzzy', fuzzyReasons: reasons });
  delete e.check;
  return e;
}

export function recordingOf(target: ScenarioTarget, entries: StepRecording[], over: Partial<ScenarioRecording> = {}): ScenarioRecording {
  return {
    schemaVersion: 1,
    scenarioId: target.scenario.id,
    scenarioFingerprint: target.scenario.fingerprint,
    driver: { id: 'fake', major: 1 },
    steps: entries,
    promptVersions: { act: 'act-v1', checkgen: 'checkgen-v1', judge: 'judge-v1' },
    ...over,
  };
}

// ───────────────────────── config

export function makeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const dummyFactory: DriverFactory = { id: 'fake', create: () => Promise.reject(new Error('unused in runner tests')) };
  return {
    projectRoot: '/proj',
    ci: false,
    docs: [],
    exclude: [],
    planDir: '/proj/.ai-bdd/plans',
    recordingsDir: '/proj/.ai-bdd/recordings',
    runsDir: '/proj/.ai-bdd/runs',
    cacheDir: '/proj/.ai-bdd/cache',
    baseURL: 'http://localhost:3000',
    drivers: { fake: dummyFactory },
    defaultDriver: 'fake',
    fixtures: [],
    secrets: {},
    context: 'Acme billing app',
    extract: { sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 4 },
    characterize: { confirmRuns: 1, probeMs: 500, healThreshold: 2 },
    judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 },
    agent: { maxActions: 20, maxModelCalls: 15, maxWaitMs: 5000 },
    checks: { maxAttempts: 3, maxPredicates: 8, requireDeterministic: false },
    settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: true },
    policy: { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] },
    concurrency: { scenarios: 4 },
    recordingsMode: 'read-write',
    reporters: ['json'],
    prices: {},
    ...over,
  };
}

// ───────────────────────── harness

export interface HarnessOptions {
  steps: Step[];
  scenario?: Partial<Scenario>;
  config?: Partial<ResolvedConfig>;
  driver?: FakeDriverOptions;
  secrets?: Record<string, string>;
  fixtures?: FixtureDefinition[];
  recordingsMode?: RecordingsMode;
  /** Page shown to every fresh session. */
  initialPage?: NodeSpec[];
}

export class Harness {
  readonly target: ScenarioTarget;
  readonly config: ResolvedConfig;
  readonly clock = new FakeClock();
  readonly store: MemoryRecordingStore;
  readonly evidence = new MemoryEvidence();
  readonly settler = new FakeSettler();
  readonly recorder = new ScriptedRecorder();
  readonly asserter = new ScriptedAsserter();
  readonly judge = new ScriptedJudge();
  readonly actor: ScriptedActor;
  readonly redactor: FakeRedactor;
  readonly driver: FakeDriver;
  readonly events: RunEvent[] = [];
  readonly deps: RunnerDeps;
  readonly runner;
  private readonly effects = new Map<string, (w: FakeWorld) => void>();
  private initialPage: NodeSpec[];

  constructor(o: HarnessOptions) {
    this.target = mkTarget(o.steps, o.scenario);
    this.initialPage = o.initialPage ?? [{ role: 'heading', name: 'Billing', level: 1 }];
    const mode = o.recordingsMode ?? 'read-write';
    this.store = new MemoryRecordingStore(mode);
    this.config = makeConfig({
      recordingsMode: mode,
      fixtures: o.fixtures ?? [],
      secrets: Object.fromEntries(Object.keys(o.secrets ?? {}).map((k) => [k, { env: `ENV_${k.toUpperCase()}` }])),
      ...o.config,
    });
    this.redactor = new FakeRedactor(o.secrets ?? {});
    this.driver = new FakeDriver({ ...o.driver, makeWorld: () => this.newWorld() });
    this.actor = new ScriptedActor(() => this.newWorld());
    const secrets = o.secrets ?? {};
    this.deps = {
      config: this.config,
      drivers: new Map([['fake', this.driver]]),
      actor: this.actor,
      recorder: this.recorder,
      recordings: this.store,
      asserter: this.asserter,
      judge: this.judge,
      settler: this.settler,
      evidence: this.evidence,
      redactor: this.redactor,
      secretValue: (name) => secrets[name],
      clock: this.clock,
      emit: (e) => {
        this.events.push(e);
      },
    };
    this.runner = createRunner(this.deps);
  }

  private newWorld(): FakeWorld {
    const w = new FakeWorld();
    w.specs = this.initialPage.map((s) => ({ ...s }));
    for (const [k, fn] of this.effects) w.on(k, fn);
    return w;
  }

  /** Register what performing (or replaying) the step with this text does to the page. */
  effect(stepText: string, fn: (w: FakeWorld) => void): this {
    this.effects.set(stepText, fn);
    return this;
  }

  /** Common case: performing `stepText` makes a `status` node appear with `thenText` as its name. */
  effectShows(stepText: string, thenText: string): this {
    return this.effect(stepText, (w) => w.add({ role: 'status', name: thenText }));
  }

  seed(rec: ScenarioRecording): this {
    this.store.seed('fake', rec);
    return this;
  }

  run(over: Partial<ScenarioRunOptions> = {}): Promise<ScenarioResult> {
    return this.runner.runScenario(this.target, { updateRecordings: false, strict: false, noAgent: false, audit: false, ...over });
  }

  eventTypes(): string[] {
    return this.events.map((e) => e.type);
  }

  get saved(): ScenarioRecording | null {
    return this.store.read('fake', this.target.scenario.id);
  }
}

export function createHarness(o: HarnessOptions): Harness {
  return new Harness(o);
}
