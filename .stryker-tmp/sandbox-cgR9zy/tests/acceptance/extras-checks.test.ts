// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { ofPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { failedStep, stepOf } from './helpers/flows.ts';
import { recordingOf, scenarioId, T } from './helpers/plans.ts';
import { createProject, type ConfigOverrides, type Project, type RuleLayer } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

async function upgradeWith(layers: RuleLayer[], overrides?: ConfigOverrides) {
  const p = createProject({ docs: ['billing'], layers });
  project = p;
  const h = await openEngine(p, overrides === undefined ? {} : { overrides });
  await h.compile();
  const id = scenarioId(await h.plans(), T.upgrade);
  const mark = h.calls.length;
  const result = await h.runScenario(id);
  const calls = h.callsSince(mark);
  await h.close();
  return { p, id, result, calls };
}

const checkgenFor = (calls: ReturnType<typeof ofPurpose>, text: string) => calls.filter((c) => String(c.request?.context?.['criterion']).includes(text));

describe('check generation validators (deliberately bad checkgen rules)', () => {
  it('R-AS1 R-CH3: a change check that is already true on the before state is non-discriminative on every attempt; the step falls back to the judge and is fuzzy', async () => {
    const { p, id, result, calls } = await upgradeWith(['bad-checkgen-non-discriminative', 'base']);
    expect(result.status).toBe('passed');
    const step = stepOf(result, 'the plan changes to Pro');
    expect(step.determinism).toBe('fuzzy');
    expect(step.fuzzyReasons).toContain('check-not-discriminative');
    expect(step.path).toBe('judge');
    // maxAttempts (3) attempts were made and fed back to the model
    const attempts = checkgenFor(ofPurpose(calls, 'checkgen'), 'the plan changes to Pro');
    expect(attempts.map((c) => String(c.request?.context?.['attempt']))).toEqual(['1', '2', '3']);
    // the other assertions are still deterministic
    expect(stepOf(result, 'an upgrade confirmation message appears').determinism).toBe('deterministic');
    const rec = recordingOf(p, id)?.steps[3];
    expect(rec?.determinism).toBe('fuzzy');
    expect(rec?.check).toBeUndefined();
    expect(rec?.fuzzyReasons).toContain('check-not-discriminative');
  });

  it('R-AS1 R-CH1: with checks.requireDeterministic a step without a program fails with CHECK_GENERATION_FAILED and nothing is recorded', async () => {
    const { p, id, result } = await upgradeWith(['bad-checkgen-non-discriminative', 'base'], { checks: { requireDeterministic: true } });
    expect(result.status).toBe('failed');
    expect(failedStep(result)?.error?.code).toBe('CHECK_GENERATION_FAILED');
    expect(result.recording).toBe('discarded');
    expect(recordingOf(p, id)).toBeUndefined();
  });

  it('R-AS1: a non-discriminative first attempt is retried with feedback and a correct second attempt is accepted', async () => {
    const { result, calls } = await upgradeWith(['bad-checkgen-retry', 'base']);
    expect(result.status).toBe('passed');
    const step = stepOf(result, 'the plan changes to Pro');
    expect(step.determinism).toBe('deterministic');
    expect(step.path).toBe('check+judge');
    const attempts = checkgenFor(ofPurpose(calls, 'checkgen'), 'the plan changes to Pro');
    expect(attempts.map((c) => String(c.request?.context?.['attempt']))).toEqual(['1', '2']);
    // the second request carries the first attempt's rejection
    expect(JSON.stringify(attempts[1]?.request?.messages ?? []).toLowerCase()).toMatch(/discriminat|before/);
  });

  it('R-AS2 R-CH3: a literal date that is neither in the step text nor a param is rejected as volatile on every attempt (volatile-content)', async () => {
    const { result } = await upgradeWith(['bad-checkgen-volatile-literal', 'base']);
    expect(result.status).toBe('passed');
    const step = stepOf(result, 'the invoice preview shows the prorated amount');
    expect(step.determinism).toBe('fuzzy');
    expect(step.fuzzyReasons).toContain('volatile-content');
    expect(step.path).toBe('judge');
  });
});
