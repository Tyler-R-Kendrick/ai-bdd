import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChatModel, Embedder, GenerateRequest, GenerateResult, JsonValue } from '@ai-bdd/contracts';

/** Path to the shared fake-model synonym table (fixtures/fake-model/synonyms.json). */
export const SYNONYMS_PATH = fileURLToPath(
  new URL('../../../../fixtures/fake-model/synonyms.json', import.meta.url),
);

export function loadSynonyms(path: string = SYNONYMS_PATH): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic bag-of-words embedder. Tokens are canonicalized through the
 * synonym table so e.g. "create a workspace" and "seed a workspace" embed
 * identically. No randomness, no network.
 */
export function createFakeEmbedder(opts: { dimensions?: number; synonyms?: Record<string, string> } = {}): Embedder {
  const dimensions = opts.dimensions ?? 64;
  const synonyms = opts.synonyms ?? loadSynonyms();
  return {
    id: `fake-embedder-${dimensions}`,
    dimensions,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vector = new Float32Array(dimensions);
        const tokens = text
          .toLowerCase()
          .normalize('NFC')
          .split(/[^\p{L}\p{N}-]+/u)
          .filter((token) => token.length > 0);
        for (const raw of tokens) {
          const token = synonyms[raw] ?? raw;
          const index = hashToken(token) % dimensions;
          vector[index] = (vector[index] ?? 0) + 1;
        }
        return vector;
      });
    },
  };
}

/**
 * Embedder with fully controlled vectors. Unknown texts embed to the zero
 * vector. Provide unit vectors when you want to predict cosine scores exactly.
 */
export function createExactEmbedder(vectors: Record<string, number[]>, opts: { id?: string } = {}): Embedder {
  const dimensions = Math.max(1, ...Object.values(vectors).map((vector) => vector.length));
  return {
    id: opts.id ?? 'exact-embedder',
    dimensions,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vector = new Float32Array(dimensions);
        const values = vectors[text];
        if (values !== undefined) values.forEach((value, index) => { vector[index] = value; });
        return vector;
      });
    },
  };
}

export interface FakeRule {
  when: string | RegExp | ((req: GenerateRequest) => boolean);
  object?: JsonValue;
  text?: string;
}

function userMessage(req: GenerateRequest): string {
  for (let index = req.messages.length - 1; index >= 0; index -= 1) {
    const message = req.messages[index];
    if (message !== undefined && message.role === 'user') return message.content;
  }
  return '';
}

function ruleMatches(rule: FakeRule, req: GenerateRequest): boolean {
  const user = userMessage(req);
  if (typeof rule.when === 'string') return user === rule.when;
  if (rule.when instanceof RegExp) return rule.when.test(user);
  return rule.when(req);
}

/** Rule-driven fake ChatModel used only in tests (never a real model). */
export function createFakeChatModel(rules: FakeRule[], opts: { id?: string } = {}): ChatModel {
  const id = opts.id ?? 'fake-chat';
  return {
    id,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const result: GenerateResult = { usage: { inputTokens: 0, outputTokens: 0 }, modelId: id };
      for (const rule of rules) {
        if (ruleMatches(rule, req)) {
          if (rule.object !== undefined) result.object = rule.object;
          if (rule.text !== undefined) result.text = rule.text;
          return result;
        }
      }
      result.object = {};
      return result;
    },
  };
}

/** Extractor fake keyed by the (normalized) user message. */
export function createExtractorModel(
  responses: Record<string, JsonValue>,
  opts: { id?: string } = {},
): ChatModel {
  return createFakeChatModel(
    Object.entries(responses).map(([when, object]) => ({ when, object })),
    opts,
  );
}

/** Wrap a ChatModel and count generate() calls. */
export function withCounter(model: ChatModel): { model: ChatModel; calls: () => number } {
  let calls = 0;
  return {
    model: {
      id: model.id,
      async generate(req: GenerateRequest): Promise<GenerateResult> {
        calls += 1;
        return model.generate(req);
      },
    },
    calls: () => calls,
  };
}
