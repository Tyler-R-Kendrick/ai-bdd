import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countByPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { expectCharacterized, expectReplayed, flowUpgradeTwice, type UpgradeTwice } from './helpers/flows.ts';
import { T, recordingOf, scenarioId } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M5/M6 first run characterizes, second run replays (fake driver)', () => {
  let res: UpgradeTwice;
  beforeAll(async () => {
    res = await flowUpgradeTwice(fakeTarget);
  });

  it('M5 R-CH1 R-CH2 R-CH3 R-AS1: first run of Upgrade to Pro characterizes: agent acts, judge passes, discriminative change checks, confirm run passes, recording created, every step deterministic', () => {
    expectCharacterized(res);
  });

  it('M6 R-CH2 R-RN: second run replays with zero model calls', () => {
    expectReplayed(res);
  });

  it('M6 R-PL4: the recording file is deterministic and holds no timestamps', () => {
    const text = JSON.stringify(res.recording);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(res.recording?.schemaVersion).toBe(1);
    expect(res.recording?.scenarioId).toBe(res.id);
    expect(res.recording?.driver.id).toBe('fake');
    expect(res.recordingFiles).toHaveLength(1);
    expect(res.recordingFiles[0]?.endsWith('.json')).toBe(true);
  });
});

describe('M5 invariant checks', () => {
  let project: Project | undefined;
  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it('M5 R-AS1: a step with no preceding action is classified invariant, needs no false-on-before, and replays as a check', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const first = await h1.runScenario(T.upgradeVisible);
    const id = scenarioId(await h1.plans(), T.upgradeVisible);
    await h1.close();
    expect(first.status).toBe('passed');
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]?.path).toBe('check+judge');
    expect(first.steps[0]?.determinism).toBe('deterministic');
    const check = recordingOf(p, id)?.steps[0]?.check;
    expect(check?.classification).toBe('invariant');
    expect(check?.verified.beforeFalse).toBeNull();
    expect(check?.verified.afterTrue).toBe(true);
    expect(check?.verified.probeTrue).toBe(true);
    expect(check?.verified.judgePassed).toBe(true);

    const h2 = await openEngine(p);
    const second = await h2.runScenario(id);
    expect(second.mode).toBe('replay');
    expect(second.steps[0]?.path).toBe('check');
    expect(countByPurpose(h2.calls)).toEqual({ extract: 0, act: 0, checkgen: 0, judge: 0 });
    await h2.close();
  });
});
