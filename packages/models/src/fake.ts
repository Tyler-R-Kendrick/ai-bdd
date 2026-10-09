import { readFileSync } from 'node:fs';
import type {
  ChatModel,
  Embedder,
  GenerateRequest,
  GenerateResult,
  GroundingCandidate,
  GroundingScorer,
  JsonValue,
  ModelSet,
  PriceTable,
} from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';

/** One recorded model call, for assertions in tests. */
export interface ModelCallLog {
  purpose: string;
  modelId: string;
  /** The full prompt text, so the canary test can inspect it. */
  prompt: string;
  request: GenerateRequest;
  result?: GenerateResult;
  error?: string;
}

export interface FakeRule {
  purpose: string;
  match: { contains?: string[]; all?: string[]; regex?: string };
  respond: {
    object?: JsonValue;
    toolCalls?: Array<{ name: string; args: JsonValue }>;
    text?: string;
    /** Successive outputs for repeated calls (act turns, judge samples). */
    variants?: Array<{ object?: JsonValue; toolCalls?: Array<{ name: string; args: JsonValue }>; text?: string }>;
  };
  /** Successive outputs for repeated calls (judge sampling, act turns). */
  variants?: Array<{ object?: JsonValue; toolCalls?: Array<{ name: string; args: JsonValue }>; text?: string }>;
}

const DEFAULT_STOPWORDS = ['a', 'an', 'the', 'on', 'in', 'to', 'of', 'for', 'and', 'with', 'is', 'are', 'be', 'it'];

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic stand-in for an embedding model (section 14.2): synonym-mapped
 * tokens hashed into signed buckets plus character trigrams at 0.3 weight,
 * L2-normalized so cosine similarity is a dot product.
 */
export class FakeEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private readonly synonyms: Record<string, string>;
  private readonly stopwords: Set<string>;

  constructor(options: { dimensions?: number; synonymsPath?: string; synonyms?: Record<string, string>; stopwords?: string[] } = {}) {
    this.dimensions = options.dimensions ?? 256;
    this.id = `fake:embed-${this.dimensions}`;
    this.synonyms = options.synonyms ?? loadSynonyms(options.synonymsPath);
    this.stopwords = new Set(options.stopwords ?? DEFAULT_STOPWORDS);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const normalized = text.normalize('NFC').toLowerCase();
    for (const raw of normalized.split(/[^a-z0-9-]+/u)) {
      if (raw.length === 0) continue;
      const word = this.synonyms[raw] ?? raw;
      if (this.stopwords.has(word)) continue;
      add(vector, word, 1);
    }
    for (let index = 0; index + 3 <= normalized.length; index += 1) {
      const trigram = normalized.slice(index, index + 3);
      if (/^[a-z0-9]{3}$/u.test(trigram)) add(vector, `#${trigram}`, 0.3);
    }
    return l2Normalize(vector);

    function add(target: Float32Array, token: string, weight: number): void {
      const hash = fnv1a(token);
      const bucket = hash % target.length;
      const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
      target[bucket] = (target[bucket] ?? 0) + sign * weight;
    }
  }
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / norm;
  return vector;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += (a[index] ?? 0) * (b[index] ?? 0);
  return sum;
}

export function loadSynonyms(path?: string): Record<string, string> {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Accepts either a rule array or an object with a `rules` array. */
export function loadRules(path?: string): FakeRule[] {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FakeRule[] | { rules?: FakeRule[] };
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

export interface FakeChatModelOptions {
  id?: string;
  rules?: FakeRule[];
  rulesPath?: string;
  log?: ModelCallLog[];
}

/**
 * Rule-driven deterministic chat model. The first matching rule wins; no match
 * throws MODEL_OUTPUT_INVALID so a missing rule is noticed immediately instead
 * of silently returning empty output.
 */
export class FakeChatModel implements ChatModel {
  readonly id: string;
  readonly log: ModelCallLog[];
  private readonly rules: FakeRule[];
  private readonly attempt = new Map<string, number>();

  constructor(options: FakeChatModelOptions = {}) {
    this.id = options.id ?? 'fake:chat';
    this.rules = options.rules ?? loadRules(options.rulesPath);
    this.log = options.log ?? [];
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const prompt = request.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
    const entry: ModelCallLog = { purpose: request.purpose, modelId: this.id, prompt, request };
    this.log.push(entry);

    const rule = this.rules.find((candidate) => candidate.purpose === request.purpose && matches(candidate.match, prompt));
    if (!rule) {
      const error = new AiBddError('MODEL_OUTPUT_INVALID', `no fake rule matched purpose=${request.purpose}`);
      entry.error = error.message;
      throw error;
    }

    const key = `${request.purpose}:${JSON.stringify(rule.match)}`;
    const index = this.attempt.get(key) ?? 0;
    this.attempt.set(key, index + 1);
    const variants = rule.variants ?? rule.respond.variants ?? [];
    const variant = variants[Math.min(index, Math.max(variants.length - 1, 0))];
    const object = variant?.object ?? rule.respond.object;
    const toolCalls = variant?.toolCalls ?? rule.respond.toolCalls;
    const text = variant?.text ?? rule.respond.text;

    const result: GenerateResult = {
      modelId: this.id,
      usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 8, calls: 1 },
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(object !== undefined ? { object } : {}),
    };
    entry.result = result;
    return result;
  }
}

function matches(match: FakeRule['match'], prompt: string): boolean {
  const contains = match.contains ?? [];
  if (contains.length > 0 && !contains.every((needle) => prompt.includes(needle))) return false;
  const all = match.all ?? [];
  if (all.length > 0 && !all.every((needle) => prompt.includes(needle))) return false;
  if (match.regex !== undefined) {
    try {
      if (!new RegExp(match.regex, 'u').test(prompt)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface FakeGroundingScorerOptions {
  rules?: Array<{ contains: string; scores: number[] }>;
}

/** Deterministic grounding scorer used by the act-loop tests (R-K23). */
export class FakeGroundingScorer implements GroundingScorer {
  readonly id = 'fake:grounding';
  private readonly rules: Array<{ contains: string; scores: number[] }>;

  constructor(options: FakeGroundingScorerOptions = {}) {
    this.rules = options.rules ?? [];
  }

  async score(input: { instruction: string; observationText: string; candidates: JsonValue[] }): Promise<GroundingCandidate[]> {
    const rule = this.rules.find((candidate) => input.instruction.includes(candidate.contains));
    const scores = rule?.scores ?? input.candidates.map(() => 0.5);
    return input.candidates.map((candidate, index) => ({ score: scores[index] ?? 0.5, candidate }));
  }
}

export interface FakeModelSetOptions {
  rules?: FakeRule[];
  rulesPath?: string;
  synonymsPath?: string;
  synonyms?: Record<string, string>;
  dimensions?: number;
  groundingRules?: Array<{ contains: string; scores: number[] }>;
}

export interface FakeModelSet extends ModelSet {
  log: ModelCallLog[];
  reset(): void;
  embedder: FakeEmbedder;
}

/** The deterministic model set used by every default test run. */
export function createFakeModelSet(options: FakeModelSetOptions = {}): FakeModelSet {
  const log: ModelCallLog[] = [];
  const rules = options.rules ?? loadRules(options.rulesPath);
  const embedder = new FakeEmbedder({
    ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
    ...(options.synonyms !== undefined ? { synonyms: options.synonyms } : {}),
    ...(options.synonymsPath !== undefined ? { synonymsPath: options.synonymsPath } : {}),
  });
  const make = (id: string): FakeChatModel => new FakeChatModel({ id, rules, log });
  return {
    act: make('fake:act'),
    judge: make('fake:judge'),
    extract: make('fake:extract'),
    checkgen: make('fake:checkgen'),
    embed: embedder,
    grounding: new FakeGroundingScorer(options.groundingRules !== undefined ? { rules: options.groundingRules } : {}),
    log,
    embedder,
    reset(): void {
      log.length = 0;
    },
  };
}

export const FAKE_PRICES: PriceTable = {
  'fake:act': { inputPer1k: 0, outputPer1k: 0 },
  'fake:judge': { inputPer1k: 0, outputPer1k: 0 },
  'fake:extract': { inputPer1k: 0, outputPer1k: 0 },
  'fake:checkgen': { inputPer1k: 0, outputPer1k: 0 },
};
