import { describe, expect, it } from 'vitest';
import { createFakeModels } from '@ai-bdd/testing';
import { req } from './helpers.ts';

describe('fake-model response kinds', () => {
  const m = createFakeModels({
    rules: [
      {
        rules: [
          { id: 'obj', purpose: 'extract', when: { kind: { notContains: 'retry' } }, respond: { object: { features: [], notTestable: [] } } },
          { id: 'txt', purpose: 'checkgen', respond: { text: 'plain text' } },
          {
            id: 'judge',
            purpose: 'judge',
            respond: {
              samples: [
                { probability: 0.9, verdict: 'holds', explanation: 'a', observed: 'o' },
                { probability: 0.8, verdict: 'holds', explanation: 'b', observed: 'o' },
                { probability: 0.1, verdict: 'fails', explanation: 'c', observed: 'o' },
              ],
            },
          },
          {
            id: 'attempts',
            purpose: 'extract',
            when: { kind: 'retry' },
            respond: { byAttempt: [{ object: { n: 1 } }, { object: { n: 2 } }, { text: 'third' }] },
          },
        ],
      },
    ],
  });

  it('object responses return the object, no tool calls, finishReason stop, id fake:<purpose>', async () => {
    const r = await m.extract.generate(req('extract', { kind: 'plain' }));
    expect(r).toMatchObject({ object: { features: [], notTestable: [] }, toolCalls: [], finishReason: 'stop', modelId: 'fake:extract' });
    expect(r.text).toBeUndefined();
    expect(m.extract.id).toBe('fake:extract');
    expect(m.act.id).toBe('fake:act');
    expect(m.checkgen.id).toBe('fake:checkgen');
    expect(m.judge.id).toBe('fake:judge');
  });

  it('text responses return text only', async () => {
    const r = await m.checkgen.generate(req('checkgen', {}));
    expect(r.text).toBe('plain text');
    expect(r.object).toBeUndefined();
    expect(r.toolCalls).toEqual([]);
  });

  it('samples: samples[context.sample % len] returned as object', async () => {
    const got = [];
    for (const sample of [0, 1, 2, 3, 4, 5, 7]) got.push(((await m.judge.generate(req('judge', { sample }))).object as { explanation: string }).explanation);
    expect(got).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'b']);
  });

  it('samples: missing sample defaults to the first', async () => {
    expect(((await m.judge.generate(req('judge', {}))).object as { explanation: string }).explanation).toBe('a');
  });

  it('byAttempt: byAttempt[min(attempt-1, len-1)]', async () => {
    const out = [];
    for (const attempt of [1, 2, 3, 4, 10]) {
      const r = await m.extract.generate(req('extract', { kind: 'retry', attempt }));
      out.push(r.object ?? r.text);
    }
    expect(out).toEqual([{ n: 1 }, { n: 2 }, 'third', 'third', 'third']);
  });

  it('byAttempt: attempt 0 or missing clamps to the first entry', async () => {
    expect((await m.extract.generate(req('extract', { kind: 'retry', attempt: 0 }))).object).toEqual({ n: 1 });
    expect((await m.extract.generate(req('extract', { kind: 'retry' }))).object).toEqual({ n: 1 });
  });

  it('returned objects are copies: mutating a response never changes later responses', async () => {
    const a = await m.extract.generate(req('extract', { kind: 'plain' }));
    (a.object as { features: unknown[] }).features.push('x');
    const b = await m.extract.generate(req('extract', { kind: 'plain' }));
    expect(b.object).toEqual({ features: [], notTestable: [] });
  });
});
