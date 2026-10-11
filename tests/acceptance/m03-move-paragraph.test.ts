import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { findScenario, planFiles, readPlans, T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const P2 = 'Clicking the upgrade button opens a confirmation dialog. The confirmation dialog shows the prorated charge before anything is billed.';
const P3 = 'After the customer confirms, the plan changes to Pro and the invoice preview shows the prorated amount. A confirmation message appears once the upgrade is complete.';

describe('M3 move an unedited paragraph', () => {
  it('M3 R-PL2: moving a paragraph dirties no section, relocates the refs and makes zero model calls', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    await h1.close();
    const before = readPlans(p);
    const beforeFile = planFiles(p);
    const upgradeBefore = findScenario(before, T.upgrade).scenario;

    p.editDoc('billing', `${P2}\n\n${P3}`, `${P3}\n\n${P2}`);

    const h2 = await openEngine(p);
    const status = await h2.engine.status();
    expect(status.docs[0]?.dirtySections).toEqual([]);
    expect(status.docs[0]?.state).toBe('fresh');
    const compiled = await h2.compile();
    expect(compiled.usage.modelCalls).toBe(0);
    expect(compiled.docs[0]?.extractedSections).toEqual([]);
    expect(h2.calls).toHaveLength(0);
    await h2.close();

    const after = readPlans(p);
    const upgradeAfter = findScenario(after, T.upgrade).scenario;
    // ids, steps and fingerprints are unchanged ...
    expect(upgradeAfter.id).toBe(upgradeBefore.id);
    expect(upgradeAfter.fingerprint).toBe(upgradeBefore.fingerprint);
    expect(upgradeAfter.steps.map((s) => s.key)).toEqual(upgradeBefore.steps.map((s) => s.key));
    // ... the refs now point at the moved chunks: same hashes, new ids
    const doc = after[0];
    const refsBefore = upgradeBefore.steps.flatMap((s) => s.sources).map((r) => r.hash);
    const refsAfter = upgradeAfter.steps.flatMap((s) => s.sources);
    expect(refsAfter.map((r) => r.hash)).toEqual(refsBefore);
    for (const r of refsAfter) expect(doc?.chunks.find((c) => c.id === r.chunkId)?.hash, r.chunkId).toBe(r.hash);
    const clickStep = upgradeAfter.steps[0];
    const dialogChunk = doc?.chunks.find((c) => c.id === clickStep?.sources[0]?.chunkId);
    expect(dialogChunk?.excerpt.startsWith('Clicking the upgrade button')).toBe(true);
    expect(planFiles(p)['docs/billing.md.plan.json']).not.toBe(beforeFile['docs/billing.md.plan.json']);
  });
});
