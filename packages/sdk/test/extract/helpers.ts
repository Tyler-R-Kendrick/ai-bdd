import type {
  ArtifactKind,
  ArtifactRef,
  Chunk,
  ChatModel,
  ChunkKind,
  ChunkedDoc,
  EvidenceStore,
  ExtractionInput,
  FixtureDescriptor,
  JsonObject,
  JsonValue,
  ModelRequest,
  ModelResponse,
  Redactor,
  ResolvedConfig,
  Section,
} from '../../src/contracts/index.ts';
import { sha256Hex } from '../../src/util/index.ts';
import type { Extraction } from '../../src/extract/schema.ts';

export const DOC_URI = 'docs/billing.md';
export const SECTION_ID = `${DOC_URI}#billing`;

const range = (line: number) => ({ startLine: line, startColumn: 1, endLine: line, endColumn: 80 });

export function chunk(anchor: string, kind: ChunkKind, text: string, line: number, sectionId = SECTION_ID): Chunk {
  return {
    id: `${DOC_URI}#${anchor}`,
    docUri: DOC_URI,
    anchor,
    kind,
    headingPath: ['Billing'],
    sectionId,
    text,
    hash: sha256Hex(text),
    range: range(line),
    directives: {},
  };
}

export const TEXT = {
  heading: 'Billing',
  upgrade: 'Customers can upgrade from the Free plan to the Pro plan from the billing page.',
  downgrade: 'Downgrading to Free shows a confirmation dialog before the change applies.',
  perf: 'The page must respond within 200 ms at the 95th percentile.',
  curly: 'The dialog says “you’ll lose Pro features” — and a refund note…',
  short: 'Pro shown',
  invoices: 'A customer with two unpaid invoices sees a payment overdue alert.',
  login: 'The admin signs in with the adminPassword to manage billing.',
  context: 'Glossary: Pro plan means the paid tier of the product.',
} as const;

/** Handles in the fixture request: c1 = context, c2.. = section chunks in this order. */
export const H = {
  context: 'c1',
  heading: 'c2',
  upgrade: 'c3',
  downgrade: 'c4',
  perf: 'c5',
  curly: 'c6',
  short: 'c7',
  invoices: 'c8',
  login: 'c9',
} as const;

export function makeDoc(overrides: { contextText?: string; extraContext?: Chunk[] } = {}): { doc: ChunkedDoc; section: Section; chunks: Record<keyof typeof H, Chunk> } {
  const ctxChunk = chunk('_preamble/p1', 'paragraph', overrides.contextText ?? TEXT.context, 1, `${DOC_URI}#_preamble`);
  const chunks = {
    context: ctxChunk,
    heading: chunk('billing/h', 'heading', TEXT.heading, 3),
    upgrade: chunk('billing/p1', 'paragraph', TEXT.upgrade, 5),
    downgrade: chunk('billing/li1', 'listItem', TEXT.downgrade, 7),
    perf: chunk('billing/li2', 'listItem', TEXT.perf, 8),
    curly: chunk('billing/p2', 'paragraph', TEXT.curly, 10),
    short: chunk('billing/p3', 'paragraph', TEXT.short, 12),
    invoices: chunk('billing/p4', 'paragraph', TEXT.invoices, 14),
    login: chunk('billing/p5', 'paragraph', TEXT.login, 16),
  };
  const sectionChunks = [chunks.heading, chunks.upgrade, chunks.downgrade, chunks.perf, chunks.curly, chunks.short, chunks.invoices, chunks.login];
  const section: Section = {
    id: SECTION_ID,
    docUri: DOC_URI,
    anchor: 'billing',
    title: 'Billing',
    level: 1,
    chunkIds: sectionChunks.map((c) => c.id),
    hash: sha256Hex(sectionChunks.map((c) => c.hash).join('\n')),
    range: { startLine: 3, startColumn: 1, endLine: 16, endColumn: 80 },
  };
  const extra = overrides.extraContext ?? [];
  const doc: ChunkedDoc = {
    doc: { uri: DOC_URI, sha256: sha256Hex('doc'), title: 'Billing Guide' },
    chunks: [ctxChunk, ...extra, ...sectionChunks],
    sections: [section],
    contextChunkIds: [ctxChunk.id, ...extra.map((c) => c.id)],
    diagnostics: [],
  };
  return { doc, section, chunks };
}

export const FIXTURES: FixtureDescriptor[] = [
  {
    name: 'seedAccount',
    description: 'Creates an account on a plan with a number of unpaid invoices',
    params: {
      plan: { type: 'string', enum: ['free', 'pro'] },
      unpaid: { type: 'number', optional: true },
      trial: { type: 'boolean', optional: true },
      note: { type: 'string', optional: true, derived: true },
    },
  },
];

export function makeInput(overrides: Partial<ExtractionInput> & { contextText?: string } = {}): ExtractionInput {
  const { doc, section } = makeDoc(overrides.contextText === undefined ? {} : { contextText: overrides.contextText });
  return {
    doc,
    section,
    fixtures: FIXTURES,
    secretNames: ['adminPassword'],
    previousTitles: [],
    rejected: [],
    ...overrides,
  };
}

export function makeConfig(minQuoteChars = 12): ResolvedConfig {
  return {
    projectRoot: '/project',
    ci: false,
    docs: ['docs/**/*.md'],
    exclude: [],
    planDir: '/project/.ai-bdd/plans',
    recordingsDir: '/project/.ai-bdd/recordings',
    runsDir: '/project/.ai-bdd/runs',
    cacheDir: '/project/.ai-bdd/cache',
    drivers: {},
    fixtures: [],
    secrets: {},
    context: '',
    extract: { sectionDepth: 2, maxSectionChars: 12000, minQuoteChars, concurrency: 4 },
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
  };
}

/** A redactor that replaces the given secret values with `[REDACTED:name]`. */
export function makeRedactor(secrets: Record<string, string> = {}): Redactor {
  const entries = Object.entries(secrets);
  const redact = (text: string): string => entries.reduce((acc, [name, value]) => acc.split(value).join(`[REDACTED:${name}]`), text);
  const redactJson = <T extends JsonValue>(value: T): T => JSON.parse(redact(JSON.stringify(value))) as T;
  return { redact, redactJson, secretNames: entries.map(([n]) => n) };
}

export type Script = (Extraction | JsonValue | Error | ((req: ModelRequest) => ModelResponse | Extraction | JsonValue))[];

export interface StubModel extends ChatModel {
  readonly requests: ModelRequest[];
}

/** Stub ChatModel returning scripted JSON objects (or throwing scripted errors) in order; the last entry repeats. */
export function stubModel(script: Script, opts: { id?: string; usage?: { inputTokens: number; outputTokens: number } } = {}): StubModel {
  const requests: ModelRequest[] = [];
  const usage = opts.usage ?? { inputTokens: 100, outputTokens: 50 };
  return {
    id: opts.id ?? 'stub-model',
    requests,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      requests.push(structuredClone(req));
      const entry = script[Math.min(requests.length - 1, script.length - 1)];
      if (entry instanceof Error) throw entry;
      const value = typeof entry === 'function' ? entry(req) : entry;
      if (value !== null && typeof value === 'object' && 'finishReason' in value && 'modelId' in value) return value as ModelResponse;
      return { object: value as JsonValue, toolCalls: [], usage, finishReason: 'stop', modelId: opts.id ?? 'stub-model' };
    },
  };
}

export interface MemoryEvidence extends EvidenceStore {
  readonly artifacts: { kind: ArtifactKind; data: string }[];
}

export function memoryEvidence(): MemoryEvidence {
  const artifacts: { kind: ArtifactKind; data: string }[] = [];
  return {
    runId: 'run-test',
    dir: '/tmp/run-test',
    artifacts,
    async putArtifact(kind, data): Promise<ArtifactRef> {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      artifacts.push({ kind, data: text });
      return { sha256: sha256Hex(text), path: `artifacts/${artifacts.length}`, kind, bytes: text.length };
    },
    async record(_entry: JsonObject): Promise<void> {},
    async finalize() {
      return { runId: 'run-test', artifacts: [], digest: sha256Hex('x') };
    },
  };
}

// ───────────────────────── builders for extraction outputs

type Ref = Extraction['features'][number]['sources'][number];
type Step = Extraction['features'][number]['scenarios'][number]['steps'][number];
type Scenario = Extraction['features'][number]['scenarios'][number];
type Feature = Extraction['features'][number];

export function ref(handle: string, quote: string | null, relation: 'source' | 'context' = 'source'): Ref {
  return { handle, relation, quote };
}

export function step(kind: Step['kind'], text: string, over: Partial<Step> = {}): Step {
  return { kind, text, grounding: 'inferred', sources: [], nature: null, requiresState: null, fixture: null, params: [], ...over };
}

export const UPGRADE_QUOTE = 'upgrade from the Free plan to the Pro plan';
export const DOWNGRADE_QUOTE = 'Downgrading to Free shows a confirmation dialog';

export function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    title: 'Upgrade to Pro',
    tags: [],
    sources: [ref(H.upgrade, UPGRADE_QUOTE)],
    steps: [
      step('given', 'the customer is on the Free plan'),
      step('when', 'the customer clicks the Upgrade to Pro button'),
      step('then', 'the plan badge shows Pro'),
    ],
    ...over,
  };
}

export function feature(over: Partial<Feature> = {}): Feature {
  return {
    title: 'Plan upgrades',
    story: null,
    description: null,
    tags: [],
    sources: [ref(H.upgrade, UPGRADE_QUOTE)],
    scenarios: [scenario()],
    ...over,
  };
}

export function extraction(features: Feature[] = [feature()], notTestable: Extraction['notTestable'] = []): Extraction {
  return { features, notTestable };
}
