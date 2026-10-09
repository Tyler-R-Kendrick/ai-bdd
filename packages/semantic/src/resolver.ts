import {
  normalizeStepText,
  type Binding,
  type BindingSet,
  type Candidate,
  type ChatModel,
  type Embedder,
  type GuardConfig,
  type JsonValue,
  type KindSource,
  type KindsConfig,
  type ParamExtraction,
  type Resolution,
  type StepKind,
} from '@ai-bdd/contracts';
import { counterExampleGuard, polarityGuard } from './guards.js';
import { buildExtractionSchema, validateParams } from './params.js';
import { createEmbeddingCache, dot, l2Normalize } from './embedding.js';

/** Version of the extraction prompt, recorded in every semantic resolution. */
export const EXTRACT_PROMPT_VERSION = 'extract-v1';

export const EXTRACT_SYSTEM_PROMPT =
  'Extract the parameters named in the JSON schema from the step text. ' +
  'Return only values that appear literally in the step text. ' +
  'Use numbers for numeric parameters. Do not invent values.';

export const DEFAULT_SEMANTIC_THRESHOLD = 0.85;
export const DEFAULT_SEMANTIC_MARGIN = 0.1;

export interface SemanticConfig {
  threshold?: number;
  margin?: number;
  guards?: GuardConfig;
  kinds?: KindsConfig;
  topK?: number;
  embedCacheDir?: string;
}

export interface SemanticStep {
  text: string;
  kind: StepKind;
  kindSource?: KindSource;
}

export interface SemanticResolver {
  resolve(step: SemanticStep, set: BindingSet): Promise<Resolution | null>;
  explain(step: { text: string; kind: StepKind }, set: BindingSet): Promise<Candidate[]>;
}

interface RankedEntry {
  binding: Binding;
  score: number;
  guard: string | null;
}

interface Extraction {
  validated: boolean;
  params: Record<string, JsonValue>;
  record: ParamExtraction;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function kindCompatible(binding: Binding, step: SemanticStep): boolean {
  // R-K5c: a keyword-less Gauge step (kindSource 'default') accepts any binding
  // kind, because its kind is not declared by the author; a binding that declares
  // strictKind opts out of that. Steps whose kind was decided by a directive, a
  // binding, a Gherkin keyword or a prefix heuristic must match the kind.
  if (step.kindSource === 'default') return binding.strictKind !== true;
  if (binding.kind !== 'any' && binding.kind !== step.kind) return false;
  return true;
}

function toCandidate(entry: RankedEntry, next: RankedEntry | undefined): Candidate {
  const candidate: Candidate = {
    bindingId: entry.binding.id,
    bindingHash: entry.binding.hash,
    score: entry.score,
  };
  if (next !== undefined) candidate.margin = round(entry.score - next.score);
  if (entry.guard !== null) candidate.guard = entry.guard;
  return candidate;
}

/**
 * Section 8.1.1 step 4 / 8.1.3 / 8.1.4: rank kind-compatible bindings by
 * cosine similarity of embeddings, apply the deterministic guards, enforce the
 * threshold and margin (R-K5a-e) and extract parameters through the model.
 *
 * Returns `null` when no binding is kind compatible, an `ambiguous` resolution
 * instead of guessing, and an `agent` resolution when the semantic stage cannot
 * decide.
 */
export function createSemanticResolver(opts: {
  embedder: Embedder;
  extractor: ChatModel;
  config: SemanticConfig;
}): SemanticResolver {
  const { embedder, extractor } = opts;
  const threshold = opts.config.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const margin = opts.config.margin ?? DEFAULT_SEMANTIC_MARGIN;
  const topK = opts.config.topK ?? 5;
  const guards = opts.config.guards;
  const cache = createEmbeddingCache(opts.config.embedCacheDir ?? '.ai-bdd/cache/embeddings');
  const bindingVectors = new Map<string, Float32Array[]>();

  async function embedMany(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = new Array(texts.length);
    const missIndices: number[] = [];
    const missTexts: string[] = [];
    texts.forEach((text, index) => {
      const hit = cache.get(embedder.id, text);
      if (hit !== null) {
        out[index] = hit;
      } else {
        missIndices.push(index);
        missTexts.push(text);
      }
    });
    if (missTexts.length > 0) {
      const vectors = await embedder.embed(missTexts);
      vectors.forEach((vector, offset) => {
        const normalized = l2Normalize(vector);
        out[missIndices[offset] ?? offset] = normalized;
        cache.put(embedder.id, missTexts[offset] ?? '', normalized);
      });
    }
    return out;
  }

  async function vectorsFor(binding: Binding): Promise<Float32Array[]> {
    const cached = bindingVectors.get(binding.hash);
    if (cached !== undefined) return cached;
    const texts = binding.bindingTexts.length > 0 ? binding.bindingTexts : [normalizeStepText(binding.pattern)];
    const vectors = await embedMany(texts);
    bindingVectors.set(binding.hash, vectors);
    return vectors;
  }

  function guardFor(step: SemanticStep, binding: Binding): string | null {
    const counter = counterExampleGuard(step.text, binding);
    if (counter !== null) return counter;
    const bindingText = binding.bindingTexts[0] ?? normalizeStepText(binding.pattern);
    return polarityGuard(step.text, bindingText, guards);
  }

  async function rank(step: SemanticStep, set: BindingSet): Promise<RankedEntry[]> {
    const [stepVector] = await embedMany([normalizeStepText(step.text)]);
    if (stepVector === undefined) return [];
    const entries: RankedEntry[] = [];
    for (const binding of set.bindings) {
      if (!kindCompatible(binding, step)) continue;
      const vectors = await vectorsFor(binding);
      let best = -Infinity;
      for (const vector of vectors) best = Math.max(best, dot(stepVector, vector));
      entries.push({ binding, score: round(best), guard: guardFor(step, binding) });
    }
    entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.binding.id < b.binding.id ? -1 : a.binding.id > b.binding.id ? 1 : 0;
    });
    return entries;
  }

  async function extract(step: SemanticStep, binding: Binding): Promise<Extraction> {
    const decls = binding.params ?? [];
    if (decls.length === 0) {
      return {
        validated: true,
        params: {},
        record: { modelId: extractor.id, promptVersion: EXTRACT_PROMPT_VERSION, raw: {}, validated: true },
      };
    }
    const result = await extractor.generate({
      purpose: 'extract',
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: normalizeStepText(step.text) },
      ],
      schema: buildExtractionSchema(decls),
    });
    const raw: JsonValue = result.object ?? null;
    const record: ParamExtraction = {
      modelId: result.modelId || extractor.id,
      promptVersion: EXTRACT_PROMPT_VERSION,
      raw,
      validated: false,
    };
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { validated: false, params: {}, record };
    }
    const validation = validateParams({ text: step.text }, binding, raw as Record<string, JsonValue>);
    if (!validation.ok) return { validated: false, params: {}, record };
    record.validated = true;
    return { validated: true, params: validation.params, record };
  }

  const resolver: SemanticResolver = {
    async resolve(step: SemanticStep, set: BindingSet): Promise<Resolution | null> {
      const ranked = await rank(step, set);
      if (ranked.length === 0) return null;
      const mode = step.kind === 'assertion' ? 'assert' : 'act';
      const viable = ranked.filter((entry) => entry.guard === null);
      if (viable.length === 0) {
        return {
          type: 'ambiguous',
          reason: 'guard-rejected',
          candidates: ranked.slice(0, topK).map((entry, index) => toCandidate(entry, ranked[index + 1])),
          message: `all ${ranked.length} candidate bindings were rejected by guards`,
        };
      }
      const top = viable[0] as RankedEntry;
      if (top.score < threshold) {
        return { type: 'agent', mode, reason: 'below-threshold' };
      }
      const runnerUp = viable[1];
      const topMargin = round(top.score - (runnerUp?.score ?? 0));
      if (runnerUp !== undefined && topMargin < margin) {
        return {
          type: 'ambiguous',
          reason: 'margin',
          candidates: viable.slice(0, topK).map((entry, index) => toCandidate(entry, viable[index + 1])),
          message: `top two scores differ by ${topMargin}, below the margin ${margin}`,
        };
      }
      const extraction = await extract(step, top.binding);
      if (!extraction.validated) {
        return { type: 'agent', mode, reason: 'guard-rejected' };
      }
      return {
        type: 'semantic',
        bindingId: top.binding.id,
        bindingHash: top.binding.hash,
        params: extraction.params,
        score: top.score,
        margin: topMargin,
        candidates: viable.slice(0, topK).map((entry, index) => toCandidate(entry, viable[index + 1])),
        extraction: extraction.record,
      };
    },
    async explain(step: { text: string; kind: StepKind }, set: BindingSet): Promise<Candidate[]> {
      const ranked = await rank({ text: step.text, kind: step.kind }, set);
      return ranked.slice(0, topK).map((entry, index) => toCandidate(entry, ranked[index + 1]));
    },
  };
  return resolver;
}
