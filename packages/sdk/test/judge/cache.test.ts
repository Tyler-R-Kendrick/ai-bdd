import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JudgeRequest } from '../../src/contracts/index.ts';
import { createJudge } from '../../src/judge/index.ts';
import { ScriptedJudgeModel, fails, holds, makeConfig, makeRequest, png } from './doubles.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-bdd-judge-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async (): Promise<Record<string, unknown>[]> =>
  (await readFile(join(dir, 'judgments.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('judge reuse and judgments log', () => {
  it('R-JU2: identical inputs reuse the cached verdict with cached:true and no model calls', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    const judge = createJudge({ model, config: makeConfig(), cacheDir: dir });
    const first = await judge.judge(makeRequest());
    expect(first.cached).toBe(false);
    expect(model.requests.length).toBe(3);
    const second = await judge.judge(makeRequest());
    expect(model.requests.length).toBe(3);
    expect(second.cached).toBe(true);
    expect(second.verdict).toBe(first.verdict);
    expect(second.score).toBe(first.score);
    expect(second.samples).toEqual(first.samples);
    expect(second.usage).toEqual({ modelCalls: 0, inputTokens: 0, outputTokens: 0 });
    const files = await readdir(join(dir, 'judge'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('R-JU2: the cache survives a new judge instance (separate process analogue)', async () => {
    const m1 = new ScriptedJudgeModel('judge-model', [fails()]);
    const a = await createJudge({ model: m1, config: makeConfig(), cacheDir: dir }).judge(makeRequest());
    const m2 = new ScriptedJudgeModel('judge-model', [holds()]);
    const b = await createJudge({ model: m2, config: makeConfig(), cacheDir: dir }).judge(makeRequest());
    expect(m2.requests.length).toBe(0);
    expect(b.cached).toBe(true);
    expect(b.verdict).toBe(a.verdict);
    expect(b.verdict).toBe('fail');
  });

  const variants: [string, (r: JudgeRequest) => JudgeRequest][] = [
    ['criterion', (r) => ({ ...r, criterion: r.criterion + ' ' })],
    ['params', (r) => ({ ...r, params: { plan: 'Team' } })],
    ['before tree', (r) => ({ ...r, before: { treeText: r.before.treeText + '\n- text "x"' } })],
    ['after tree', (r) => ({ ...r, after: { treeText: r.after.treeText + ' ' } })],
    ['after screenshot', (r) => ({ ...r, after: { ...r.after, screenshot: png(9) } })],
    ['before screenshot', (r) => ({ ...r, before: { ...r.before, screenshot: png(9) } })],
    ['actionPreceded', (r) => ({ ...r, actionPreceded: !r.actionPreceded })],
    ['appContext', (r) => ({ ...r, appContext: r.appContext + '.' })],
  ];
  for (const [name, mutate] of variants) {
    it(`R-JU2: reuse only on byte-identical inputs: changed ${name} misses the cache`, async () => {
      const model = new ScriptedJudgeModel('judge-model', [holds()]);
      const judge = createJudge({ model, config: makeConfig(), cacheDir: dir });
      await judge.judge(makeRequest());
      const v = await judge.judge(mutate(makeRequest()));
      expect(v.cached).toBe(false);
      expect(model.requests.length).toBe(6);
    });
  }

  it('R-JU2: a different judge model id misses the cache', async () => {
    await createJudge({ model: new ScriptedJudgeModel('judge-a', [holds()]), config: makeConfig(), cacheDir: dir }).judge(makeRequest());
    const other = new ScriptedJudgeModel('judge-b', [holds()]);
    const v = await createJudge({ model: other, config: makeConfig(), cacheDir: dir }).judge(makeRequest());
    expect(v.cached).toBe(false);
    expect(other.requests.length).toBe(3);
  });

  it('R-JU2: thresholds are applied on reuse, so a stricter config re-aggregates cached samples', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds(0.85)]);
    const first = await createJudge({ model, config: makeConfig(), cacheDir: dir }).judge(makeRequest());
    expect(first.verdict).toBe('pass');
    const strict = await createJudge({ model, config: makeConfig({ passThreshold: 0.95 }), cacheDir: dir }).judge(makeRequest());
    expect(strict.cached).toBe(true);
    expect(strict.verdict).toBe('inconclusive');
    expect(model.requests.length).toBe(3);
  });

  it('R-JU2: a changed sample count invalidates the cached entry', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    await createJudge({ model, config: makeConfig({ samples: 3 }), cacheDir: dir }).judge(makeRequest());
    const v = await createJudge({ model, config: makeConfig({ samples: 1 }), cacheDir: dir }).judge(makeRequest());
    expect(v.cached).toBe(false);
    expect(model.requests.length).toBe(4);
  });

  it('R-JU2: a corrupt cache file is ignored and rewritten', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    const judge = createJudge({ model, config: makeConfig(), cacheDir: dir });
    await judge.judge(makeRequest());
    const [file] = await readdir(join(dir, 'judge'));
    await writeFile(join(dir, 'judge', file as string), '{ not json');
    const v = await judge.judge(makeRequest());
    expect(v.cached).toBe(false);
    expect(model.requests.length).toBe(6);
    const again = await judge.judge(makeRequest());
    expect(again.cached).toBe(true);
  });

  it('R-JU2: inconclusive verdicts are not reused', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds(0.6)]);
    const judge = createJudge({ model, config: makeConfig(), cacheDir: dir });
    const a = await judge.judge(makeRequest());
    expect(a.verdict).toBe('inconclusive');
    const b = await judge.judge(makeRequest());
    expect(b.cached).toBe(false);
    expect(model.requests.length).toBe(6);
  });

  it('R-JU2: every judgment (fresh and cached) is appended to judgments.jsonl', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds()], { inputTokens: 10, outputTokens: 2 });
    const judge = createJudge({ model, config: makeConfig(), cacheDir: dir });
    await judge.judge(makeRequest());
    await judge.judge(makeRequest());
    await judge.judge(makeRequest({ criterion: 'something else' }));
    const rows = await lines();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.cached)).toEqual([false, true, false]);
    expect(rows[0]?.verdict).toBe('pass');
    expect(rows[0]?.criterion).toBe(makeRequest().criterion);
    expect(rows[0]?.promptVersion).toBe('judge-v1');
    expect(rows[0]?.key).toBe(rows[1]?.key);
    expect(rows[0]?.key).not.toBe(rows[2]?.key);
    expect(rows[0]?.samples).toHaveLength(3);
    expect(rows[0]?.usage).toEqual({ modelCalls: 3, inputTokens: 30, outputTokens: 6 });
  });

  it('R-JU2: cacheDir null disables both the verdict cache and the judgments log', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds()]);
    const judge = createJudge({ model, config: makeConfig(), cacheDir: null });
    const a = await judge.judge(makeRequest());
    const b = await judge.judge(makeRequest());
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(model.requests.length).toBe(6);
    expect(await readdir(dir)).toEqual([]);
  });

  it('R-JU2: usage is summed across samples including token counts', async () => {
    const model = new ScriptedJudgeModel('judge-model', [holds()], { inputTokens: 1234, outputTokens: 56 });
    const v = await createJudge({ model, config: makeConfig({ samples: 4 }), cacheDir: null }).judge(makeRequest());
    expect(v.usage).toEqual({ modelCalls: 4, inputTokens: 4936, outputTokens: 224 });
  });
});
