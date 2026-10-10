// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { aggregateJudgeSamples, createJudge, samplePassProbability } from '../../src/judge/index.ts';
import { ScriptedJudgeModel, cannotTell, fails, holds, makeConfig, makeRequest, type ScriptEntry } from './doubles.ts';

const CFG = { passThreshold: 0.8, failThreshold: 0.3, maxSpread: 0.5 };

describe('judge sample handling (R-JU2)', () => {
  it('R-JU2: per-sample probability is clamped and contradictions or cannot_tell become 0.5', () => {
    const table: [Parameters<typeof samplePassProbability>[0], number][] = [
      [{ probability: 0.9, verdict: 'holds' }, 0.9],
      [{ probability: 1.7, verdict: 'holds' }, 1],
      [{ probability: -3, verdict: 'fails' }, 0],
      [{ probability: 0.2, verdict: 'fails' }, 0.2],
      [{ probability: 0.2, verdict: 'holds' }, 0.5],
      [{ probability: 0.499, verdict: 'holds' }, 0.5],
      [{ probability: 0.5, verdict: 'holds' }, 0.5],
      [{ probability: 0.8, verdict: 'fails' }, 0.5],
      [{ probability: 0.5, verdict: 'fails' }, 0.5],
      [{ probability: 0.99, verdict: 'cannot_tell' }, 0.5],
      [{ probability: 0.01, verdict: 'cannot_tell' }, 0.5],
    ];
    for (const [sample, expected] of table) expect(samplePassProbability(sample)).toBe(expected);
  });

  const holdsAt = (probability: number) => ({ probability, verdict: 'holds' as const });
  const failsAt = (probability: number) => ({ probability, verdict: 'fails' as const });
  const aggTable: { name: string; samples: Parameters<typeof aggregateJudgeSamples>[0]; verdict: string; reason?: string; score?: number; spread?: number }[] = [
    { name: 'all high passes', samples: [holdsAt(0.95), holdsAt(0.9), holdsAt(0.92)], verdict: 'pass' },
    { name: 'exact pass threshold passes (float safe)', samples: [holdsAt(0.7), holdsAt(0.9), holdsAt(0.8)], verdict: 'pass', score: 0.8, spread: 0.2 },
    { name: 'just below pass threshold is band', samples: [holdsAt(0.79), holdsAt(0.79), holdsAt(0.79)], verdict: 'inconclusive', reason: 'band' },
    { name: 'all low fails', samples: [failsAt(0.05), failsAt(0.1), failsAt(0.02)], verdict: 'fail' },
    { name: 'exact fail threshold fails', samples: [failsAt(0.3), failsAt(0.3), failsAt(0.3)], verdict: 'fail' },
    { name: 'just above fail threshold is band', samples: [failsAt(0.31), failsAt(0.31), failsAt(0.31)], verdict: 'inconclusive', reason: 'band' },
    { name: 'middle score is band', samples: [holdsAt(0.6), holdsAt(0.55), failsAt(0.4)], verdict: 'inconclusive', reason: 'band' },
    { name: 'spread above maxSpread is inconclusive even if mean passes', samples: [holdsAt(1), holdsAt(1), failsAt(0.4)], verdict: 'inconclusive', reason: 'spread', spread: 0.6 },
    { name: 'spread exactly maxSpread is not a spread failure', samples: [holdsAt(1), holdsAt(1), holdsAt(0.5)], verdict: 'pass', spread: 0.5 },
    { name: 'high spread wins over a failing mean', samples: [failsAt(0), failsAt(0.1), holdsAt(0.9)], verdict: 'inconclusive', reason: 'spread' },
    { name: 'contradictory sample (holds with p=0.1) counts as 0.5, so it is a band not a spread', samples: [holdsAt(0.9), holdsAt(0.85), holdsAt(0.1)], verdict: 'inconclusive', reason: 'band', score: 0.75, spread: 0.4 },
    { name: 'cannot_tell samples are 0.5', samples: [cannotTell(), cannotTell(), cannotTell()], verdict: 'inconclusive', reason: 'band', score: 0.5, spread: 0 },
    { name: 'single sample passes', samples: [holdsAt(0.85)], verdict: 'pass', spread: 0 },
    { name: 'single contradictory sample is band', samples: [failsAt(0.9)], verdict: 'inconclusive', reason: 'band', score: 0.5 },
  ];
  for (const row of aggTable) {
    it(`R-JU2: aggregation table: ${row.name}`, () => {
      const r = aggregateJudgeSamples(row.samples, CFG);
      expect(r.verdict).toBe(row.verdict);
      expect(r.reason).toBe(row.reason);
      if (row.score !== undefined) expect(r.score).toBeCloseTo(row.score, 9);
      if (row.spread !== undefined) expect(r.spread).toBeCloseTo(row.spread, 9);
    });
  }

  it('R-JU2: inconclusive carries no reason on pass/fail', () => {
    expect('reason' in aggregateJudgeSamples([holdsAt(0.9)], CFG)).toBe(false);
  });

  async function judgeWith(script: ScriptEntry[], over: Parameters<typeof makeConfig>[0] = {}) {
    const model = new ScriptedJudgeModel('judge-model', script);
    return createJudge({ model, config: makeConfig(over), cacheDir: null }).judge(makeRequest());
  }

  it('R-JU2: judge pass with three high samples; usage summed over samples', async () => {
    const v = await judgeWith([holds(0.95), holds(0.9), holds(0.85)]);
    expect(v.verdict).toBe('pass');
    expect(v.score).toBeCloseTo(0.9, 9);
    expect(v.samples.length).toBe(3);
    expect(v.cached).toBe(false);
    expect(v.promptVersion).toBe('judge-v1');
    expect(v.modelId).toBe('judge-model');
    expect(v.usage).toEqual({ modelCalls: 3, inputTokens: 300, outputTokens: 30 });
  });

  it('R-JU2: judge fail with three low samples', async () => {
    const v = await judgeWith([fails(0.05), fails(0.1), fails(0.0)]);
    expect(v.verdict).toBe('fail');
    expect(v.reason).toBeUndefined();
  });

  it('R-JU2: band and spread reasons surface on the verdict (M17)', async () => {
    const band = await judgeWith([holds(0.6), holds(0.6), holds(0.6)]);
    expect(band.verdict).toBe('inconclusive');
    expect(band.reason).toBe('band');
    const spread = await judgeWith([holds(1), holds(1), fails(0.0)]);
    expect(spread.verdict).toBe('inconclusive');
    expect(spread.reason).toBe('spread');
    expect(spread.spread).toBe(1);
  });

  it('R-JU2: contradictory model samples are treated as 0.5 end to end', async () => {
    const v = await judgeWith([holds(0.9), holds(0.85), { probability: 0.1, verdict: 'holds' }]);
    expect(v.samples[2]?.probability).toBe(0.1);
    expect(v.score).toBeCloseTo((0.9 + 0.85 + 0.5) / 3, 9);
    expect(v.verdict).toBe('inconclusive');
    expect(v.reason).toBe('band');
  });

  it('R-JU2: out-of-range probabilities are clamped in reported samples', async () => {
    const v = await judgeWith([{ probability: 4, verdict: 'holds' }, { probability: 4, verdict: 'holds' }, { probability: 4, verdict: 'holds' }]);
    expect(v.samples.map((s) => s.probability)).toEqual([1, 1, 1]);
    expect(v.verdict).toBe('pass');
  });

  it('R-JU2: sample count follows config.judge.samples and thresholds follow config', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds(0.6)]);
    const judge = createJudge({ model, config: makeConfig({ samples: 5, passThreshold: 0.55 }), cacheDir: null });
    const v = await judge.judge(makeRequest());
    expect(model.requests.length).toBe(5);
    expect(v.usage.modelCalls).toBe(5);
    expect(v.verdict).toBe('pass');
  });

  it('R-JU2: JSON text answers (also in code fences) are accepted', async () => {
    const text = JSON.stringify({ probability: 0.9, verdict: 'holds', explanation: 'e', observed: 'o' });
    const v = await judgeWith([text, '```json\n' + text + '\n```', text]);
    expect(v.verdict).toBe('pass');
  });

  it('R-JU2: invalid model JSON raises MODEL_OUTPUT_INVALID', async () => {
    const bad: ScriptEntry[][] = [
      ['not json', 'not json', 'not json'],
      [holds(), '{"probability": 0.9}', holds()],
      [holds(), holds(), JSON.stringify({ probability: 'high', verdict: 'holds', explanation: '', observed: '' })],
      [holds(), holds(), JSON.stringify({ probability: 0.9, verdict: 'maybe', explanation: '', observed: '' })],
    ];
    for (const script of bad) {
      const err = await judgeWith(script).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AiBddError);
      expect((err as AiBddError).code).toBe('MODEL_OUTPUT_INVALID');
    }
  });

  it('R-JU2: a response with neither object nor text is MODEL_OUTPUT_INVALID', async () => {
    const empty: ScriptEntry = () => ({ toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop', modelId: 'judge-model' });
    const err = await judgeWith([empty]).then(() => null, (e: unknown) => e);
    expect((err as AiBddError).code).toBe('MODEL_OUTPUT_INVALID');
  });
});
