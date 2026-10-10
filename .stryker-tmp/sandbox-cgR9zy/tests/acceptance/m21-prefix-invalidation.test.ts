// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { countByPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { findScenario, recordingOf, T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M21 edit a step text after recordings exist', () => {
  it('M21 R-CH4 R-PL1: recording reuse is prefix-valid: earlier steps replay, the edited step and everything after it characterize, mode is mixed', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const plans1 = await h1.plans();
    const id = findScenario(plans1, T.upgrade).scenario.id;
    const stepsBefore = findScenario(plans1, T.upgrade).scenario.steps;
    expect((await h1.runScenario(id)).status).toBe('passed');
    await h1.close();
    const recordedBefore = recordingOf(p, id);
    expect(recordedBefore?.steps).toHaveLength(6);

    // the extraction rules now phrase the fourth step differently (same doc text, so the plan is rebuilt with --full)
    const h2 = await openEngine(p, { layers: ['edit-upgrade-step', 'base'] });
    await h2.compile({ full: true });
    const edited = findScenario(await h2.plans(), T.upgrade).scenario;
    expect(edited.id).toBe(id);
    expect(edited.steps[3]?.text).toBe('the plan changes to Pro immediately');
    expect(edited.steps.slice(0, 3).map((s) => s.key)).toEqual(stepsBefore.slice(0, 3).map((s) => s.key));
    expect(edited.steps[3]?.key).not.toBe(stepsBefore[3]?.key);

    const mark = h2.calls.length;
    const result = await h2.runScenario(id);
    const counts = countByPurpose(h2.callsSince(mark));
    await h2.close();
    expect(result.status).toBe('passed');
    expect(result.mode).toBe('mixed');
    expect(result.steps.map((s) => s.path)).toEqual(['replay', 'check', 'replay', 'check+judge', 'check+judge', 'check+judge']);
    expect(counts.act).toBe(0);
    expect(counts.checkgen).toBe(3);
    // the judge reuses verdicts for identical evidence: only the edited criterion asks the model again (3 samples)
    expect(counts.judge).toBeGreaterThanOrEqual(3);
    expect(counts.judge).toBeLessThanOrEqual(9);
    expect(result.steps[3]?.judge?.cached).toBe(false);
    expect(result.recording).toBe('updated');

    const recordedAfter = recordingOf(p, id);
    expect(recordedAfter?.steps).toHaveLength(6);
    expect(recordedAfter?.steps.slice(0, 3).map((s) => s.stepKey)).toEqual(recordedBefore?.steps.slice(0, 3).map((s) => s.stepKey));
    expect(recordedAfter?.steps[3]?.stepKey).not.toBe(recordedBefore?.steps[3]?.stepKey);
    expect(recordedAfter?.scenarioFingerprint).not.toBe(recordedBefore?.scenarioFingerprint);

    // and the next run is a pure replay again
    const h3 = await openEngine(p, { layers: ['edit-upgrade-step', 'base'] });
    const third = await h3.runScenario(id);
    expect(third.mode).toBe('replay');
    expect(third.status).toBe('passed');
    expect(h3.calls).toHaveLength(0);
    await h3.close();
  });

  it('M21 R-CH4: a driver major-version change invalidates the whole recording', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const id = findScenario(await h1.plans(), T.upgrade).scenario.id;
    await h1.runScenario(id);
    await h1.close();
    const rec = recordingOf(p, id);
    expect(rec?.driver.major).toBe(1);
    // tamper: pretend the recording was made by driver 0.x
    const { readRecordings } = await import('./helpers/plans.ts');
    const { writeFileSync } = await import('node:fs');
    const file = readRecordings(p).find((r) => r.recording.scenarioId === id);
    expect(file).toBeDefined();
    const tampered = { ...(file?.recording as object), driver: { id: 'fake', major: 0 } };
    writeFileSync(file?.path as string, `${JSON.stringify(tampered, null, 2)}\n`);

    const h2 = await openEngine(p);
    const result = await h2.runScenario(id);
    await h2.close();
    expect(result.mode).toBe('characterize');
    expect(result.status).toBe('passed');
    expect(result.recording).toBe('updated');
    expect(recordingOf(p, id)?.driver.major).toBe(1);
  });
});
