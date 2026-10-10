import { afterEach, describe, expect, it } from 'vitest';
import { countByPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { T, recordingOf, scenarioId } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M8 subjective Tone criterion', () => {
  it('M8 R-CH3 R-JU2: the Tone assertion is fuzzy (subjective) and the judge runs on every run; no check is ever generated', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const plans = await h1.plans();
    const id = scenarioId(plans, T.tone);
    const feature = plans.flatMap((x) => x.features).find((f) => f.scenarios.some((s) => s.id === id));
    expect(feature?.scenarios[0]?.steps[1]?.nature).toBe('subjective');
    const mark = h1.calls.length;
    const first = await h1.runScenario(id);
    const firstCounts = countByPurpose(h1.callsSince(mark));
    await h1.close();

    expect(first.status).toBe('passed');
    expect(first.steps[0]?.determinism).toBe('deterministic');
    expect(first.steps[0]?.path).toBe('agent');
    const then = first.steps[1];
    expect(then?.determinism).toBe('fuzzy');
    expect(then?.fuzzyReasons).toEqual(['subjective']);
    expect(then?.path).toBe('judge');
    expect(then?.judge?.verdict).toBe('pass');
    expect(then?.judge?.score).toBeGreaterThanOrEqual(0.8);
    expect(firstCounts.checkgen).toBe(0);
    expect(firstCounts.judge).toBe(3);
    const rec = recordingOf(p, id);
    expect(rec?.steps[1]?.determinism).toBe('fuzzy');
    expect(rec?.steps[1]?.fuzzyReasons).toEqual(['subjective']);
    expect(rec?.steps[1]?.check).toBeUndefined();

    const h2 = await openEngine(p);
    const second = await h2.runScenario(id);
    const counts = countByPurpose(h2.calls);
    await h2.close();
    expect(second.status).toBe('passed');
    expect(second.mode).toBe('replay');
    expect(second.steps.map((s) => s.path)).toEqual(['replay', 'judge']);
    expect(second.steps[1]?.judge?.verdict).toBe('pass');
    expect(counts.act).toBe(0);
    expect(counts.checkgen).toBe(0);
  });
});
