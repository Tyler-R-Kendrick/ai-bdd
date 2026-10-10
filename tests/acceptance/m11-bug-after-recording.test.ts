import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countByPurpose, ofPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { expectBugAfterRecording, failedStep, flowBugAfterRecording, type BugAfterRecording } from './helpers/flows.ts';
import { T, scenarioId } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M11 flag bug-upgrade-noop after recordings exist (fake driver)', () => {
  let res: BugAfterRecording;
  beforeAll(async () => {
    res = await flowBugAfterRecording(fakeTarget);
  });

  it('M11 R-AS4 R-CH1: the deterministic check fails with CHECK_FAILED and per-predicate actuals, with zero judge calls; --audit also runs the judge', () => {
    expectBugAfterRecording(res);
  });
});

describe('M11 --audit disagreement', () => {
  let project: Project | undefined;
  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it('M11 R-AS4: when the audit judge disagrees with a passing check the step fails with CHECK_JUDGE_DISAGREEMENT (path check+judge)', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const id = scenarioId(await h1.plans(), T.upgrade);
    expect((await h1.runScenario(id)).status).toBe('passed');
    await h1.close();

    const alwaysFails = {
      id: 'audit-judge-always-fails',
      purpose: 'judge',
      when: { criterion: { contains: 'the plan changes to Pro' } },
      respond: { samples: [{ probability: 0.02, verdict: 'fails', explanation: 'The judge disagrees.', observed: 'nothing' }] },
    };
    const h2 = await openEngine(p, { layers: [{ inline: [alwaysFails], name: 'audit-disagree' }, 'base'] });
    const plain = await h2.runScenario(id);
    expect(plain.status).toBe('passed');
    expect(ofPurpose(h2.calls, 'judge')).toHaveLength(0);
    const audited = await h2.runScenario(id, { audit: true });
    await h2.close();
    expect(audited.status).toBe('failed');
    const step = failedStep(audited);
    expect(step?.text).toBe('the plan changes to Pro');
    expect(step?.error?.code).toBe('CHECK_JUDGE_DISAGREEMENT');
    expect(step?.path).toBe('check+judge');
    expect(countByPurpose(h2.calls).act).toBe(0);
  });
});
