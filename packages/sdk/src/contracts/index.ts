/* FROZEN. Change only via contracts-proposals/ and X-INTEGRATOR. */

// ───────────────────────── primitives
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** 64 lowercase hex chars. */
export type Sha256 = string;
/** 1-based lines and columns; endColumn exclusive. */
export interface SourceRange { startLine: number; startColumn: number; endLine: number; endColumn: number }
export type Severity = 'error' | 'warning' | 'info';
export interface Diagnostic { code: ErrorCode; severity: Severity; message: string; uri?: string; range?: SourceRange; details?: JsonValue }
export interface Usage { modelCalls: number; inputTokens: number; outputTokens: number }
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }

// ───────────────────────── errors
export const ERROR_CODES = [
  'USAGE', 'CONFIG_INVALID', 'CONFIG_NOT_FOUND', 'CONFIG_TS_UNSUPPORTED', 'SECRET_MISSING', 'SECRET_TOO_SHORT',
  'DOC_READ_FAILED', 'DOC_CHUNK_TOO_LARGE', 'DIRECTIVE_INVALID', 'DIRECTIVE_UNKNOWN_KEY',
  'EXTRACT_MODEL_OUTPUT_INVALID', 'EXTRACT_UNGROUNDED', 'EXTRACT_QUOTE_NOT_FOUND', 'EXTRACT_FIXTURE_INVALID', 'EXTRACT_SECTION_FAILED',
  'PLAN_STALE', 'PLAN_CORRUPT', 'PLAN_SCHEMA_UNSUPPORTED', 'PLAN_PINNED_STALE', 'PLAN_CONTEXT_CHANGED', 'SCENARIO_NOT_FOUND',
  'FIXTURE_REQUIRED', 'FIXTURE_FAILED',
  'ACT_BUDGET_EXHAUSTED', 'ACT_BLOCKED', 'ACT_TARGET_AMBIGUOUS', 'ACT_NO_AGENT', 'REPLAY_DIVERGED', 'CHARACTERIZATION_UNSTABLE',
  'CHECK_FAILED', 'CHECK_NOT_DISCRIMINATIVE', 'CHECK_LINT_FAILED', 'CHECK_GENERATION_FAILED', 'CHECK_JUDGE_DISAGREEMENT',
  'JUDGE_FAILED', 'JUDGE_INCONCLUSIVE', 'JUDGE_SAME_AS_ACTOR', 'SCREEN_NOT_SETTLED',
  'DRIVER_UNAVAILABLE', 'DRIVER_ERROR', 'STALE_REF', 'TARGET_NOT_FOUND', 'POLICY_DENIED', 'PIXEL_TAINTED', 'SESSION_LIMIT', 'VERB_UNSUPPORTED',
  'MODEL_UNAVAILABLE', 'MODEL_OUTPUT_INVALID', 'MODEL_NO_RULE',
  'RECORDING_CORRUPT', 'RECORDING_READ_ONLY', 'EVIDENCE_CORRUPT',
  'NOT_IMPLEMENTED', 'INTERNAL', 'ABORTED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['DRIVER_UNAVAILABLE', 'DRIVER_ERROR', 'MODEL_UNAVAILABLE']);
export interface AiBddErrorPayload { code: ErrorCode; message: string; retryable: boolean; details?: JsonValue }

export class AiBddError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: JsonValue | undefined;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: JsonValue; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AiBddError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_CODES.has(code);
    this.details = opts.details;
  }
  toPayload(): AiBddErrorPayload {
    const p: AiBddErrorPayload = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details !== undefined) p.details = this.details;
    return p;
  }
}
export function notImplemented(what: string): never {
  throw new AiBddError('NOT_IMPLEMENTED', `${what} is not implemented`);
}

// ───────────────────────── docs and chunks
export interface SourceDoc { uri: string; absolutePath: string; text: string; sha256: Sha256 }
export type ChunkKind = 'heading' | 'paragraph' | 'listItem' | 'tableRow' | 'code' | 'blockquote';
export interface DocDirectives { ignore?: boolean; context?: boolean; fuzzy?: boolean; driver?: string; start?: string; tags?: string[] }
export interface Chunk {
  id: string; docUri: string; anchor: string; kind: ChunkKind; headingPath: string[]; sectionId: string;
  text: string; hash: Sha256; range: SourceRange; parentId?: string; directives: DocDirectives;
}
export interface Section { id: string; docUri: string; anchor: string; title: string; level: number; chunkIds: string[]; hash: Sha256; range: SourceRange }
export interface ChunkedDoc {
  doc: { uri: string; sha256: Sha256; title: string; frontmatter?: JsonValue };
  chunks: Chunk[]; sections: Section[]; contextChunkIds: string[]; diagnostics: Diagnostic[];
}
export interface ChunkOptions { sectionDepth: number; maxSectionChars: number }
export interface Chunker { chunk(doc: SourceDoc, opts: ChunkOptions): ChunkedDoc }

// ───────────────────────── plan model
export type ChunkRelation = 'source' | 'context';
export interface ChunkRef { chunkId: string; hash: Sha256; relation: ChunkRelation; quote?: string }
export type StepKind = 'given' | 'when' | 'then';
export interface FixtureCall { name: string; args: JsonObject }
export interface Step {
  key: string; kind: StepKind; text: string; grounding: 'quoted' | 'inferred'; sources: ChunkRef[];
  nature?: 'objective' | 'subjective'; requiresState?: boolean; fixture?: FixtureCall; params: Record<string, string>;
}
export type ReviewState = 'unreviewed' | 'accepted' | 'rejected';
export interface Scenario {
  id: string; featureId: string; title: string; tags: string[]; sources: ChunkRef[]; steps: Step[];
  driver?: string; startUrl?: string; review: ReviewState; fingerprint: Sha256;
}
export interface UserStory { asA: string; iWant: string; soThat?: string }
export interface Feature {
  id: string; docUri: string; sectionId: string; title: string; story?: UserStory; description?: string; tags: string[];
  sources: ChunkRef[]; scenarios: Scenario[]; review: ReviewState; pinned?: boolean; fingerprint: Sha256;
}
export interface DocPlan {
  schemaVersion: 1; docUri: string; docSha256: Sha256;
  extractor: { modelId: string; promptVersion: string };
  sections: { id: string; hash: Sha256; failed?: boolean }[];
  chunks: { id: string; hash: Sha256; kind: ChunkKind; range: SourceRange; excerpt: string }[];
  features: Feature[];
  notTestable: { chunkId: string; reason: string }[];
  rejected: { fingerprint: Sha256; title: string }[];
  uncovered: string[];
}
export interface DocStatus {
  docUri: string; state: 'fresh' | 'stale' | 'new' | 'orphaned';
  dirtySections: string[]; staleFeatures: string[]; uncovered: string[]; notTestable: string[]; unreviewedScenarios: string[];
}
export interface PlanStatus { docs: DocStatus[] }

// ───────────────────────── extraction
export interface FixtureParam { type: 'string' | 'number' | 'boolean'; enum?: string[]; description?: string; optional?: boolean; derived?: boolean }
export interface FixtureDescriptor { name: string; description: string; params: Record<string, FixtureParam> }
export interface FixtureContext { session: DriverSession; baseURL?: string; signal: AbortSignal; log(message: string): void }
export interface FixtureDefinition extends FixtureDescriptor {
  run(args: JsonObject, ctx: FixtureContext): Promise<void | (() => Promise<void>)>;
}
export interface DraftRef { chunkId: string; relation: ChunkRelation; quote?: string }
export interface DraftStep {
  kind: StepKind; text: string; grounding: 'quoted' | 'inferred'; sources: DraftRef[];
  nature?: 'objective' | 'subjective'; requiresState?: boolean; fixture?: FixtureCall; params: Record<string, string>;
}
export interface DraftScenario { title: string; tags: string[]; sources: DraftRef[]; steps: DraftStep[] }
export interface DraftFeature { title: string; story?: UserStory; description?: string; tags: string[]; sources: DraftRef[]; scenarios: DraftScenario[] }
export interface ExtractionInput {
  doc: ChunkedDoc; section: Section; fixtures: FixtureDescriptor[]; secretNames: string[];
  previousTitles: string[]; rejected: { fingerprint: Sha256; title: string }[]; signal?: AbortSignal;
}
export interface ExtractionResult {
  sectionId: string; failed: boolean; drafts: DraftFeature[]; notTestable: { chunkId: string; reason: string }[];
  diagnostics: Diagnostic[]; usage: Usage; modelId: string; promptVersion: string;
}
export interface Extractor { extractSection(input: ExtractionInput): Promise<ExtractionResult> }

export interface Planner {
  dirtySections(doc: ChunkedDoc, previous: DocPlan | null, opts: { full: boolean }): string[];
  merge(doc: ChunkedDoc, previous: DocPlan | null, extracted: ReadonlyMap<string, ExtractionResult>, meta: { extractor: { modelId: string; promptVersion: string } }): { plan: DocPlan; diagnostics: Diagnostic[]; added: string[]; updated: string[]; removed: string[] };
  status(docs: readonly ChunkedDoc[], plans: readonly DocPlan[]): PlanStatus;
  review(plan: DocPlan, id: string, action: 'accept' | 'reject' | 'pin' | 'unpin'): DocPlan;
}
export interface PlanStore {
  readonly dir: string;
  load(docUri: string): Promise<DocPlan | null>;
  loadAll(): Promise<DocPlan[]>;
  loadAllSync(): DocPlan[];
  save(plan: DocPlan): Promise<void>;
  remove(docUri: string): Promise<void>;
}

// ───────────────────────── models
export type ModelPurpose = 'extract' | 'act' | 'checkgen' | 'judge';
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; png: Uint8Array; sha256: Sha256 };
export interface ToolCall { id: string; name: string; args: JsonObject }
export type ModelMessage =
  | { role: 'user'; content: ContentPart[] }
  | { role: 'assistant'; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; result: JsonValue };
export interface ToolSpec { name: string; description: string; inputSchema: JsonObject }
export interface ModelRequest {
  purpose: ModelPurpose; system: string; messages: ModelMessage[];
  tools?: ToolSpec[]; toolChoice?: 'auto' | 'required';
  output?: { name: string; schema: JsonObject };
  temperature?: number; seed?: number; maxOutputTokens?: number;
  /** Structured, redacted metadata for fakes, logs and evidence. Never sent to providers. */
  context: JsonObject;
  signal?: AbortSignal;
}
export interface ModelResponse {
  text?: string; object?: JsonValue; toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool-calls' | 'length' | 'error' | 'other'; modelId: string;
}
export interface ChatModel { readonly id: string; generate(req: ModelRequest): Promise<ModelResponse> }
export interface ModelSet { extract: ChatModel; act: ChatModel; checkgen: ChatModel; judge: ChatModel }

// ───────────────────────── drivers
export type Verb = 'navigate' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'hover' | 'scroll' | 'back' | 'wait';
export interface NodeStates {
  checked?: boolean | 'mixed'; disabled?: boolean; expanded?: boolean; selected?: boolean;
  pressed?: boolean | 'mixed'; focused?: boolean; busy?: boolean; invalid?: boolean;
}
export interface ObservedNode {
  ref: string; role: string; name: string; text?: string; value?: string; url?: string; level?: number; testId?: string;
  states: NodeStates; parentRef?: string; depth: number;
}
export interface Screenshot { png: Uint8Array; sha256: Sha256; masked: boolean }
export interface Observation {
  revision: number; route: string; url?: string; title?: string; nodes: ObservedNode[];
  busy: boolean; tainted: boolean; screenshot?: Screenshot; treeText: string; treeHash: Sha256;
}
export interface Selector { role: string; name: string; testId?: string; ancestors: { role: string; name: string }[]; index: number; of: number }
export type ValueSource = { literal: string } | { param: string } | { secret: string };
export type ActionShape<T> =
  | { verb: 'navigate'; url: string }
  | { verb: 'click'; target: T }
  | { verb: 'fill'; target: T; value: ValueSource }
  | { verb: 'press'; key: string; target?: T }
  | { verb: 'select'; target: T; option: ValueSource }
  | { verb: 'check'; target: T; checked: boolean }
  | { verb: 'hover'; target: T }
  | { verb: 'scroll'; direction: 'up' | 'down'; target?: T }
  | { verb: 'back' }
  | { verb: 'wait'; ms: number };
export type DriverAction = ActionShape<{ ref: string }>;
export type RecordedAction = ActionShape<Selector>;
export interface ActionOutcome { ok: boolean; error?: AiBddErrorPayload; navigatedTo?: string }
export interface DriverCapabilities { verbs: Verb[]; pixels: boolean; maskingProven: boolean; request: boolean; maxSessions: number; exclusiveResource?: string }
export interface Policy { allowHosts: string[]; denyVerbs: Verb[] }
export interface SessionOptions { scenarioId: string; baseURL?: string; policy: Policy; resolveValue(v: ValueSource): string; recordVideo?: boolean }
export interface DriverSession {
  readonly id: string; readonly driverId: string; readonly driverVersion: string; readonly capabilities: DriverCapabilities;
  observe(opts?: { pixels?: boolean }): Promise<Observation>;
  perform(action: DriverAction): Promise<ActionOutcome>;
  request?(req: { method: string; path: string; headers?: Record<string, string>; body?: JsonValue }): Promise<{ status: number; body: JsonValue | string }>;
  close(): Promise<void>;
}
export interface Driver {
  readonly id: string; readonly version: string; readonly capabilities: DriverCapabilities;
  openSession(opts: SessionOptions): Promise<DriverSession>;
  selfCheck(): Promise<{ ok: boolean; problems: string[] }>;
  dispose(): Promise<void>;
}
export interface DriverContext { projectRoot: string; baseURL?: string; policy: Policy; artifactsDir: string }
export interface DriverFactory { readonly id: string; create(ctx: DriverContext): Promise<Driver> }

// ───────────────────────── settle, evidence, redaction
export interface SettleOptions { quietMs: number; intervalMs: number; timeoutMs: number }
export interface SettleResult { settled: boolean; observation: Observation; polls: number }
export interface Settler { settle(session: DriverSession, opts: SettleOptions, extra?: { pixels?: boolean; signal?: AbortSignal }): Promise<SettleResult> }
export interface Redactor { redact(text: string): string; redactJson<T extends JsonValue>(value: T): T; readonly secretNames: string[] }
export type ArtifactKind =
  | 'screenshot' | 'observation' | 'act-transcript' | 'action-log' | 'judge-request' | 'judge-response'
  | 'checkgen' | 'extract-request' | 'extract-response' | 'report';
export interface ArtifactRef { sha256: Sha256; path: string; kind: ArtifactKind; bytes: number }
export interface EvidenceStore {
  readonly runId: string; readonly dir: string;
  putArtifact(kind: ArtifactKind, data: Uint8Array | string): Promise<ArtifactRef>;
  record(entry: JsonObject): Promise<void>;
  finalize(): Promise<{ runId: string; artifacts: ArtifactRef[]; digest: Sha256 }>;
}

// ───────────────────────── agent, recording, assertions, judge
export interface PerformedAction { action: DriverAction; target?: ObservedNode; chosenFrom: Observation; outcome: ActionOutcome }
export interface ActRequest {
  scenario: { id: string; title: string }; step: Step; priorSteps: { kind: StepKind; text: string; status: StepStatus }[];
  params: Record<string, string>; hints?: RecordedAction[]; appContext: string; secretNames: string[]; signal?: AbortSignal;
}
export interface ActResult {
  status: 'done' | 'blocked' | 'failed'; error?: AiBddErrorPayload; actions: PerformedAction[]; finalObservation: Observation;
  summary: string; usage: Usage; transcript?: ArtifactRef;
}
export interface Actor { act(req: ActRequest, session: DriverSession): Promise<ActResult> }

export interface NodeKey { role: string; name: string }
export interface EffectSignature {
  routeBefore: string; routeAfter: string; appeared: NodeKey[]; disappeared: NodeKey[];
  changed: { key: NodeKey; state: string; from: JsonValue; to: JsonValue }[];
}
export interface ActProgram { startRoute: string; startLandmarks: Sha256; actions: RecordedAction[]; effect: EffectSignature }
export type FindResult = { status: 'found'; node: ObservedNode } | { status: 'missing' } | { status: 'ambiguous'; count: number };
export type ReplayOutcome = 'replayed' | 'start-mismatch' | 'target-missing' | 'target-ambiguous' | 'effect-unverified' | 'action-failed' | 'policy-denied';
export interface ReplayResult { outcome: ReplayOutcome; completedActions: number; before: Observation; after: Observation; detail?: string }
export type FuzzyReason =
  | 'directive' | 'subjective' | 'volatile-content' | 'check-not-discriminative' | 'check-generation-failed'
  | 'confirm-replay-failed' | 'confirm-check-failed' | 'coordinate-action' | 'no-observable-effect' | 'heal-threshold' | 'agent-only-driver';
export interface Recorder {
  toRecording(performed: readonly PerformedAction[], before: Observation, after: Observation, afterProbe: Observation | undefined, step: Step, opts?: { capabilities?: DriverCapabilities }): { act: ActProgram; fuzzyReasons: FuzzyReason[] };
  replay(act: ActProgram, session: DriverSession, ctx: { baseURL?: string; policy: Policy; signal?: AbortSignal }): Promise<ReplayResult>;
}
export interface NodeQuery { role?: string; name?: string; nameMatch?: 'exact' | 'contains'; testId?: string; within?: NodeKey }
export type TextValue = { literal: string } | { param: string };
export type Predicate =
  | { op: 'exists'; query: NodeQuery; negate?: boolean }
  | { op: 'count'; query: NodeQuery; cmp: 'eq' | 'gte' | 'lte'; value: number }
  | { op: 'text'; query: NodeQuery; match: 'equals' | 'contains'; value: TextValue }
  | { op: 'state'; query: NodeQuery; state: keyof NodeStates; value: boolean }
  | { op: 'route'; match: 'equals' | 'prefix'; value: string };
export interface PredicateResult { predicate: Predicate; satisfied: boolean | 'unknown'; actual?: JsonValue }
export interface CheckProgram {
  classification: 'change' | 'invariant'; predicates: Predicate[];
  generatedBy: { modelId: string; promptVersion: string };
  verified: { afterTrue: boolean; probeTrue: boolean; beforeFalse: boolean | null; judgePassed: boolean };
}
export interface CheckEvaluation { passed: boolean; results: PredicateResult[] }
export interface CheckGenRequest {
  scenarioId: string; stepKey: string; criterion: string; params: Record<string, string>;
  before: Observation; after: Observation; afterProbe: Observation; actionPreceded: boolean; signal?: AbortSignal;
}
export interface CheckGenResult { program?: CheckProgram; fuzzyReasons: FuzzyReason[]; attempts: number; usage: Usage; errors: string[] }
export interface Asserter {
  evaluate(program: CheckProgram, obs: Observation, params: Record<string, string>): CheckEvaluation;
  generate(req: CheckGenRequest): Promise<CheckGenResult>;
}
export interface JudgeEvidence { treeText: string; screenshot?: { png: Uint8Array; sha256: Sha256 } }
/** Deliberately minimal: there is NO field for agent transcripts, tool calls or action summaries (R-JU1). */
export interface JudgeRequest {
  criterion: string; params: Record<string, string>; before: JudgeEvidence; after: JudgeEvidence;
  actionPreceded: boolean; appContext: string;
}
export interface JudgeSample { probability: number; verdict: 'holds' | 'fails' | 'cannot_tell'; explanation: string; observed: string }
export interface JudgeVerdict {
  verdict: 'pass' | 'fail' | 'inconclusive'; score: number; spread: number; samples: JudgeSample[];
  reason?: 'band' | 'spread'; modelId: string; promptVersion: string; cached: boolean; usage: Usage;
}
export interface Judge { judge(req: JudgeRequest, signal?: AbortSignal): Promise<JudgeVerdict> }

// ───────────────────────── recordings
export interface StepRecording {
  stepKey: string; stepTextHash: Sha256; kind: StepKind;
  determinism: 'deterministic' | 'fuzzy'; fuzzyReasons: FuzzyReason[];
  act?: ActProgram; check?: CheckProgram; stats: { healCount: number };
}
export interface ScenarioRecording {
  schemaVersion: 1; scenarioId: string; scenarioFingerprint: Sha256; driver: { id: string; major: number };
  steps: StepRecording[];
  promptVersions: { act: string; checkgen: string; judge: string };
}
export type RecordingsMode = 'read-write' | 'read-only' | 'off';
export interface RecordingStore {
  readonly dir: string; readonly mode: RecordingsMode;
  load(driverId: string, scenarioId: string): Promise<ScenarioRecording | null>;
  /** Returns 'unchanged' when the serialized bytes are identical. Throws RECORDING_READ_ONLY unless read-write. */
  save(rec: ScenarioRecording): Promise<'created' | 'updated' | 'unchanged'>;
  remove(driverId: string, scenarioId: string): Promise<void>;
  list(): Promise<{ driverId: string; scenarioId: string }[]>;
}

// ───────────────────────── results, events
export type StepStatus = 'passed' | 'failed' | 'healed' | 'blocked' | 'skipped' | 'inconclusive' | 'error';
export type ScenarioStatus = StepStatus;
export type StepPath = 'fixture' | 'replay' | 'heal' | 'agent' | 'check' | 'judge' | 'check+judge' | 'none';
export type ScenarioMode = 'characterize' | 'replay' | 'mixed';
export interface StepResult {
  stepKey: string; kind: StepKind; text: string; status: StepStatus; path: StepPath;
  determinism: 'deterministic' | 'fuzzy' | 'n/a'; fuzzyReasons: FuzzyReason[];
  error?: AiBddErrorPayload; check?: CheckEvaluation; judge?: JudgeVerdict;
  actions: number; usage: Usage; durationMs: number; evidence: ArtifactRef[]; sources: ChunkRef[];
}
export interface ScenarioResult {
  scenarioId: string; featureId: string; docUri: string; title: string; driver: string;
  status: ScenarioStatus; mode: ScenarioMode; review: ReviewState; steps: StepResult[];
  recording: 'created' | 'updated' | 'unchanged' | 'discarded' | 'none';
  confirm?: { runs: number; reclassified: string[]; failed: boolean };
  error?: AiBddErrorPayload; usage: Usage; durationMs: number;
}
export type ExitCode = 0 | 1 | 2 | 3 | 4;
export interface RunOptions {
  selectors?: string[]; tags?: string[]; grep?: string; driver?: string;
  frozen?: boolean; compile?: boolean; strict?: boolean; updateRecordings?: boolean; noAgent?: boolean; audit?: boolean;
  workers?: number; reporters?: ReporterName[]; signal?: AbortSignal;
}
export interface RunReport {
  schemaVersion: 1; runId: string; startedAt: string; finishedAt: string;
  options: { frozen: boolean; strict: boolean; audit: boolean; noAgent: boolean; updateRecordings: boolean; recordingsMode: RecordingsMode; workers: number };
  scenarios: ScenarioResult[];
  totals: Record<ScenarioStatus, number>;
  usage: Usage & { byPurpose: Record<ModelPurpose, Usage>; estimatedCostUsd?: number };
  coverage: { docs: { docUri: string; chunks: number; covered: number; uncovered: string[]; notTestable: string[] }[] };
  warnings: Diagnostic[];
  exitCode: ExitCode;
}
export type RunEvent =
  | { type: 'compile-section'; docUri: string; sectionId: string; status: 'extracted' | 'reused' | 'failed' }
  | { type: 'run-start'; runId: string; scenarios: number }
  | { type: 'scenario-start'; scenarioId: string; driver: string; mode: ScenarioMode }
  | { type: 'step-start'; scenarioId: string; stepKey: string; kind: StepKind; text: string }
  | { type: 'step-end'; scenarioId: string; result: StepResult }
  | { type: 'scenario-end'; result: ScenarioResult }
  | { type: 'run-end'; report: RunReport }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; scenarioId?: string };

// ───────────────────────── reporters
export type ReporterName = 'json' | 'junit' | 'markdown';
export interface Reporter { readonly name: ReporterName; render(report: RunReport, ctx: { plans: readonly DocPlan[]; outDir: string }): Promise<{ path: string }[]> }

// ───────────────────────── config
export interface ExtractConfig { sectionDepth: number; maxSectionChars: number; minQuoteChars: number; concurrency: number }
export interface CharacterizeConfig { confirmRuns: number; probeMs: number; healThreshold: number }
export interface JudgeConfig { passThreshold: number; failThreshold: number; samples: number; maxSpread: number; vision: boolean; maxTreeChars: number }
export interface AgentConfig { maxActions: number; maxModelCalls: number; maxWaitMs: number }
export interface ChecksConfig { maxAttempts: number; maxPredicates: number; requireDeterministic: boolean }
export interface UserConfig {
  docs?: string[]; exclude?: string[];
  planDir?: string; recordingsDir?: string; runsDir?: string; cacheDir?: string;
  baseURL?: string;
  drivers?: Record<string, DriverFactory>; defaultDriver?: string;
  models?: ModelSet;
  fixtures?: FixtureDefinition[];
  secrets?: Record<string, { env: string }>;
  context?: string;
  extract?: Partial<ExtractConfig>;
  characterize?: Partial<CharacterizeConfig>;
  judge?: Partial<JudgeConfig>;
  agent?: Partial<AgentConfig>;
  checks?: Partial<ChecksConfig>;
  settle?: Partial<SettleOptions> & { requireSettled?: boolean };
  policy?: Partial<Policy>;
  concurrency?: { scenarios?: number };
  reporters?: ReporterName[];
  prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}
/** Absolute paths; defaults applied; secret VALUES are never stored here (R-SE1). */
export interface ResolvedConfig {
  projectRoot: string; configPath?: string; ci: boolean;
  docs: string[]; exclude: string[];
  planDir: string; recordingsDir: string; runsDir: string; cacheDir: string;
  baseURL?: string;
  drivers: Record<string, DriverFactory>; defaultDriver?: string;
  models?: ModelSet;
  fixtures: FixtureDefinition[];
  secrets: Record<string, { env: string }>;
  context: string;
  extract: ExtractConfig; characterize: CharacterizeConfig; judge: JudgeConfig; agent: AgentConfig; checks: ChecksConfig;
  settle: SettleOptions & { requireSettled: boolean };
  policy: Policy;
  concurrency: { scenarios: number };
  recordingsMode: RecordingsMode;
  reporters: ReporterName[];
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

// ───────────────────────── runner and engine
export interface ScenarioTarget { plan: DocPlan; feature: Feature; scenario: Scenario }
export interface ScenarioRunOptions {
  updateRecordings: boolean; strict: boolean; noAgent: boolean; audit: boolean; driver?: string;
  sessionFactory?: (opts: SessionOptions) => Promise<DriverSession>; signal?: AbortSignal;
}
export interface RunnerDeps {
  config: ResolvedConfig; drivers: ReadonlyMap<string, Driver>;
  actor: Actor; recorder: Recorder; recordings: RecordingStore; asserter: Asserter; judge: Judge;
  settler: Settler; evidence: EvidenceStore; redactor: Redactor; secretValue(name: string): string | undefined;
  clock: Clock; emit(event: RunEvent): void;
}
export interface Runner {
  runScenario(target: ScenarioTarget, opts: ScenarioRunOptions): Promise<ScenarioResult>;
  runAll(targets: readonly ScenarioTarget[], opts: ScenarioRunOptions & { workers: number }): Promise<ScenarioResult[]>;
}
export interface CompileOptions { docs?: string[]; full?: boolean; dryRun?: boolean; check?: boolean; signal?: AbortSignal }
export interface CompileResult {
  docs: { docUri: string; state: DocStatus['state']; extractedSections: string[]; failedSections: string[]; added: string[]; updated: string[]; removed: string[]; diagnostics: Diagnostic[] }[];
  usage: Usage; exitCode: ExitCode;
}
export interface ScenarioFilter { selectors?: string[]; tags?: string[]; grep?: string }
export interface EngineDeps { models: ModelSet; drivers: Record<string, DriverFactory>; clock: Clock; env: Record<string, string | undefined> }
export interface Engine {
  readonly config: ResolvedConfig;
  compile(opts?: CompileOptions): Promise<CompileResult>;
  status(): Promise<PlanStatus>;
  plans(): Promise<DocPlan[]>;
  listScenarios(filter?: ScenarioFilter): Promise<ScenarioTarget[]>;
  review(id: string, action: 'accept' | 'reject' | 'pin' | 'unpin'): Promise<void>;
  runScenario(scenarioId: string, opts?: Partial<ScenarioRunOptions>): Promise<ScenarioResult>;
  run(opts?: RunOptions): Promise<RunReport>;
  verifyRun(runDir: string): Promise<{ ok: boolean; problems: string[] }>;
  prune(opts?: { dryRun?: boolean }): Promise<{ removed: string[] }>;
  doctor(opts?: { offline?: boolean }): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>;
  on(listener: (event: RunEvent) => void): () => void;
  close(): Promise<void>;
}

// ───────────────────────── module factory signatures (implemented by owners, wired by the engine)
export type DiscoverDocs = (config: ResolvedConfig) => Promise<SourceDoc[]>;
export type CreateChunker = () => Chunker;
export type CreateExtractor = (deps: { model: ChatModel; redactor: Redactor; config: ResolvedConfig; evidence?: EvidenceStore }) => Extractor;
export type CreatePlanner = (config: ResolvedConfig) => Planner;
export type CreatePlanStore = (opts: { dir: string; readOnly: boolean }) => PlanStore;
export type LoadPlansSync = (dir: string) => DocPlan[];
export type CreateActor = (deps: { model: ChatModel; redactor: Redactor; settler: Settler; config: ResolvedConfig; evidence?: EvidenceStore }) => Actor;
export type CreateRecorder = (deps: { settler: Settler; config: ResolvedConfig }) => Recorder;
export type CreateRecordingStore = (opts: { dir: string; mode: RecordingsMode }) => RecordingStore;
export type DeriveSelector = (node: ObservedNode, obs: Observation) => Selector;
export type FindBySelector = (selector: Selector, obs: Observation) => FindResult;
export type ComputeEffect = (before: Observation, after: Observation, afterProbe?: Observation) => EffectSignature;
export type CreateAsserter = (deps: { model: ChatModel; redactor: Redactor; config: ResolvedConfig; evidence?: EvidenceStore }) => Asserter;
export type EvaluatePredicates = (predicates: readonly Predicate[], obs: Observation, params: Record<string, string>) => PredicateResult[];
export type LintCheckProgram = (program: CheckProgram, ctx: { stepText: string; params: Record<string, string>; volatileNodeKeys: NodeKey[]; actionPreceded: boolean; maxPredicates: number }) => string[];
export type CreateJudge = (deps: { model: ChatModel; config: ResolvedConfig; cacheDir: string | null; evidence?: EvidenceStore }) => Judge;
export type ToJudgeEvidence = (obs: Observation, opts: { vision: boolean; maxTreeChars: number; maskingProven: boolean; redactor: Redactor }) => JudgeEvidence;
export type CreateEvidenceStore = (opts: { runsDir: string; runId: string; redactor: Redactor }) => Promise<EvidenceStore>;
export type CreateRedactor = (secrets: Record<string, string>) => Redactor;
export type CreateSettler = (opts?: { clock?: Clock }) => Settler;
export type VerifyRun = (runDir: string) => Promise<{ ok: boolean; problems: string[] }>;
export type CreateRunner = (deps: RunnerDeps) => Runner;
export type CreateReporters = (names: readonly ReporterName[]) => Reporter[];
export type DefineConfig = (config: UserConfig) => UserConfig;
export type LoadConfig = (opts: { cwd: string; configPath?: string; env?: Record<string, string | undefined> }) => Promise<ResolvedConfig>;
export type ResolveConfig = (config: UserConfig, opts: { projectRoot: string; configPath?: string; env: Record<string, string | undefined> }) => ResolvedConfig;
export type CreateEngine = (config: ResolvedConfig, overrides?: Partial<EngineDeps>) => Promise<Engine>;
