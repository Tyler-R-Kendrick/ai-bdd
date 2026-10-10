import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from './helpers/engine.ts';
import { allScenarios, findFeature, findScenario, readPlans } from './helpers/plans.ts';
import { createProject, type Project } from './helpers/project.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe('M4 hallucination rules', () => {
  it('M4 R-EX2 R-FX1: a non-verbatim quote, an unknown handle, an uncited feature, a context-only source and an off-text fixture arg are dropped with the right diagnostics', async () => {
    const p = createProject({ docs: ['billing'], layers: ['bad-extract-hallucination', 'base'] });
    project = p;
    const h = await openEngine(p);
    const compiled = await h.compile();
    await h.close();
    expect(compiled.exitCode).toBe(0);
    const diagnostics = compiled.docs.flatMap((d) => d.diagnostics);
    const codes = new Set(diagnostics.map((d) => d.code));
    expect(codes.has('EXTRACT_QUOTE_NOT_FOUND')).toBe(true);
    expect(codes.has('EXTRACT_UNGROUNDED')).toBe(true);
    expect(codes.has('EXTRACT_FIXTURE_INVALID')).toBe(true);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const plans = readPlans(p);
    // the hallucinated features are not in the plan
    for (const title of ['Downgrade refunds the unused time', 'Downgrade exports invoices', 'Downgrade sends a survey', 'Free plan costs nothing']) {
      expect(findFeature(plans, title), title).toBeUndefined();
    }
    // inside the surviving feature: the ungrounded scenario is gone, the inheriting one stays
    const titles = allScenarios(plans)
      .filter((s) => s.feature.title === 'Downgrade from Pro')
      .map((s) => s.scenario.title);
    expect(titles).toEqual(['Downgrade goes through without unpaid invoices', 'Downgrade needs a hidden fixture', 'Downgrade stays on the billing page']);
    const inherited = findScenario(plans, 'Downgrade stays on the billing page').scenario;
    expect(inherited.sources.some((r) => r.relation === 'source')).toBe(true);

    // R-FX1: the fixture whose string arg is not in the step text is removed; the step still needs state
    const hidden = findScenario(plans, 'Downgrade needs a hidden fixture').scenario;
    const given = hidden.steps[0];
    expect(given?.kind).toBe('given');
    expect(given?.fixture).toBeUndefined();
    expect(given?.requiresState).toBe(true);
    // the well-formed fixture elsewhere in the corpus is untouched
    const allowed = findScenario(plans, 'Downgrade goes through without unpaid invoices').scenario;
    expect(allowed.steps[0]?.fixture).toEqual({ name: 'seedAccount', args: { plan: 'pro', unpaid: 0 } });

    // every remaining ref has a verbatim quote or no quote at all (validated by M1 with the real chunker); none points at c99
    for (const s of allScenarios(plans)) for (const r of s.scenario.sources) expect(r.chunkId).not.toContain('c99');
  });

  it('M4 R-EX2: a first schema-invalid answer is repaired by one retry; a second invalid answer fails the section and keeps the compile honest', async () => {
    const p = createProject({ docs: ['billing'], layers: ['bad-extract-schema-repair', 'base'] });
    project = p;
    const h = await openEngine(p);
    const compiled = await h.compile();
    const billing = compiled.docs[0];
    expect(billing?.failedSections.some((s) => s.includes('performance'))).toBe(true);
    expect(billing?.failedSections.some((s) => s.includes('tone'))).toBe(false);
    expect(compiled.exitCode).toBe(1);
    const diag = billing?.diagnostics ?? [];
    expect(diag.some((d) => d.code === 'EXTRACT_MODEL_OUTPUT_INVALID')).toBe(true);
    // tone: two extract calls (attempt 1 invalid, attempt 2 valid); performance: two invalid attempts
    const toneCalls = h.calls.filter((c) => String(c.request?.context?.['sectionAnchor']).includes('tone'));
    expect(toneCalls.map((c) => String(c.request?.context?.['attempt']))).toEqual(['1', '2']);
    const perfCalls = h.calls.filter((c) => String(c.request?.context?.['sectionAnchor']).includes('performance'));
    expect(perfCalls).toHaveLength(2);
    await h.close();
    expect(findFeature(readPlans(p), 'Friendly confirmation messages')).toBeDefined();
  });

  it('M4 R-EX3: an extraction that obeys the doc injection still cannot carry an off-catalog fixture; the scenario is blocked, never run', async () => {
    const p = createProject({ docs: ['release-notes'], layers: ['bad-extract-injection', 'base'] });
    project = p;
    const h = await openEngine(p);
    const compiled = await h.compile();
    expect(compiled.docs[0]?.diagnostics.some((d) => d.code === 'EXTRACT_FIXTURE_INVALID')).toBe(true);
    const plans = readPlans(p);
    const bad = findScenario(plans, 'Delete all users').scenario;
    expect(bad.steps[0]?.fixture).toBeUndefined();
    expect(bad.steps[0]?.requiresState).toBe(true);
    const result = await h.runScenario('Delete all users');
    await h.close();
    expect(result.status).toBe('blocked');
    expect(result.steps[0]?.error?.code).toBe('FIXTURE_REQUIRED');
    expect(result.steps.slice(1).every((s) => s.status === 'skipped')).toBe(true);
    expect(h.counts().act).toBe(0);
  });
});
