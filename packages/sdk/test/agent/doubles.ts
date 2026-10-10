import { createHash } from 'node:crypto';
import type {
  ActionOutcome, ArtifactKind, ArtifactRef, ChatModel, DriverAction, DriverCapabilities, DriverSession, EvidenceStore, JsonObject,
  JsonValue, ModelRequest, ModelResponse, NodeStates, Observation, ObservedNode, Redactor, ResolvedConfig, Screenshot, SettleOptions,
  SettleResult, Settler, ToolCall, Verb,
} from '../../src/contracts/index.ts';
import { renderTree, sha256Hex, treeHash } from '../../src/util/index.ts';

/** Shared ordered event log so tests can assert cross-double ordering. */
export type Ev = { t: 'artifact'; kind: ArtifactKind; data: string } | { t: 'perform'; action: DriverAction } | { t: 'model'; turn: number };

// ───────────────────────── observation builder
export interface NodeSpec {
  role: string;
  name?: string;
  ref?: string;
  value?: string;
  states?: NodeStates;
  children?: NodeSpec[];
}

export function buildObservation(
  specs: NodeSpec[],
  opts: { route?: string; tainted?: boolean; screenshot?: Screenshot; revision?: number; busy?: boolean } = {},
): Observation {
  const nodes: ObservedNode[] = [];
  let counter = 0;
  const walk = (spec: NodeSpec, depth: number, parentRef: string | undefined): void => {
    counter += 1;
    const ref = spec.ref ?? `e${counter}`;
    const node: ObservedNode = { ref, role: spec.role, name: spec.name ?? '', states: spec.states ?? {}, depth };
    if (spec.value !== undefined) node.value = spec.value;
    if (parentRef !== undefined) node.parentRef = parentRef;
    nodes.push(node);
    for (const c of spec.children ?? []) walk(c, depth + 1, ref);
  };
  for (const s of specs) walk(s, 0, undefined);
  const obs: Observation = {
    revision: opts.revision ?? 1, route: opts.route ?? '/', nodes, busy: opts.busy ?? false, tainted: opts.tainted ?? false,
    treeText: renderTree(nodes, { refs: true }), treeHash: treeHash(nodes),
  };
  if (opts.screenshot !== undefined) obs.screenshot = opts.screenshot;
  return obs;
}

export function shot(masked: boolean, tag = 'a'): Screenshot {
  const png = new Uint8Array([137, 80, 78, 71, tag.charCodeAt(0)]);
  return { png, sha256: sha256Hex(png), masked };
}

// ───────────────────────── session
export interface FakeSession extends DriverSession {
  performed: DriverAction[];
  observations: Observation[];
}

export function makeSession(opts: {
  obs: Observation | (() => Observation);
  log?: Ev[];
  caps?: Partial<DriverCapabilities>;
  onPerform?: (action: DriverAction) => ActionOutcome | void;
}): FakeSession {
  const caps: DriverCapabilities = {
    verbs: ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'] satisfies Verb[],
    pixels: true, maskingProven: false, request: false, maxSessions: 1, ...opts.caps,
  };
  const session: FakeSession = {
    id: 's1', driverId: 'fake', driverVersion: '1.0.0', capabilities: caps, performed: [], observations: [],
    observe: async () => {
      const o = typeof opts.obs === 'function' ? opts.obs() : opts.obs;
      session.observations.push(o);
      return o;
    },
    perform: async (action) => {
      opts.log?.push({ t: 'perform', action });
      session.performed.push(action);
      return opts.onPerform?.(action) ?? { ok: true };
    },
    close: async () => {},
  };
  return session;
}

// ───────────────────────── settler
export interface SettlerDouble extends Settler {
  calls: { pixels: boolean | undefined }[];
}

export function makeSettler(): SettlerDouble {
  const calls: { pixels: boolean | undefined }[] = [];
  return {
    calls,
    settle: async (session: DriverSession, _opts: SettleOptions, extra?: { pixels?: boolean }): Promise<SettleResult> => {
      calls.push({ pixels: extra?.pixels });
      const observation = await session.observe({ pixels: extra?.pixels === true });
      return { settled: true, observation, polls: 1 };
    },
  };
}

// ───────────────────────── redactor
export function makeRedactor(secrets: Record<string, string> = {}): Redactor {
  const entries = Object.entries(secrets);
  const redact = (text: string): string => entries.reduce((acc, [name, value]) => acc.split(value).join(`[REDACTED:${name}]`), text);
  const redactJson = <T extends JsonValue>(value: T): T => JSON.parse(redact(JSON.stringify(value))) as T;
  return { redact, redactJson, secretNames: entries.map(([n]) => n) };
}

// ───────────────────────── evidence
export interface EvidenceDouble extends EvidenceStore {
  artifacts: { kind: ArtifactKind; data: string }[];
}

export function makeEvidence(log?: Ev[]): EvidenceDouble {
  const artifacts: { kind: ArtifactKind; data: string }[] = [];
  return {
    runId: 'run-1', dir: '/tmp/none', artifacts,
    putArtifact: async (kind, data): Promise<ArtifactRef> => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      artifacts.push({ kind, data: text });
      log?.push({ t: 'artifact', kind, data: text });
      return { sha256: createHash('sha256').update(text).digest('hex'), path: `artifacts/${artifacts.length}-${kind}`, kind, bytes: text.length };
    },
    record: async () => {},
    finalize: async () => ({ runId: 'run-1', artifacts: [], digest: '0'.repeat(64) }),
  };
}

// ───────────────────────── scripted model
export type TurnScript = ToolCall[] | ((req: ModelRequest, turn: number) => ToolCall[]);

export interface ScriptedModel extends ChatModel {
  requests: ModelRequest[];
}

export function call(name: string, args: JsonObject = {}, id?: string): ToolCall {
  return { id: id ?? `${name}-${Math.random().toString(36).slice(2, 8)}`, name, args };
}

/** Plays one script entry per model call; past the end it repeats `fallback` (default: complete_step done). */
export function scriptedModel(script: TurnScript[], opts: { log?: Ev[]; fallback?: TurnScript } = {}): ScriptedModel {
  const requests: ModelRequest[] = [];
  return {
    id: 'scripted',
    requests,
    generate: async (req): Promise<ModelResponse> => {
      const turn = requests.length;
      requests.push(req);
      opts.log?.push({ t: 'model', turn });
      const entry = script[turn] ?? opts.fallback ?? [call('complete_step', { status: 'done', summary: 'done' })];
      const toolCalls = typeof entry === 'function' ? entry(req, turn) : entry;
      return { toolCalls, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: toolCalls.length === 0 ? 'stop' : 'tool-calls', modelId: 'scripted' };
    },
  };
}

// ───────────────────────── config
export function makeConfig(over: Partial<Pick<ResolvedConfig, 'agent' | 'policy' | 'baseURL'>> = {}): ResolvedConfig {
  return {
    projectRoot: '/tmp/project', ci: false, docs: [], exclude: [], planDir: '', recordingsDir: '', runsDir: '', cacheDir: '',
    baseURL: 'http://localhost:3000',
    drivers: {}, fixtures: [], secrets: {}, context: '',
    extract: { sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 4 },
    characterize: { confirmRuns: 1, probeMs: 500, healThreshold: 2 },
    judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 },
    agent: { maxActions: 20, maxModelCalls: 15, maxWaitMs: 5000 },
    checks: { maxAttempts: 3, maxPredicates: 8, requireDeterministic: false },
    settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: true },
    policy: { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] },
    concurrency: { scenarios: 4 }, recordingsMode: 'read-write', reporters: [], prices: {},
    ...over,
  };
}
