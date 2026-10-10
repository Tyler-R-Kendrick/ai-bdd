import type {
  ArtifactKind,
  ArtifactRef,
  ChatModel,
  EvidenceStore,
  JsonObject,
  JudgeRequest,
  ModelRequest,
  ModelResponse,
  Observation,
  ObservedNode,
  Redactor,
  ResolvedConfig,
} from '../../src/contracts/index.ts';
import { sha256Hex, treeHash, renderTree } from '../../src/util/index.ts';

export interface SampleSpec { probability: number; verdict: 'holds' | 'fails' | 'cannot_tell'; explanation?: string; observed?: string }

export const holds = (probability = 0.95): SampleSpec => ({ probability, verdict: 'holds' });
export const fails = (probability = 0.05): SampleSpec => ({ probability, verdict: 'fails' });
export const cannotTell = (probability = 0.5): SampleSpec => ({ probability, verdict: 'cannot_tell' });

export type ScriptEntry = SampleSpec | string | ((req: ModelRequest) => ModelResponse);

/** Scripted judge model: sample index (request.seed) selects the entry, so parallel order does not matter. */
export class ScriptedJudgeModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  readonly id: string;
  private readonly script: readonly ScriptEntry[];
  private readonly tokens: { inputTokens: number; outputTokens: number };
  constructor(id: string, script: readonly ScriptEntry[], tokens = { inputTokens: 100, outputTokens: 10 }) {
    this.id = id;
    this.script = script;
    this.tokens = tokens;
  }

  generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const entry = this.script[req.seed ?? 0] ?? this.script[this.script.length - 1];
    if (entry === undefined) throw new Error('empty script');
    if (typeof entry === 'function') return Promise.resolve(entry(req));
    const base = { toolCalls: [], usage: { ...this.tokens }, finishReason: 'stop' as const, modelId: this.id };
    if (typeof entry === 'string') return Promise.resolve({ ...base, text: entry });
    return Promise.resolve({
      ...base,
      object: { probability: entry.probability, verdict: entry.verdict, explanation: entry.explanation ?? 'because', observed: entry.observed ?? 'something' },
    });
  }
}

export function makeConfig(judge: Partial<ResolvedConfig['judge']> = {}): ResolvedConfig {
  return {
    judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000, ...judge },
  } as unknown as ResolvedConfig;
}

export class SecretRedactor implements Redactor {
  readonly secretNames: string[] = ['pw'];
  private readonly secret: string;
  constructor(secret = 'hunter2-secret') {
    this.secret = secret;
  }
  redact(text: string): string {
    return text.split(this.secret).join('<secret:pw>');
  }
  redactJson<T extends import('../../src/contracts/index.ts').JsonValue>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }
}

export class MemoryEvidence implements EvidenceStore {
  readonly runId = 'run-test';
  readonly dir = '/dev/null';
  readonly artifacts: { kind: ArtifactKind; data: string }[] = [];
  putArtifact(kind: ArtifactKind, data: Uint8Array | string): Promise<ArtifactRef> {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.artifacts.push({ kind, data: text });
    return Promise.resolve({ sha256: sha256Hex(text), path: `artifacts/${sha256Hex(text)}.json`, kind, bytes: text.length });
  }
  record(_entry: JsonObject): Promise<void> {
    return Promise.resolve();
  }
  finalize(): Promise<{ runId: string; artifacts: ArtifactRef[]; digest: string }> {
    return Promise.resolve({ runId: this.runId, artifacts: [], digest: sha256Hex('') });
  }
}

export function node(partial: Partial<ObservedNode> & Pick<ObservedNode, 'ref' | 'role' | 'name'>): ObservedNode {
  return { states: {}, depth: 0, ...partial };
}

export function makeObservation(nodes: ObservedNode[], extra: Partial<Observation> = {}): Observation {
  return {
    revision: 1,
    route: '/',
    nodes,
    busy: false,
    tainted: false,
    treeText: renderTree(nodes, { refs: true }),
    treeHash: treeHash(nodes),
    ...extra,
  };
}

export function png(byte: number): { png: Uint8Array; sha256: string } {
  const bytes = new Uint8Array([137, 80, 78, 71, byte]);
  return { png: bytes, sha256: sha256Hex(bytes) };
}

export function makeRequest(over: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    criterion: 'The plan badge shows "Pro"',
    params: { plan: 'Pro' },
    before: { treeText: '- heading "Billing"\n- text "Plan: Free"' },
    after: { treeText: '- heading "Billing"\n- text "Plan: Pro"' },
    actionPreceded: true,
    appContext: 'Acme billing app',
    ...over,
  };
}
