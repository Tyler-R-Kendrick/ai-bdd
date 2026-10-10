// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { ofPurpose } from './helpers/calls.ts';
import { findFeature, findScenario, planFiles, readPlans, T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M2 edit one paragraph', () => {
  it('M2 R-PL1 R-PL2 R-EX1: editing one Downgrading paragraph re-extracts only that section; other features are byte-identical; ids and review states survive', async () => {
    const p = createProject();
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const plans1 = await h1.plans();
    const allowed = findScenario(plans1, T.allowed);
    await h1.engine.review(allowed.scenario.id, 'accept');
    await h1.close();
    const planFilesBefore = planFiles(p);
    const before = readPlans(p);
    expect(findScenario(before, T.allowed).scenario.review).toBe('accepted');

    // the edit keeps every quoted phrase intact, so the same extraction output stays grounded
    p.editDoc('billing', 'the plan changes to Free and a confirmation message appears.', 'the plan changes to Free and a confirmation message appears. No dialog is shown.');

    const h2 = await openEngine(p);
    const status = await h2.engine.status();
    const billingStatus = status.docs.find((d) => d.docUri === 'docs/billing.md');
    expect(billingStatus?.state).toBe('stale');
    expect(billingStatus?.dirtySections.length).toBe(1);
    expect(billingStatus?.dirtySections[0]).toContain('downgrading');
    expect(status.docs.filter((d) => d.docUri !== 'docs/billing.md').every((d) => d.state === 'fresh')).toBe(true);

    const compiled = await h2.compile();
    const extractCalls = ofPurpose(h2.calls, 'extract');
    expect(extractCalls).toHaveLength(1);
    expect(String(extractCalls[0]?.request?.context?.['sectionAnchor'])).toContain('downgrading');
    expect(compiled.usage.modelCalls).toBe(1);
    expect(compiled.docs.find((d) => d.docUri === 'docs/billing.md')?.extractedSections).toHaveLength(1);
    await h2.close();

    const after = readPlans(p);
    // other documents: byte-identical files
    const filesAfter = planFiles(p);
    for (const [name, text] of Object.entries(planFilesBefore)) if (name !== 'docs/billing.md.plan.json') expect(filesAfter[name], name).toBe(text);
    expect(filesAfter['docs/billing.md.plan.json']).not.toBe(planFilesBefore['docs/billing.md.plan.json']);
    // other sections of billing.md: features unchanged
    const billingBefore = before.find((x) => x.docUri === 'docs/billing.md');
    const billingAfter = after.find((x) => x.docUri === 'docs/billing.md');
    for (const f of billingBefore?.features ?? []) {
      if (f.sectionId.includes('downgrading')) continue;
      expect(billingAfter?.features.find((x) => x.id === f.id), f.id).toEqual(f);
    }
    // the re-extracted feature keeps ids; unchanged fingerprints keep their review state
    const f1 = findFeature(before, 'Downgrade from Pro');
    const f2 = findFeature(after, 'Downgrade from Pro');
    expect(f2?.id).toBe(f1?.id);
    expect(f2?.scenarios.map((s) => s.id)).toEqual(f1?.scenarios.map((s) => s.id));
    expect(f2?.scenarios.map((s) => s.fingerprint)).toEqual(f1?.scenarios.map((s) => s.fingerprint));
    expect(findScenario(after, T.allowed).scenario.review).toBe('accepted');
    expect(findScenario(after, T.blocked).scenario.review).toBe('unreviewed');
    // refs of the re-extracted section point at the new chunk hash
    const edited = billingAfter?.chunks.find((c) => c.excerpt.startsWith('When the account has no unpaid invoices'));
    const refHashes = f2?.scenarios.find((s) => s.title === T.allowed)?.sources.map((r) => r.hash);
    expect(refHashes).toContain(edited?.hash);
  });
});
