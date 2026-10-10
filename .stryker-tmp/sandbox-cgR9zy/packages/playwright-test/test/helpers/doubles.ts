// @ts-nocheck
import type {
  DocPlan,
  Engine,
  Feature,
  ResolvedConfig,
  Scenario,
  ScenarioResult,
  ScenarioRunOptions,
  StepResult,
} from '@ai-bdd/sdk/contracts';
import type { TestFixturesLike, TestInfoLike, TestLike } from '../../src/types.ts';

// ───────────────────────── a recording stand-in for Playwright's `test`

export interface RecordedTest {
  path: string[];
  title: string;
  fullTitle: string;
  details: { tag?: string[] };
  body: (fixtures: TestFixturesLike, testInfo: TestInfoLike) => Promise<void>;
}

export interface RecordingTest {
  test: TestLike;
  tests: RecordedTest[];
  describes: string[];
  afterAll: (() => Promise<void>)[];
}

export function recordingTest(opts: { withAfterAll?: boolean } = {}): RecordingTest {
  const stack: string[] = [];
  const rec: RecordingTest = { test: undefined as unknown as TestLike, tests: [], describes: [], afterAll: [] };
  const fn = (title: string, details: { tag?: string[] }, body: RecordedTest['body']): void => {
    rec.tests.push({ path: [...stack], title, fullTitle: [...stack, title].join(' > '), details, body });
  };
  const test = fn as unknown as TestLike;
  test.describe = (title, body) => {
    rec.describes.push(title);
    stack.push(title);
    try {
      body();
    } finally {
      stack.pop();
    }
  };
  if (opts.withAfterAll !== false) test.afterAll = (body) => void rec.afterAll.push(body);
  rec.test = test;
  return rec;
}

export interface FakeTestInfo extends TestInfoLike {
  attachments: { name: string; body: string | Buffer | undefined; contentType: string | undefined }[];
}

export function fakeTestInfo(): FakeTestInfo {
  const info: FakeTestInfo = {
    annotations: [],
    attachments: [],
    attach(name, options) {
      info.attachments.push({ name, body: options.body, contentType: options.contentType });
      return Promise.resolve();
    },
  };
  return info;
}

// ───────────────────────── plan builders

export function scenario(id: string, title: string, over: Partial<Scenario> = {}): Scenario {
  return {
    id,
    featureId: id.split('/')[0] ?? id,
    title,
    tags: [],
    sources: [],
    steps: [],
    review: 'unreviewed',
    fingerprint: 'f'.repeat(64),
    ...over,
  };
}

export function feature(id: string, title: string, scenarios: Scenario[], over: Partial<Feature> = {}): Feature {
  return {
    id,
    docUri: 'docs/billing.md',
    sectionId: 'docs/billing.md#upgrading',
    title,
    tags: [],
    sources: [],
    scenarios,
    review: 'unreviewed',
    fingerprint: 'e'.repeat(64),
    ...over,
  };
}

export function plan(docUri: string, features: Feature[]): DocPlan {
  return {
    schemaVersion: 1,
    docUri,
    docSha256: 'd'.repeat(64),
    extractor: { modelId: 'fake', promptVersion: 'extract-v1' },
    sections: [],
    chunks: [],
    features,
    notTestable: [],
    rejected: [],
    uncovered: [],
  };
}

export function step(over: Partial<StepResult> = {}): StepResult {
  return {
    stepKey: 'given:abc',
    kind: 'given',
    text: 'a customer on the Free plan',
    status: 'passed',
    path: 'replay',
    determinism: 'deterministic',
    fuzzyReasons: [],
    actions: 1,
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: 5,
    evidence: [],
    sources: [],
    ...over,
  };
}

export function result(over: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: 'docs-billing--upgrading/upgrade-to-pro',
    featureId: 'docs-billing--upgrading',
    docUri: 'docs/billing.md',
    title: 'Upgrade to Pro',
    driver: 'playwright',
    status: 'passed',
    mode: 'replay',
    review: 'unreviewed',
    steps: [step()],
    recording: 'unchanged',
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: 10,
    ...over,
  };
}

// ───────────────────────── an engine double

export interface FakeEngine extends Engine {
  runCalls: { id: string; opts: Partial<ScenarioRunOptions> | undefined }[];
  closed: number;
}

export function fakeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    projectRoot: '/proj',
    ci: false,
    docs: [],
    exclude: [],
    planDir: '/proj/.ai-bdd/plans',
    recordingsDir: '/proj/.ai-bdd/recordings',
    runsDir: '/proj/.ai-bdd/runs',
    cacheDir: '/proj/.ai-bdd/cache',
    drivers: {},
    fixtures: [],
    secrets: {},
    context: '',
    extract: { sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 4 },
    characterize: { confirmRuns: 1, probeMs: 500, healThreshold: 2 },
    judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 },
    agent: { maxActions: 20, maxModelCalls: 15, maxWaitMs: 5000 },
    checks: { maxAttempts: 3, maxPredicates: 8, requireDeterministic: false },
    settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: true },
    policy: { allowHosts: ['localhost'], denyVerbs: [] },
    concurrency: { scenarios: 4 },
    recordingsMode: 'read-write',
    reporters: ['json'],
    prices: {},
    ...over,
  };
}

export function fakeEngine(
  run: (id: string, opts: Partial<ScenarioRunOptions> | undefined) => Promise<ScenarioResult>,
  config: ResolvedConfig = fakeConfig(),
): FakeEngine {
  const unused = (): never => {
    throw new Error('not used by the integration');
  };
  const engine: FakeEngine = {
    config,
    runCalls: [],
    closed: 0,
    runScenario(id, opts) {
      engine.runCalls.push({ id, opts });
      return run(id, opts);
    },
    close() {
      engine.closed += 1;
      return Promise.resolve();
    },
    compile: unused,
    status: unused,
    plans: unused,
    listScenarios: unused,
    review: unused,
    run: unused,
    verifyRun: unused,
    prune: unused,
    doctor: unused,
    on: unused,
  };
  return engine;
}
