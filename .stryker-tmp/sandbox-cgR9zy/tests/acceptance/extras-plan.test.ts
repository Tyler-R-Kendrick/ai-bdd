// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { ofPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { findFeature, findScenario, planFiles, readPlans, T } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('plan lifecycle extras', () => {
  it('R-PL1: a changed fingerprint resets the review state of that scenario only; unchanged scenarios keep theirs', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const plans = await h1.plans();
    const feature = findFeature(plans, 'Upgrade to Pro');
    await h1.engine.review(feature?.id ?? '', 'accept');
    await h1.close();
    expect(findScenario(readPlans(p), T.upgrade).scenario.review).toBe('accepted');

    const h2 = await openEngine(p, { layers: ['edit-upgrade-step', 'base'] });
    await h2.compile({ full: true });
    await h2.close();
    const after = readPlans(p);
    expect(findScenario(after, T.upgrade).scenario.review).toBe('unreviewed');
    expect(findScenario(after, T.upgrade).scenario.id).toBe(findScenario(plans, T.upgrade).scenario.id);
    expect(findScenario(after, T.upgradeVisible).scenario.review).toBe('accepted');
  });

  it('R-PL3 R-PL2: a pinned feature survives a recompile of its edited section verbatim, with PLAN_PINNED_STALE and the feature listed as stale', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    const pinned = findFeature(await h1.plans(), 'Downgrade from Pro');
    await h1.engine.review(pinned?.id ?? '', 'pin');
    await h1.close();
    expect(findFeature(readPlans(p), 'Downgrade from Pro')?.pinned).toBe(true);
    const pinnedBefore = findFeature(readPlans(p), 'Downgrade from Pro');

    p.editDoc('billing', 'the plan changes to Free and a confirmation message appears.', 'the plan changes to Free and a confirmation message appears. No dialog is shown.');
    const h2 = await openEngine(p);
    const compiled = await h2.compile();
    expect(compiled.docs[0]?.diagnostics.map((d) => d.code)).toContain('PLAN_PINNED_STALE');
    const status = await h2.engine.status();
    expect(status.docs[0]?.state).toBe('stale');
    expect(status.docs[0]?.staleFeatures).toContain(pinned?.id);
    await h2.close();
    expect(findFeature(readPlans(p), 'Downgrade from Pro')).toEqual(pinnedBefore);
  });

  it('R-PL2: editing a context section (Overview/Glossary) never dirties a section and makes no model call', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h1 = await openEngine(p);
    await h1.compile();
    await h1.close();
    p.editDoc('billing', 'The Free plan costs nothing and the Pro plan is billed monthly.', 'The Free plan costs nothing and the Pro plan is billed every month.');
    const h2 = await openEngine(p);
    const status = await h2.engine.status();
    expect(status.docs[0]?.dirtySections).toEqual([]);
    expect(status.docs[0]?.state).toBe('fresh');
    const compiled = await h2.compile();
    expect(compiled.usage.modelCalls).toBe(0);
    expect(ofPurpose(h2.calls, 'extract')).toHaveLength(0);
    await h2.close();
  });

  it('R-CH3: a `fuzzy` directive on a section makes every step sourced from it fuzzy; the scenario carries the @fuzzy tag and is judged on every run', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    p.editDoc('billing', '## Tone\n\n', '## Tone\n\n<!-- ai-bdd: fuzzy -->\n\n');
    const h1 = await openEngine(p);
    await h1.compile();
    const scenario = findScenario(await h1.plans(), T.tone).scenario;
    expect(scenario.tags).toContain('@fuzzy');
    const first = await h1.runScenario(T.tone);
    await h1.close();
    expect(first.status).toBe('passed');
    expect(first.steps.map((s) => s.determinism)).toEqual(['fuzzy', 'fuzzy']);
    expect(first.steps[0]?.fuzzyReasons).toContain('directive');
    expect(first.steps[0]?.path).toBe('agent');

    const h2 = await openEngine(p);
    const second = await h2.runScenario(T.tone);
    await h2.close();
    expect(second.status).toBe('passed');
    expect(second.steps.map((s) => s.path)).toEqual(['agent', 'judge']);
  });

  it('R-PL4: unchanged inputs give byte-identical plans across independent projects (no timestamps, sorted keys, LF)', async () => {
    const a = createProject({ docs: ['todos', 'checkout'] });
    const b = createProject({ docs: ['todos', 'checkout'] });
    try {
      for (const p of [a, b]) {
        const h = await openEngine(p);
        await h.compile();
        await h.close();
      }
      expect(planFiles(a)).toEqual(planFiles(b));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
