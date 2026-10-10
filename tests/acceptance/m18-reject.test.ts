import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { allScenarios, findScenario, readPlans, T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M18 reject a scenario', () => {
  it('M18 R-EX5 R-PL1: a rejected scenario is remembered by fingerprint, is not re-proposed by compile --full and never runs', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const before = findScenario(await h1.plans(), T.blocked).scenario;
    const keptId = findScenario(await h1.plans(), T.allowed).scenario.id;
    await h1.engine.review(before.id, 'reject');
    await h1.close();

    const afterReject = readPlans(p)[0];
    expect(afterReject?.rejected.find((r) => r.title === T.blocked)?.fingerprint).toBe(before.fingerprint);
    expect(findScenario(readPlans(p), T.blocked).scenario.review).toBe('rejected');
    // rejecting uncovers the sources immediately
    expect(afterReject?.uncovered.length).toBeGreaterThan(0);

    const h2 = await openEngine(p);
    const compiled = await h2.compile({ full: true });
    expect(compiled.docs[0]?.extractedSections.length).toBeGreaterThan(0);
    const plans = await h2.plans();
    expect(allScenarios(plans).filter((s) => s.scenario.title === T.blocked && s.scenario.review !== 'rejected')).toEqual([]);
    expect(plans[0]?.rejected.map((r) => r.title)).toContain(T.blocked);
    // the sibling scenario keeps its id
    expect(findScenario(plans, T.allowed).scenario.id).toBe(keptId);
    // rejected scenarios are never selected
    expect((await h2.engine.listScenarios({ grep: 'unpaid invoices' })).map((t) => t.scenario.title)).not.toContain(T.blocked);
    const report = await h2.run({ grep: 'Downgrade is blocked' });
    expect(report.scenarios).toHaveLength(0);
    await h2.close();
  });
});
