import type {
  ChatModel, EvidenceStore, JsonObject, JsonValue, ModelRequest, ModelResponse, ObservedNode, Observation, Redactor,
  ResolvedConfig, ArtifactKind, ArtifactRef,
} from '../../src/contracts/index.ts';
import { renderTree, sha256Hex, treeHash } from '../../src/util/index.ts';

export interface NodeSpec {
  role: string;
  name: string;
  text?: string;
  value?: string;
  testId?: string;
  states?: ObservedNode['states'];
  url?: string;
  children?: NodeSpec[];
}

/** Build a flat, ordered node list with refs, depth and parentRef from a nested spec. */
export function buildNodes(specs: readonly NodeSpec[]): ObservedNode[] {
  const out: ObservedNode[] = [];
  let counter = 0;
  const walk = (list: readonly NodeSpec[], depth: number, parentRef: string | undefined): void => {
    for (const s of list) {
      counter += 1;
      const ref = `e${counter}`;
      const node: ObservedNode = { ref, role: s.role, name: s.name, states: s.states ?? {}, depth };
      if (s.text !== undefined) node.text = s.text;
      if (s.value !== undefined) node.value = s.value;
      if (s.testId !== undefined) node.testId = s.testId;
      if (s.url !== undefined) node.url = s.url;
      if (parentRef !== undefined) node.parentRef = parentRef;
      out.push(node);
      if (s.children) walk(s.children, depth + 1, ref);
    }
  };
  walk(specs, 0, undefined);
  return out;
}

export function makeObs(nodes: readonly NodeSpec[] | ObservedNode[], route = '/', extra: Partial<Observation> = {}): Observation {
  const flat: ObservedNode[] = nodes.length > 0 && 'ref' in (nodes[0] as object) ? (nodes as ObservedNode[]) : buildNodes(nodes as NodeSpec[]);
  return {
    revision: 1, route, nodes: flat, busy: false, tainted: false,
    treeText: renderTree(flat, { refs: true }), treeHash: treeHash(flat), ...extra,
  };
}

export function leaf(role: string, name: string, extra: Partial<NodeSpec> = {}): NodeSpec {
  return { role, name, ...extra };
}

export const CONFIG = {
  checks: { maxAttempts: 3, maxPredicates: 8, requireDeterministic: false },
} as unknown as ResolvedConfig;

export function configWith(checks: Partial<ResolvedConfig['checks']>): ResolvedConfig {
  return { checks: { ...CONFIG.checks, ...checks } } as unknown as ResolvedConfig;
}

/** Redactor double: replaces each secret value by `[REDACTED:name]`. */
export function fakeRedactor(secrets: Record<string, string> = {}): Redactor {
  const redact = (text: string): string => {
    let out = text;
    for (const [name, value] of Object.entries(secrets)) out = out.split(value).join(`[REDACTED:${name}]`);
    return out;
  };
  const redactJson = <T extends JsonValue>(value: T): T => JSON.parse(redact(JSON.stringify(value))) as T;
  return { redact, redactJson, secretNames: Object.keys(secrets) };
}

export type ScriptStep = JsonValue | Error | ((req: ModelRequest) => JsonValue | Error);

export interface ScriptedModel extends ChatModel {
  requests: ModelRequest[];
}

/** ChatModel double returning scripted structured outputs in order (the last one repeats). */
export function scriptedModel(steps: ScriptStep[], opts: { id?: string; asText?: boolean } = {}): ScriptedModel {
  const requests: ModelRequest[] = [];
  const model: ScriptedModel = {
    id: opts.id ?? 'fake:checkgen',
    requests,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      requests.push(req);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      const resolved = typeof step === 'function' ? step(req) : step;
      if (resolved instanceof Error) throw resolved;
      const base = { toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop' as const, modelId: opts.id ?? 'fake:checkgen' };
      if (opts.asText) return { ...base, text: JSON.stringify(resolved) };
      return { ...base, object: resolved as JsonValue };
    },
  };
  return model;
}

export interface FakeEvidence extends EvidenceStore {
  artifacts: { kind: ArtifactKind; data: string }[];
}

export function fakeEvidence(): FakeEvidence {
  const artifacts: { kind: ArtifactKind; data: string }[] = [];
  return {
    runId: 'run-test', dir: '/tmp/none', artifacts,
    async putArtifact(kind, data): Promise<ArtifactRef> {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      artifacts.push({ kind, data: text });
      return { sha256: sha256Hex(text), path: `artifacts/${artifacts.length}`, kind, bytes: text.length };
    },
    async record(_entry: JsonObject): Promise<void> {},
    async finalize() { return { runId: 'run-test', artifacts: [], digest: sha256Hex('') }; },
  };
}

/** Natural contract-shaped helpers for building model outputs. */
export const q = (o: { role?: string; name?: string; nameMatch?: 'exact' | 'contains'; testId?: string; within?: { role: string; name: string } }): JsonObject => {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v as JsonValue;
  return out;
};
