import { vi } from 'vitest';
import type {
  CompileResult,
  DocPlan,
  DriverFactory,
  Engine,
  EngineDeps,
  ExitCode,
  ModelSet,
  PlanStatus,
  ResolvedConfig,
  RunReport,
  ScenarioRecording,
  ScenarioStatus,
} from '@ai-bdd/sdk/contracts';
import { main } from '../src/main.ts';
import type { CliDeps } from '../src/types.ts';

export const ZERO_USAGE = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };

export function makeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    projectRoot: '/proj',
    ci: false,
    docs: ['docs/**/*.md'],
    exclude: [],
    planDir: '/proj/.ai-bdd/plans',
    recordingsDir: '/proj/.ai-bdd/recordings',
    runsDir: '/proj/.ai-bdd/runs',
    cacheDir: '/proj/.ai-bdd/cache',
    drivers: {},
    defaultDriver: 'web',
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
    reporters: ['json', 'junit', 'markdown'],
    prices: {},
    ...over,
  };
}

export function emptyTotals(over: Partial<Record<ScenarioStatus, number>> = {}): Record<ScenarioStatus, number> {
  return { passed: 0, failed: 0, healed: 0, blocked: 0, skipped: 0, inconclusive: 0, error: 0, ...over };
}

export function makeReport(over: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    options: { frozen: false, strict: false, audit: false, noAgent: false, updateRecordings: false, recordingsMode: 'read-write', workers: 1 },
    scenarios: [],
    totals: emptyTotals(),
    usage: { ...ZERO_USAGE, byPurpose: { extract: ZERO_USAGE, act: ZERO_USAGE, checkgen: ZERO_USAGE, judge: ZERO_USAGE } },
    coverage: { docs: [] },
    warnings: [],
    exitCode: 0,
    ...over,
  };
}

export function makeCompileResult(over: Partial<CompileResult> = {}): CompileResult {
  return { docs: [], usage: ZERO_USAGE, exitCode: 0, ...over };
}


/** In-memory fake engine; every method is a vi.fn with a benign default. */
export function makeEngine(config: ResolvedConfig, over: Partial<Engine> = {}): Engine {
  const engine: Engine = {
    config,
    compile: vi.fn(async () => makeCompileResult()),
    status: vi.fn(async (): Promise<PlanStatus> => ({ docs: [] })),
    plans: vi.fn(async (): Promise<DocPlan[]> => []),
    listScenarios: vi.fn(async () => []),
    review: vi.fn(async () => undefined),
    runScenario: vi.fn(async () => {
      throw new Error('runScenario is not used by the CLI');
    }),
    run: vi.fn(async () => makeReport()),
    verifyRun: vi.fn(async () => ({ ok: true, problems: [] })),
    prune: vi.fn(async () => ({ removed: [] })),
    doctor: vi.fn(async () => ({ ok: true, checks: [{ name: 'plans', ok: true, detail: 'all fresh' }] })),
    on: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
    ...over,
  };
  return engine;
}

export interface Harness {
  code: ExitCode;
  stdout: string;
  stderr: string;
  engine: Engine;
  config: ResolvedConfig;
  createEngine: ReturnType<typeof vi.fn>;
  loadConfig: ReturnType<typeof vi.fn>;
}

export interface HarnessOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  config?: Partial<ResolvedConfig>;
  engine?: Partial<Engine>;
  deps?: CliDeps;
}

/** Runs `main` against an in-memory engine with captured IO. */
export async function runCli(argv: string[], opts: HarnessOptions = {}): Promise<Harness> {
  let stdout = '';
  let stderr = '';
  const env = opts.env ?? {};
  const config = makeConfig({ ci: env['CI'] === '1' || env['CI'] === 'true', ...(env['CI'] === '1' ? { recordingsMode: 'read-only' as const } : {}), ...opts.config });
  const engine = makeEngine(config, opts.engine);
  const loadConfig = vi.fn(async () => config);
  const createEngine = vi.fn(async (_c: ResolvedConfig, _o?: Partial<EngineDeps>) => engine);
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s) },
      env,
      cwd: opts.cwd ?? '/proj',
    },
    { loadConfig, createEngine, ...opts.deps },
  );
  return { code, stdout, stderr, engine, config, createEngine, loadConfig };
}

// ───────────────────────── plan fixtures

export const DOC_URI = 'docs/billing.md';

export function makePlan(): DocPlan {
  const ref = (n: number, quote: string, relation: 'source' | 'context' = 'source') => ({ chunkId: `${DOC_URI}#billing/p${n}`, hash: 'a'.repeat(64), relation, quote });
  return {
    schemaVersion: 1,
    docUri: DOC_URI,
    docSha256: 'b'.repeat(64),
    extractor: { modelId: 'fake', promptVersion: 'extract-v1' },
    sections: [{ id: `${DOC_URI}#billing`, hash: 'c'.repeat(64) }],
    chunks: [
      { id: `${DOC_URI}#billing/h`, hash: 'd'.repeat(64), kind: 'heading', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 }, excerpt: 'Billing' },
      { id: `${DOC_URI}#billing/p1`, hash: 'a'.repeat(64), kind: 'paragraph', range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 60 }, excerpt: 'A Free user can upgrade to Pro from the billing page.' },
      { id: `${DOC_URI}#billing/p2`, hash: 'a'.repeat(64), kind: 'paragraph', range: { startLine: 5, startColumn: 1, endLine: 6, endColumn: 20 }, excerpt: 'The plan badge then shows "Pro".' },
      { id: `${DOC_URI}#billing/p3`, hash: 'e'.repeat(64), kind: 'paragraph', range: { startLine: 9, startColumn: 1, endLine: 9, endColumn: 30 }, excerpt: 'Pages load within 200ms.' },
    ],
    features: [
      {
        id: 'docs-billing--upgrading',
        docUri: DOC_URI,
        sectionId: `${DOC_URI}#billing`,
        title: 'Upgrading',
        story: { asA: 'free user', iWant: 'to upgrade', soThat: 'I get Pro features' },
        tags: ['billing'],
        sources: [ref(1, 'can upgrade to Pro from the billing page')],
        review: 'unreviewed',
        pinned: true,
        fingerprint: 'f'.repeat(64),
        scenarios: [
          {
            id: 'docs-billing--upgrading/upgrade-to-pro',
            featureId: 'docs-billing--upgrading',
            title: 'Upgrade to Pro',
            tags: ['smoke'],
            sources: [ref(1, 'can upgrade to Pro from the billing page')],
            review: 'accepted',
            fingerprint: '1'.repeat(64),
            steps: [
              { key: 'given:aaaaaaaaaaaa', kind: 'given', text: 'a user on the Free plan', grounding: 'inferred', sources: [], params: {} },
              { key: 'when:bbbbbbbbbbbb', kind: 'when', text: 'the user upgrades to Pro', grounding: 'quoted', sources: [ref(1, 'can upgrade to Pro from the billing page')], params: { plan: 'Pro' } },
              { key: 'then:cccccccccccc', kind: 'then', text: 'the plan badge shows Pro', grounding: 'quoted', sources: [ref(2, 'The plan badge then shows "Pro".'), ref(3, 'Pages load within 200ms.', 'context')], nature: 'subjective', params: {} },
            ],
          },
          {
            id: 'docs-billing--upgrading/upgrade-needs-account',
            featureId: 'docs-billing--upgrading',
            title: 'Upgrade needs an account',
            tags: [],
            sources: [ref(1, 'can upgrade to Pro from the billing page')],
            review: 'unreviewed',
            fingerprint: '2'.repeat(64),
            steps: [
              { key: 'given:dddddddddddd', kind: 'given', text: 'a customer with two unpaid invoices', grounding: 'quoted', sources: [ref(1, 'can upgrade to Pro from the billing page')], requiresState: true, fixture: { name: 'seedAccount', args: { unpaid: 2 } }, params: {} },
              { key: 'then:eeeeeeeeeeee', kind: 'then', text: 'an alert is visible', grounding: 'quoted', sources: [ref(2, 'The plan badge then shows "Pro".')], params: {} },
            ],
          },
        ],
      },
    ],
    notTestable: [{ chunkId: `${DOC_URI}#billing/p3`, reason: 'latency target' }],
    rejected: [],
    uncovered: [`${DOC_URI}#billing/p9`],
  };
}

export function makeRecording(): ScenarioRecording {
  return {
    schemaVersion: 1,
    scenarioId: 'docs-billing--upgrading/upgrade-to-pro',
    scenarioFingerprint: '1'.repeat(64),
    driver: { id: 'web', major: 1 },
    promptVersions: { act: 'act-v1', checkgen: 'checkgen-v1', judge: 'judge-v1' },
    steps: [
      { stepKey: 'given:aaaaaaaaaaaa', stepTextHash: '0'.repeat(64), kind: 'given', determinism: 'deterministic', fuzzyReasons: [], stats: { healCount: 0 } },
      {
        stepKey: 'when:bbbbbbbbbbbb', stepTextHash: '0'.repeat(64), kind: 'when', determinism: 'deterministic', fuzzyReasons: [], stats: { healCount: 1 },
        act: { startRoute: '/billing', startLandmarks: '0'.repeat(64), actions: [{ verb: 'click', target: { role: 'button', name: 'Upgrade', ancestors: [], index: 0, of: 1 } }], effect: { routeBefore: '/billing', routeAfter: '/billing', appeared: [], disappeared: [], changed: [] } },
      },
      { stepKey: 'then:cccccccccccc', stepTextHash: '0'.repeat(64), kind: 'then', determinism: 'fuzzy', fuzzyReasons: ['subjective'], stats: { healCount: 0 } },
    ],
  };
}

export type { DriverFactory, ModelSet };
