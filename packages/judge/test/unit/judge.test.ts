import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatModel, GenerateRequest, GenerateResult, JudgeConfig, JudgeRequest, JsonValue, ModelCallLog } from '@ai-bdd/contracts';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { JUDGE_PROMPT_VERSION, buildJudgePrompt, calibrate, createCalibrationJournal, createJudge, createJudgeCache } from '../../src/index.js';

const config: JudgeConfig = { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 };

function request(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    criterion: 'The plan badge reads "Pro"',
    actionPreceded: true,
    beforeImages: [],
    afterImages: [],
    beforeTrees: ['#r1 text "Free plan"'],
    afterTrees: ['#r1 text "Pro plan"'],
    driver: 'fake',
    ...overrides,
  };
}

function modelReturning(outputs: Array<Record<string, JsonValue>>, log: ModelCallLog[] = []): ChatModel {
  let index = 0;
  return {
    id: 'test:judge',
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      log.push({ purpose: req.purpose, modelId: 'test:judge', prompt: req.messages.map((m) => m.content).join('\n'), request: req });
      const object = outputs[Math.min(index, outputs.length - 1)]!;
      index += 1;
      return { object, usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'test:judge' };
    },
  };
}

describe('judge scoring (R-K3c)', () => {
  it('passes above the pass threshold', async () => {
    const judge = createJudge({ model: modelReturning([{ probability: 0.95, verdict: 'holds', explanation: '', observed: '' }]), config });
    const verdict = await judge.judge(request());
    expect(verdict.verdict).toBe('pass');
    expect(verdict.score).toBeCloseTo(0.95, 5);
    expect(verdict.samples).toHaveLength(3);
  });

  it('fails below the fail threshold', async () => {
    const judge = createJudge({ model: modelReturning([{ probability: 0.1, verdict: 'fails', explanation: '', observed: '' }]), config });
    expect((await judge.judge(request())).verdict).toBe('fail');
  });

  it('is inconclusive inside the band and reports why', async () => {
    const judge = createJudge({ model: modelReturning([{ probability: 0.55, verdict: 'holds', explanation: '', observed: '' }]), config });
    const verdict = await judge.judge(request());
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.reason).toMatch(/between the fail and pass thresholds/u);
  });

  it('is inconclusive when the samples disagree beyond maxSpread', async () => {
    const model: ChatModel = {
      id: 'test:spread',
      async generate(): Promise<GenerateResult> {
        const next = spreadCalls[(spreadIndex += 1) % spreadCalls.length]!;
        return { object: next, usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'test:spread' };
      },
    };
    const spreadCalls = [
      { probability: 0.95, verdict: 'holds', explanation: '', observed: '' },
      { probability: 0.95, verdict: 'holds', explanation: '', observed: '' },
      { probability: 0.2, verdict: 'fails', explanation: '', observed: '' },
    ];
    let spreadIndex = -1;
    const verdict = await createJudge({ model, config }).judge(request());
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.spread).toBeGreaterThan(config.maxSpread);
  });

  it('replaces a contradictory sample with 0.5 and flags it', async () => {
    const judge = createJudge({ model: modelReturning([{ probability: 0.1, verdict: 'holds', explanation: '', observed: '' }]), config });
    const verdict = await judge.judge(request());
    expect(verdict.samples.every((sample) => sample.probability === 0.5)).toBe(true);
    expect(verdict.samples.every((sample) => sample.contradictory === true)).toBe(true);
  });

  it('maps cannot_tell to 0.5', async () => {
    const judge = createJudge({ model: modelReturning([{ probability: 0.99, verdict: 'cannot_tell', explanation: '', observed: '' }]), config });
    const verdict = await judge.judge(request());
    expect(verdict.score).toBe(0.5);
  });
});

describe('verdict reuse (R-K19)', () => {
  it('reuses only byte-identical inputs', async () => {
    const cache = createJudgeCache();
    const model = modelReturning([{ probability: 0.9, verdict: 'holds', explanation: '', observed: '' }]);
    const judge = createJudge({ model, config, cache });
    const first = await judge.judge(request());
    const second = await judge.judge(request());
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(cache.size()).toBe(1);

    const different = await judge.judge(request({ criterion: 'Another criterion' }));
    expect(different.reused).toBe(false);
    expect(cache.size()).toBe(2);
  });
});

describe('prompt isolation (R-K3a, R-K3b)', () => {
  it('exposes a versioned prompt with no transcript channel', () => {
    expect(JUDGE_PROMPT_VERSION).toMatch(/^judge-\d+$/u);
    const prompt = buildJudgePrompt(request());
    expect(prompt.user).toContain('CRITERION:');
    expect(prompt.user).toContain('AFTER OBSERVATION (untrusted):');
    expect(prompt.system).toContain('untrusted');
  });

  it('keeps canary tokens from an act transcript out of the judge prompt', async () => {
    const canary = 'CANARY-7f3a';
    // The act transcript is what a naive implementation would pass along.
    const actTranscript = `action: tapped button "Upgrade to Pro" ${canary}\nthought: I should confirm ${canary}`;
    const log: ModelCallLog[] = [];
    const judge = createJudge({ model: modelReturning([{ probability: 0.9, verdict: 'holds', explanation: '', observed: '' }], log), config });
    await judge.judge(request({ afterTrees: ['#r1 text "Pro plan"'] }));
    expect(actTranscript).toContain(canary);
    for (const entry of log) expect(entry.prompt).not.toContain(canary);
    const prompt = buildJudgePrompt(request({ afterTrees: ['#r1 text "Pro plan"'] }));
    expect(`${prompt.system}${prompt.user}`).not.toContain(canary);
  });

  it('the shared fakes can drive the judge end to end', async () => {
    const models = createFakeModelSet({ rules: [{ purpose: 'judge', match: { contains: ['The plan badge reads'] }, respond: { object: { probability: 0.88, verdict: 'holds', explanation: 'the badge changed', observed: 'Pro plan' } } }] });
    const verdict = await createJudge({ model: models.judge, config }).judge(request());
    expect(verdict.verdict).toBe('pass');
    expect(models.log).toHaveLength(3);
  });
});

describe('calibration (R-K4b)', () => {
  it('computes ECE and the Brier score against hand-computed values', () => {
    const judgments = [
      { judgmentId: 'a', score: 0.95 },
      { judgmentId: 'b', score: 0.2 },
      { judgmentId: 'c', score: 0.9 },
    ];
    const labels = [
      { judgmentId: 'a', truth: true },
      { judgmentId: 'b', truth: false },
      { judgmentId: 'c', truth: false },
    ];
    const report = calibrate(judgments, labels);
    expect(report.count).toBe(3);
    // Brier = ((0.95-1)^2 + (0.2-0)^2 + (0.9-0)^2) / 3
    expect(report.brier).toBeCloseTo((0.0025 + 0.04 + 0.81) / 3, 6);
    expect(report.bins).toHaveLength(10);
    expect(report.recommended.passThreshold).toBeGreaterThanOrEqual(0.2);
  });

  it('ignores labels without a judgment', () => {
    const report = calibrate([{ judgmentId: 'a', score: 0.5 }], [{ judgmentId: 'zzz', truth: true }]);
    expect(report.count).toBe(0);
    expect(report.ece).toBe(0);
  });
});

describe('calibration journal (R-K4a, R-K4c, R-K4d)', () => {
  it('R-K4a: appends every judgment to the calibration journal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibdd-cal-'));
    const path = join(dir, 'judgments.jsonl');
    const judge = createJudge({
      model: modelReturning([{ probability: 0.9, verdict: 'holds', explanation: '', observed: '' }]),
      config,
      journal: createCalibrationJournal(path),
    });
    await judge.judge(request());
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { score: number; verdict: string; samples: number; criterionHash: string };
    expect(record.score).toBeCloseTo(0.9, 5);
    expect(record.verdict).toBe('pass');
    expect(record.samples).toBe(3);
    expect(record.criterionHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('R-K4c: thresholds are configurable per run', async () => {
    const strict: JudgeConfig = { ...config, passThreshold: 0.97 };
    const judge = createJudge({ model: modelReturning([{ probability: 0.9, verdict: 'holds', explanation: '', observed: '' }]), config: strict });
    expect((await judge.judge(request())).verdict).toBe('inconclusive');
  });

  it('R-K4d: a too-close pair of thresholds is reported, not silently accepted', async () => {
    const close: JudgeConfig = { ...config, passThreshold: 0.6, failThreshold: 0.55 };
    const judge = createJudge({ model: modelReturning([{ probability: 0.57, verdict: 'holds', explanation: '', observed: '' }]), config: close });
    const verdict = await judge.judge(request());
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.reason).toMatch(/between the fail and pass thresholds/u);
  });
});
