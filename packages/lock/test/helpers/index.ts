import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeStepText,
  type ChatModel,
  type Embedder,
  type GenerateRequest,
  type GenerateResult,
  type JsonValue,
  type LockEntry,
  type Step,
  type StepKind,
} from '@ai-bdd/contracts';

/** Embedder with fully controlled vectors; unknown texts embed to zero. */
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

/** Extractor fake keyed by the (normalized) user message. */
export function createExtractorModel(responses: Record<string, JsonValue>, opts: { id?: string } = {}): ChatModel {
  const id = opts.id ?? 'fake-extractor';
  return {
    id,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const result: GenerateResult = { usage: { inputTokens: 0, outputTokens: 0 }, modelId: id };
      for (let index = req.messages.length - 1; index >= 0; index -= 1) {
        const message = req.messages[index];
        if (message !== undefined && message.role === 'user' && responses[message.content] !== undefined) {
          result.object = responses[message.content];
          return result;
        }
      }
      result.object = {};
      return result;
    },
  };
}

export function makeStep(overrides: Partial<Step> & Pick<Step, 'text'>): Step {
  const text = overrides.text;
  return {
    id: overrides.id ?? 'step-1',
    text,
    normalized: normalizeStepText(text),
    kind: overrides.kind ?? 'action',
    kindSource: overrides.kindSource ?? 'keyword',
    args: overrides.args ?? [],
    location: overrides.location ?? { uri: 'spec.md', line: 1, column: 1 },
    options: overrides.options ?? {},
    originChain: overrides.originChain ?? [],
  };
}

export function makeEntry(key: string, overrides: Partial<LockEntry> = {}): LockEntry {
  return {
    key,
    stepText: key,
    normalizedStepText: key,
    kind: (overrides.kind ?? 'action') as StepKind,
    kindClass: overrides.kindClass ?? 'inferred',
    status: overrides.status ?? 'agent',
    resolution: overrides.resolution ?? { type: 'agent', mode: 'act', reason: 'no-match' },
    bindingSetHash: overrides.bindingSetHash ?? 'binding-set-hash',
    candidates: overrides.candidates ?? [],
    updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00.000Z',
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function unit(cos: number): number[] {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
}
