import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../../src/contracts/index.ts';
import { createUsageMeter } from '../../src/engine/usage.ts';

/** A custom model that reports whatever usage it is given. */
const reporting = (usage: unknown): ChatModel => ({
  id: 'custom',
  generate: () => Promise.resolve({ text: 'ok', toolCalls: [], usage: usage as { inputTokens: number; outputTokens: number }, finishReason: 'stop', modelId: 'custom' }),
});

const call = (model: ChatModel) => {
  const meter = createUsageMeter({ extract: model, act: model, checkgen: model, judge: model }, { custom: { inputPerMTok: 1, outputPerMTok: 1 } });
  const before = meter.snapshot();
  return { meter, before, result: meter.models.act.generate({ purpose: 'act', system: 's', messages: [], context: {} }) };
};

describe('usage meter: token counts from a custom model', () => {
  it.each([
    ['a negative count', { inputTokens: -1, outputTokens: 0 }, 'inputTokens = -1'],
    ['NaN', { inputTokens: 1, outputTokens: Number.NaN }, 'outputTokens = NaN'],
    ['an infinite count', { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 }, 'inputTokens = Infinity'],
    ['a count too large to be exact', { inputTokens: 2 ** 60, outputTokens: 0 }, `inputTokens = ${2 ** 60}`],
    ['a string', { inputTokens: '12', outputTokens: 0 }, 'inputTokens = 12'],
    ['a missing count', { outputTokens: 0 }, 'inputTokens = undefined'],
    ['no usage at all', undefined, 'inputTokens = undefined'],
  ])('%s is refused with MODEL_OUTPUT_INVALID and counts no tokens and no cost', async (_name, usage, shown) => {
    const { meter, before, result } = call(reporting(usage));
    await expect(result).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', message: expect.stringContaining(`the act model "custom" reported ${shown}`) as string });
    const delta = meter.since(before);
    expect([delta.total.inputTokens, delta.total.outputTokens, delta.costUsd]).toEqual([0, 0, 0]);
    expect(delta.total.modelCalls).toBe(1);
  });

  it('a fractional count is rounded up, in the meter and in the response the caller adds to its step usage', async () => {
    const { meter, before, result } = call(reporting({ inputTokens: 2.5, outputTokens: 0.1 }));
    expect((await result).usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(meter.since(before).total).toEqual({ modelCalls: 1, inputTokens: 3, outputTokens: 1 });
  });

  it('valid counts pass through unchanged, zero included', async () => {
    const { meter, before, result } = call(reporting({ inputTokens: 1200, outputTokens: 0 }));
    expect((await result).usage).toEqual({ inputTokens: 1200, outputTokens: 0 });
    expect(meter.since(before).total).toEqual({ modelCalls: 1, inputTokens: 1200, outputTokens: 0 });
    expect(meter.since(before).costUsd).toBeCloseTo(0.0012, 10);
  });
});
