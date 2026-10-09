import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BindingSet, JsonValue, StepKind } from '@ai-bdd/contracts';
import { createSemanticResolver, type SemanticConfig } from '../../src/index.js';
import { createExactEmbedder, createExtractorModel } from '../helpers/fakes.js';
import { bindingSetOf, desc } from '../helpers/sets.js';

const STEP = 'alpha beta gamma';

function unit(cos: number): number[] {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
}

function makeResolver(
  vectors: Record<string, number[]>,
  responses: Record<string, JsonValue> = {},
  config: Partial<SemanticConfig> = {},
) {
  const embedder = createExactEmbedder({ [STEP]: [1, 0], ...vectors });
  const extractor = createExtractorModel(responses);
  return createSemanticResolver({
    embedder,
    extractor,
    config: { threshold: 0.85, margin: 0.1, embedCacheDir: mkdtempSync(join(tmpdir(), 'semantic-')), ...config },
  });
}

function step(kind: StepKind = 'action', text = STEP, kindSource?: 'default' | 'keyword') {
  return kindSource === undefined ? { text, kind } : { text, kind, kindSource };
}

function setOf(descriptors: Parameters<typeof bindingSetOf>[0]): BindingSet {
  return bindingSetOf(descriptors);
}

describe('createSemanticResolver (R-K5a-e)', () => {
  it('R-K5a: falls back to the agent when the top score is below the threshold', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.8) });
    const set = setOf([desc({ id: 'a', pattern: 'binding a text', kind: 'action' })]);
    expect(await resolver.resolve(step(), set)).toEqual({ type: 'agent', mode: 'act', reason: 'below-threshold' });
  });

  it('R-K5a: resolves the clear winner above the threshold', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.95), 'binding b text': unit(0.4) });
    const set = setOf([
      desc({ id: 'a', pattern: 'binding a text', kind: 'action' }),
      desc({ id: 'b', pattern: 'binding b text', kind: 'action' }),
    ]);
    const result = await resolver.resolve(step(), set);
    expect(result?.type).toBe('semantic');
    if (result?.type === 'semantic') {
      expect(result.bindingId).toBe('a');
      expect(result.score).toBeCloseTo(0.95, 4);
      expect(result.margin).toBeCloseTo(0.55, 3);
      expect(result.extraction.validated).toBe(true);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('R-K5b: returns ambiguous (never a guess) when the margin is too small', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.95), 'binding b text': unit(0.9) });
    const set = setOf([
      desc({ id: 'a', pattern: 'binding a text', kind: 'action' }),
      desc({ id: 'b', pattern: 'binding b text', kind: 'action' }),
    ]);
    const result = await resolver.resolve(step(), set);
    expect(result?.type).toBe('ambiguous');
    if (result?.type === 'ambiguous') {
      expect(result.reason).toBe('margin');
      expect(result.candidates.map((candidate) => candidate.bindingId)).toEqual(['a', 'b']);
    }
  });

  it('R-K5c: ignores bindings whose kind is incompatible', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.99) });
    const set = setOf([desc({ id: 'a', pattern: 'binding a text', kind: 'setup' })]);
    expect(await resolver.resolve(step('action'), set)).toBeNull();
  });

  it('R-K5c: excludes strictKind bindings for default-kind steps only', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.99) });
    const set = setOf([desc({ id: 'a', pattern: 'binding a text', kind: 'action', strictKind: true })]);
    expect(await resolver.resolve(step('action', STEP, 'default'), set)).toBeNull();
    const allowed = await resolver.resolve(step('action', STEP, 'keyword'), set);
    expect(allowed?.type).toBe('semantic');
  });

  it('R-K5e: rejects a candidate whose counter-example equals the step', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.99) });
    const set = setOf([desc({ id: 'a', pattern: 'binding a text', kind: 'action', counterExamples: [STEP] })]);
    const result = await resolver.resolve(step(), set);
    expect(result?.type).toBe('ambiguous');
    if (result?.type === 'ambiguous') {
      expect(result.reason).toBe('guard-rejected');
      expect(result.candidates[0]?.guard).toContain('counter-example');
    }
  });

  it('R-K5e: rejects a candidate whose polarity contradicts the step', async () => {
    const text = 'the user is not logged in';
    const resolver = makeResolver({ [text]: [1, 0], 'the user is logged in': [1, 0] });
    const set = setOf([desc({ id: 'a', pattern: 'the user is logged in', kind: 'action' })]);
    const result = await resolver.resolve({ text, kind: 'action' }, set);
    expect(result?.type).toBe('ambiguous');
    if (result?.type === 'ambiguous') expect(result.candidates[0]?.guard).toContain('polarity');
  });

  it('R-K5d: extracts parameters through the model and validates them', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.95) }, { [STEP]: { target: 'alpha' } });
    const set = setOf([
      desc({ id: 'a', pattern: 'binding a text', kind: 'action', params: [{ name: 'target', type: 'word' }] }),
    ]);
    const result = await resolver.resolve(step(), set);
    expect(result?.type).toBe('semantic');
    if (result?.type === 'semantic') {
      expect(result.params).toEqual({ target: 'alpha' });
      expect(result.extraction.validated).toBe(true);
      expect(result.extraction.promptVersion).toBe('extract-v1');
    }
  });

  it('R-K5d: falls back to the agent when extraction fails validation', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.95) }, { [STEP]: { target: 'zeta' } });
    const set = setOf([
      desc({ id: 'a', pattern: 'binding a text', kind: 'action', params: [{ name: 'target', type: 'word' }] }),
    ]);
    expect(await resolver.resolve(step(), set)).toEqual({ type: 'agent', mode: 'act', reason: 'guard-rejected' });
  });

  it('uses assert mode for assertion steps', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.5) });
    const set = setOf([desc({ id: 'a', pattern: 'binding a text', kind: 'assertion' })]);
    expect(await resolver.resolve(step('assertion'), set)).toEqual({ type: 'agent', mode: 'assert', reason: 'below-threshold' });
  });

  it('explains the ranked candidates including guard reasons', async () => {
    const resolver = makeResolver({ 'binding a text': unit(0.95), 'binding b text': unit(0.4) });
    const set = setOf([
      desc({ id: 'a', pattern: 'binding a text', kind: 'action' }),
      desc({ id: 'b', pattern: 'binding b text', kind: 'action', counterExamples: [STEP] }),
    ]);
    const candidates = await resolver.explain(step(), set);
    expect(candidates.map((candidate) => candidate.bindingId)).toEqual(['a', 'b']);
    expect(candidates[0]?.score).toBeCloseTo(0.95, 4);
    expect(candidates[1]?.guard).toContain('counter-example');
  });
});
