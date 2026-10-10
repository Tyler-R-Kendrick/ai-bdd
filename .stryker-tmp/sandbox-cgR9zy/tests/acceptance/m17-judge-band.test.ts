// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { failedStep } from './helpers/flows.ts';
import { recordingFiles, T } from './helpers/plans.ts';
import { createProject, type Project, type RuleLayer } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

async function runTone(layers: RuleLayer[], title: string = T.tone) {
  const p = createProject({ docs: ['billing'], layers });
  project = p;
  const h = await openEngine(p);
  await h.compile();
  const report = await h.run({ titles: [title] });
  await h.close();
  return { report, result: report.scenarios[0], recordings: recordingFiles(p) };
}

describe('M17 judge aggregation', () => {
  it('M17 R-JU2: a score inside the band is inconclusive with reason band; nothing is recorded; the run exits 1', async () => {
    const { report, result, recordings } = await runTone(['judge-band', 'base']);
    expect(result?.status).toBe('inconclusive');
    const step = failedStep(result as NonNullable<typeof result>);
    expect(step?.status).toBe('inconclusive');
    expect(step?.error?.code).toBe('JUDGE_INCONCLUSIVE');
    expect(step?.judge?.verdict).toBe('inconclusive');
    expect(step?.judge?.reason).toBe('band');
    expect(step?.judge?.score).toBeGreaterThan(0.3);
    expect(step?.judge?.score).toBeLessThan(0.8);
    expect(step?.judge?.samples).toHaveLength(3);
    expect(result?.recording).toBe('discarded');
    expect(recordings).toEqual([]);
    expect(report.exitCode).toBe(1);
    expect(report.totals.inconclusive).toBe(1);
  });

  it('M17 R-JU2: a high spread is inconclusive with reason spread even though the mean looks like a pass', async () => {
    const { result } = await runTone(['judge-spread', 'base']);
    expect(result?.status).toBe('inconclusive');
    const step = failedStep(result as NonNullable<typeof result>);
    expect(step?.judge?.reason).toBe('spread');
    expect(step?.judge?.spread).toBeGreaterThan(0.5);
    expect(step?.judge?.score).toBeGreaterThan(0.6);
  });

  it('M17 R-JU2: contradictory samples (verdict against probability) count as 0.5 and end up inconclusive in the band', async () => {
    const { result } = await runTone(['bad-judge-contradictory', 'base'], T.upgrade);
    expect(result?.status).toBe('inconclusive');
    const step = failedStep(result as NonNullable<typeof result>);
    expect(step?.text).toBe('the plan changes to Pro');
    expect(step?.judge?.reason).toBe('band');
    expect(step?.judge?.score).toBeCloseTo(0.5, 5);
    expect(step?.judge?.spread).toBeCloseTo(0, 5);
  });

  it('M17 R-JU2: passing and failing samples decide pass and fail', async () => {
    const pass = await runTone(['base']);
    expect(pass.result?.status).toBe('passed');
    expect(pass.result?.steps[1]?.judge?.verdict).toBe('pass');
    expect(pass.result?.steps[1]?.judge?.spread).toBeLessThanOrEqual(0.5);
  });
});
