import type {
  ChunkKind,
  ChunkRef,
  DocPlan,
  Feature,
  ReviewState,
  RunReport,
  Scenario,
  ScenarioResult,
  ScenarioStatus,
  Step,
  StepKind,
  StepResult,
  StepStatus,
} from '../../../src/contracts/index.ts';
import { sha256Hex } from '../../../src/util/index.ts';

const NO_USAGE = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };

// ───────────────────────── plan builders

export function ref(chunkId: string, quote = 'quoted text', relation: ChunkRef['relation'] = 'source'): ChunkRef {
  return { chunkId, hash: sha256Hex(chunkId), relation, quote };
}

export function step(kind: StepKind, text: string, sources: ChunkRef[] = []): Step {
  return { key: `${kind}:${sha256Hex(text).slice(0, 12)}`, kind, text, grounding: 'quoted', sources, params: {} };
}

export function scenario(featureId: string, slug: string, title: string, review: ReviewState, sources: ChunkRef[], steps: Step[]): Scenario {
  return { id: `${featureId}/${slug}`, featureId, title, tags: [], sources, steps, review, fingerprint: sha256Hex(`${featureId}/${slug}`) };
}

export function feature(docUri: string, sectionId: string, id: string, title: string, sources: ChunkRef[], scenarios: Scenario[]): Feature {
  return { id, docUri, sectionId, title, tags: [], sources, scenarios, review: 'accepted', fingerprint: sha256Hex(id) };
}

export function chunk(id: string, kind: ChunkKind, excerpt: string): DocPlan['chunks'][number] {
  return { id, hash: sha256Hex(id), kind, range, excerpt };
}

// ───────────────────────── docs/billing.md

const B = 'docs/billing.md';
const bUp = `${B}#billing/upgrades`;
const bInv = `${B}#billing/invoices`;
const bPerf = `${B}#billing/performance`;

export const FEATURE_UPGRADE = 'docs-billing--upgrade-plan';
export const FEATURE_INVOICES = 'docs-billing--invoices';
export const FEATURE_LOGIN = 'docs-auth--login';

const upgradeFeature = feature(B, bUp, FEATURE_UPGRADE, 'Upgrade plan', [ref(`${bUp}/p1`)], [
  scenario(FEATURE_UPGRADE, 'upgrade-to-pro', 'Upgrade to Pro', 'accepted', [ref(`${bUp}/p1`)], [
    step('given', 'a signed-in user on the Free plan', [ref(`${bUp}/p1`)]),
    step('when', 'the user clicks "Upgrade to Pro"', [ref(`${bUp}/p1`)]),
    step('then', 'the plan badge reads "Pro"', [ref(`${bUp}/p1`)]),
  ]),
  scenario(FEATURE_UPGRADE, 'receipt-is-shown', 'Upgrade to "Pro" & see <receipt>', 'unreviewed', [ref(`${bUp}/li1`), ref(`${bUp}/li2`)], [
    step('when', 'the user clicks "Upgrade to Pro"', [ref(`${bUp}/li1`)]),
    step('then', 'a receipt is shown', [ref(`${bUp}/li2`)]),
  ]),
  scenario(FEATURE_UPGRADE, 'downgrade-needs-invoice', 'Downgrade with open invoices', 'accepted', [ref(`${bUp}/li3`)], [
    step('given', 'a customer with two unpaid invoices', [ref(`${bUp}/li3`)]),
    step('when', 'the user clicks "Downgrade"', [ref(`${bUp}/li3`)]),
  ]),
]);

const invoiceFeature = feature(B, bInv, FEATURE_INVOICES, 'Invoices', [ref(`${bInv}/p1`)], [
  scenario(FEATURE_INVOICES, 'list-invoices', 'Invoices are listed', 'unreviewed', [ref(`${bInv}/tr1`)], [
    step('when', 'the user opens the invoices page', [ref(`${bInv}/tr1`)]),
    step('then', 'the invoice table lists INV-1', [ref(`${bInv}/tr1`)]),
  ]),
  scenario(FEATURE_INVOICES, 'invoice-looks-good', 'Invoice PDF looks good', 'accepted', [ref(`${bInv}/p1`), ref(`${B}#billing/ghost/p9`)], [
    step('when', 'the user opens an invoice', [ref(`${bInv}/p1`)]),
    step('then', 'the invoice looks professional', [ref(`${bInv}/p1`)]),
  ]),
  scenario(FEATURE_INVOICES, 'rejected-idea', 'Delete every invoice', 'rejected', [ref(`${bInv}/tr1`)], [
    step('when', 'the user deletes all invoices', [ref(`${bInv}/tr1`)]),
  ]),
]);

export const billingPlan: DocPlan = {
  schemaVersion: 1,
  docUri: B,
  docSha256: sha256Hex(B),
  extractor: { modelId: 'fake-extract', promptVersion: 'extract-v1' },
  sections: [
    { id: bUp, hash: sha256Hex(bUp) },
    { id: bInv, hash: sha256Hex(bInv) },
    { id: bPerf, hash: sha256Hex(bPerf) },
  ],
  chunks: [
    chunk(`${bUp}/h`, 'heading', 'Upgrades'),
    chunk(`${bUp}/p1`, 'paragraph', 'Free users can upgrade to the Pro plan from the billing page.'),
    chunk(`${bUp}/li1`, 'listItem', 'Select "Pro" | "Team" from the plan picker, then confirm the upgrade.'),
    chunk(`${bUp}/li2`, 'listItem', 'After upgrading a receipt is shown with the amount charged and the next billing date for the account owner.'),
    chunk(`${bUp}/li3`, 'listItem', 'Downgrading is blocked while invoices are unpaid.'),
    chunk(`${bUp}/li4`, 'listItem', 'Annual plans renew automatically.'),
    chunk(`${bInv}/h`, 'heading', 'Invoices'),
    chunk(`${bInv}/p1`, 'paragraph', 'Invoices are rendered as professional-looking PDFs.'),
    chunk(`${bInv}/tr1`, 'tableRow', 'Invoice: INV-1; Status: paid'),
    chunk(`${bPerf}/h`, 'heading', 'Performance'),
    chunk(`${bPerf}/p1`, 'paragraph', 'The invoice list loads in under 200 ms at p95.'),
  ],
  features: [upgradeFeature, invoiceFeature],
  notTestable: [{ chunkId: `${bPerf}/p1`, reason: 'latency target is not observable through the UI' }],
  rejected: [],
  uncovered: [`${bUp}/li4`],
};

// ───────────────────────── docs/auth.md

const A = 'docs/auth.md';
const aLogin = `${A}#authentication/login`;

const loginFeature = feature(A, aLogin, FEATURE_LOGIN, 'Login', [ref(`${aLogin}/p1`)], [
  scenario(FEATURE_LOGIN, 'login-with-password', 'Log in with a password', 'accepted', [ref(`${aLogin}/p1`)], [
    step('when', 'the user fills the password <secret:adminPassword>', [ref(`${aLogin}/p1`)]),
    step('then', 'the dashboard heading is visible', [ref(`${aLogin}/p1`)]),
  ]),
  scenario(FEATURE_LOGIN, 'session-expires', 'Session expires', 'accepted', [ref(`${aLogin}/p2`)], [
    step('when', 'the user waits for the session to expire', [ref(`${aLogin}/p2`)]),
    step('then', 'the login form is shown again', [ref(`${aLogin}/p2`)]),
  ]),
  scenario(FEATURE_LOGIN, 'remember-me', 'Remember me', 'accepted', [ref(`${aLogin}/p3`)], [
    step('when', 'the user ticks "Remember me"', [ref(`${aLogin}/p3`)]),
  ]),
]);

export const authPlan: DocPlan = {
  schemaVersion: 1,
  docUri: A,
  docSha256: sha256Hex(A),
  extractor: { modelId: 'fake-extract', promptVersion: 'extract-v1' },
  sections: [{ id: aLogin, hash: sha256Hex(aLogin) }],
  chunks: [
    chunk(`${aLogin}/h`, 'heading', 'Login'),
    chunk(`${aLogin}/p1`, 'paragraph', 'Users sign in with their password and land on the dashboard.'),
    chunk(`${aLogin}/p2`, 'paragraph', 'Sessions expire after 30 minutes of inactivity.'),
    chunk(`${aLogin}/p3`, 'paragraph', 'A remember-me checkbox keeps the user signed in.'),
  ],
  features: [loginFeature],
  notTestable: [],
  rejected: [],
  uncovered: [],
};

export const fixturePlans: DocPlan[] = [billingPlan, authPlan];

// ───────────────────────── report builders

export function stepResult(kind: StepKind, text: string, status: StepStatus, over: Partial<StepResult> = {}): StepResult {
  const deterministic = status === 'passed' || status === 'healed';
  return {
    stepKey: `${kind}:${sha256Hex(text).slice(0, 12)}`,
    kind,
    text,
    status,
    path: status === 'skipped' ? 'none' : kind === 'then' ? 'check' : 'replay',
    determinism: status === 'skipped' ? 'n/a' : deterministic ? 'deterministic' : 'fuzzy',
    fuzzyReasons: [],
    actions: 0,
    usage: NO_USAGE,
    durationMs: 10,
    evidence: [],
    sources: [],
    ...over,
  };
}

export function scenarioResult(
  scenarioId: string,
  featureId: string,
  docUri: string,
  title: string,
  status: ScenarioStatus,
  review: ReviewState,
  steps: StepResult[],
  over: Partial<ScenarioResult> = {},
): ScenarioResult {
  return {
    scenarioId,
    featureId,
    docUri,
    title,
    driver: 'fake',
    status,
    mode: 'replay',
    review,
    steps,
    recording: 'unchanged',
    usage: NO_USAGE,
    durationMs: 1250,
    ...over,
  };
}

const STUB = [
  "import type { FixtureDefinition } from '@ai-bdd/sdk';",
  '',
  'export const aCustomerWithTwoUnpaidInvoices: FixtureDefinition = {',
  "  name: 'aCustomerWithTwoUnpaidInvoices',",
  "  description: 'a customer with two unpaid invoices',",
  '  params: {},',
  '  async run() { /* create the state */ },',
  '};',
].join('\n');

const up = (slug: string): string => `${FEATURE_UPGRADE}/${slug}`;
const inv = (slug: string): string => `${FEATURE_INVOICES}/${slug}`;
const login = (slug: string): string => `${FEATURE_LOGIN}/${slug}`;

export const fixtureReport: RunReport = {
  schemaVersion: 1,
  runId: '01900000-0000-7000-8000-000000000001',
  startedAt: '2026-10-09T10:00:00.000Z',
  finishedAt: '2026-10-09T10:00:42.500Z',
  options: { frozen: true, strict: false, audit: false, noAgent: false, updateRecordings: false, recordingsMode: 'read-only', workers: 4 },
  scenarios: [
    scenarioResult(up('upgrade-to-pro'), FEATURE_UPGRADE, B, 'Upgrade to Pro', 'passed', 'accepted', [
      stepResult('given', 'a signed-in user on the Free plan', 'passed', { path: 'fixture' }),
      stepResult('when', 'the user clicks "Upgrade to Pro"', 'passed'),
      stepResult('then', 'the plan badge reads "Pro"', 'passed'),
    ]),
    scenarioResult(
      up('receipt-is-shown'),
      FEATURE_UPGRADE,
      B,
      'Upgrade to "Pro" & see <receipt>',
      'healed',
      'unreviewed',
      [
        stepResult('when', 'the user clicks "Upgrade to Pro"', 'healed', { path: 'heal', actions: 2, usage: { modelCalls: 2, inputTokens: 900, outputTokens: 80 } }),
        stepResult('then', 'a receipt is shown', 'passed'),
      ],
      { mode: 'mixed', recording: 'none', durationMs: 4800 },
    ),
    scenarioResult(
      up('downgrade-needs-invoice'),
      FEATURE_UPGRADE,
      B,
      'Downgrade with open invoices',
      'blocked',
      'accepted',
      [
        stepResult('given', 'a customer with two unpaid invoices', 'blocked', {
          path: 'none',
          determinism: 'n/a',
          error: {
            code: 'FIXTURE_REQUIRED',
            message: 'Step needs state the UI cannot create; register a fixture.',
            retryable: false,
            details: { stub: STUB },
          },
        }),
        stepResult('when', 'the user clicks "Downgrade"', 'skipped'),
      ],
      { recording: 'none', durationMs: 5 },
    ),
    scenarioResult(
      inv('list-invoices'),
      FEATURE_INVOICES,
      B,
      'Invoices are listed',
      'failed',
      'unreviewed',
      [
        stepResult('when', 'the user opens the invoices page', 'passed', { path: 'agent', determinism: 'fuzzy', fuzzyReasons: ['volatile-content'] }),
        stepResult('then', 'the invoice table lists INV-1', 'failed', {
          path: 'check',
          determinism: 'deterministic',
          error: { code: 'CHECK_FAILED', message: 'row "INV-1" not found | table has 0 rows', retryable: false },
        }),
      ],
      { mode: 'characterize', recording: 'discarded', durationMs: 9100, usage: { modelCalls: 5, inputTokens: 4200, outputTokens: 310 } },
    ),
    scenarioResult(
      inv('invoice-looks-good'),
      FEATURE_INVOICES,
      B,
      'Invoice PDF looks good',
      'inconclusive',
      'accepted',
      [
        stepResult('when', 'the user opens an invoice', 'passed'),
        stepResult('then', 'the invoice looks professional', 'inconclusive', {
          path: 'judge',
          determinism: 'fuzzy',
          fuzzyReasons: ['subjective'],
          error: { code: 'JUDGE_INCONCLUSIVE', message: 'judge score 0.55 is inside the inconclusive band', retryable: false },
        }),
      ],
      { mode: 'mixed', recording: 'none', durationMs: 3300, usage: { modelCalls: 3, inputTokens: 2100, outputTokens: 150 } },
    ),
    scenarioResult(login('login-with-password'), FEATURE_LOGIN, A, 'Log in with a password', 'passed', 'accepted', [
      stepResult('when', 'the user fills the password <secret:adminPassword>', 'passed'),
      stepResult('then', 'the dashboard heading is visible', 'passed'),
    ]),
    scenarioResult(
      login('session-expires'),
      FEATURE_LOGIN,
      A,
      'Session expires',
      'error',
      'accepted',
      [stepResult('when', 'the user waits for the session to expire', 'error', { path: 'agent', determinism: 'fuzzy', error: { code: 'DRIVER_UNAVAILABLE', message: 'browser crashed', retryable: true } }), stepResult('then', 'the login form is shown again', 'skipped')],
      { recording: 'none', error: { code: 'DRIVER_UNAVAILABLE', message: 'browser crashed', retryable: true } },
    ),
    scenarioResult(login('remember-me'), FEATURE_LOGIN, A, 'Remember me', 'skipped', 'accepted', [stepResult('when', 'the user ticks "Remember me"', 'skipped')], {
      recording: 'none',
      durationMs: 0,
    }),
  ],
  totals: { passed: 2, failed: 1, healed: 1, blocked: 1, skipped: 1, inconclusive: 1, error: 1 },
  usage: {
    modelCalls: 12,
    inputTokens: 9200,
    outputTokens: 700,
    byPurpose: {
      extract: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
      act: { modelCalls: 7, inputTokens: 5100, outputTokens: 400 },
      checkgen: { modelCalls: 1, inputTokens: 1000, outputTokens: 100 },
      judge: { modelCalls: 4, inputTokens: 3100, outputTokens: 200 },
    },
    estimatedCostUsd: 0.4217,
  },
  coverage: {
    docs: [
      { docUri: B, chunks: 11, covered: 8, uncovered: [`${bUp}/li4`], notTestable: [`${bPerf}/p1`] },
      { docUri: A, chunks: 4, covered: 3, uncovered: [], notTestable: [] },
      { docUri: 'docs/legacy.md', chunks: 2, covered: 0, uncovered: ['docs/legacy.md#old/p1'], notTestable: [] },
    ],
  },
  warnings: [{ code: 'PLAN_CONTEXT_CHANGED', severity: 'warning', message: 'context chunk changed in docs/billing.md', uri: B }],
  exitCode: 3,
};
