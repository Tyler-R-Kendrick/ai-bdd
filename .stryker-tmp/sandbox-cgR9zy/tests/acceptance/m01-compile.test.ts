// @ts-nocheck
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createChunker, normalizeForQuote, sha256Hex, stableJson } from '@ai-bdd/sdk';
import type { ChunkRef, DocPlan, JsonValue } from '@ai-bdd/sdk/contracts';
import { countByPurpose } from './helpers/calls.ts';
import { openEngine } from './helpers/engine.ts';
import { allScenarios, planFiles, readPlans } from './helpers/plans.ts';
import { ALL_DOCS, createProject, type Project } from './helpers/project.ts';

const golden = JSON.parse(readFileSync(new URL('./golden/uncovered.json', import.meta.url), 'utf8')) as Record<string, { uncovered: string[]; notTestable: string[] }>;

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

function refsOf(plan: DocPlan): ChunkRef[] {
  return plan.features.flatMap((f) => [...f.sources, ...f.scenarios.flatMap((s) => [...s.sources, ...s.steps.flatMap((st) => st.sources)])]);
}

describe('M1 compile the corpus', () => {
  it('M1 R-EX1 R-EX2 R-EX4 R-PL4: plans are written with verbatim quotes, notTestable and the golden uncovered list; a second compile makes zero model calls and is byte-identical', async () => {
    const p = createProject();
    project = p;

    const h1 = await openEngine(p);
    const compiled = await h1.compile();
    expect(compiled.exitCode).toBe(0);
    expect(compiled.docs.map((d) => d.docUri).sort()).toEqual(ALL_DOCS.map((d) => `docs/${d}.md`).sort());
    expect(compiled.docs.every((d) => d.failedSections.length === 0)).toBe(true);
    expect(compiled.docs.flatMap((d) => d.diagnostics).filter((d) => d.severity === 'error')).toEqual([]);
    const firstCounts = h1.counts();
    expect(firstCounts.extract).toBeGreaterThan(0);
    expect(firstCounts.act + firstCounts.checkgen + firstCounts.judge).toBe(0);
    await h1.close();

    // R-SDK1: plans are plain committed JSON read synchronously
    const plans = readPlans(p);
    expect(plans.map((x) => x.docUri)).toEqual(ALL_DOCS.map((d) => `docs/${d}.md`).sort());
    for (const plan of plans) expect(plan.features.length, plan.docUri).toBeGreaterThan(0);

    // every feature and scenario is grounded, every quote is verbatim in the chunk it cites (checked with the real chunker)
    const chunker = createChunker();
    for (const plan of plans) {
      const text = readFileSync(p.path(plan.docUri), 'utf8');
      const chunked = chunker.chunk({ uri: plan.docUri, absolutePath: p.path(plan.docUri), text, sha256: sha256Hex(text) }, { sectionDepth: 2, maxSectionChars: 12000 });
      const byId = new Map(chunked.chunks.map((c) => [c.id, c] as const));
      for (const f of plan.features) {
        expect(f.sources.filter((r) => r.relation === 'source').length, `${f.id} has a source`).toBeGreaterThan(0);
        for (const s of f.scenarios) expect(s.sources.filter((r) => r.relation === 'source').length, `${s.id} has a source`).toBeGreaterThan(0);
      }
      for (const ref of refsOf(plan)) {
        const chunk = byId.get(ref.chunkId);
        expect(chunk, `${plan.docUri}: ref to unknown chunk ${ref.chunkId}`).toBeDefined();
        expect(ref.hash).toBe(chunk?.hash);
        if (ref.relation === 'source' && ref.quote !== undefined) {
          expect(normalizeForQuote(chunk?.text ?? '').includes(normalizeForQuote(ref.quote)), `${ref.chunkId}: "${ref.quote}"`).toBe(true);
        }
      }
    }

    // inferred steps are marked as such, quoted steps carry a source
    const steps = allScenarios(plans).flatMap((s) => s.scenario.steps);
    expect(steps.some((s) => s.grounding === 'inferred')).toBe(true);
    for (const s of steps) if (s.grounding === 'quoted') expect(s.sources.some((r) => r.relation === 'source')).toBe(true);

    // coverage (R-EX4): notTestable and uncovered match the golden lists
    for (const plan of plans) {
      const excerpt = (id: string): string => plan.chunks.find((c) => c.id === id)?.excerpt ?? `?${id}`;
      const expected = golden[plan.docUri] ?? { uncovered: [], notTestable: [] };
      const uncovered = plan.uncovered.map(excerpt).map((e) => expected.uncovered.find((x) => e.startsWith(x)) ?? `UNEXPECTED ${e}`);
      expect(uncovered.sort(), `${plan.docUri} uncovered`).toEqual([...expected.uncovered].sort());
      const notTestable = plan.notTestable.map((n) => excerpt(n.chunkId)).map((e) => expected.notTestable.find((x) => e.startsWith(x)) ?? `UNEXPECTED ${e}`);
      expect(notTestable.sort(), `${plan.docUri} notTestable`).toEqual([...expected.notTestable].sort());
      for (const n of plan.notTestable) expect(n.reason.length).toBeGreaterThan(0);
    }
    const billing = plans.find((x) => x.docUri === 'docs/billing.md') as DocPlan;
    expect(billing.notTestable.map((n) => billing.chunks.find((c) => c.id === n.chunkId)?.excerpt ?? '')[0]).toMatch(/p95 latency under 200 ms/);
    // context sections never appear as sources or in coverage lists
    const contextIds = billing.chunks.filter((c) => /^(Overview|Glossary|Acme offers two plans|Plan: the subscription)/.test(c.excerpt)).map((c) => c.id);
    expect(contextIds.length).toBeGreaterThanOrEqual(4);
    for (const id of contextIds) {
      expect(billing.uncovered).not.toContain(id);
      expect(refsOf(billing).filter((r) => r.relation === 'source').map((r) => r.chunkId)).not.toContain(id);
    }

    // R-PL4: deterministic, stableJson, LF, no timestamps
    const before = planFiles(p);
    expect(Object.keys(before).sort()).toEqual(ALL_DOCS.map((d) => `docs/${d}.md.plan.json`).sort());
    for (const text of Object.values(before)) {
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain('\r');
      expect(stableJson(JSON.parse(text) as JsonValue)).toBe(text);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }

    // R-EX1: nothing changed -> zero model calls, byte-identical plans, status fresh
    const h2 = await openEngine(p);
    const status = await h2.engine.status();
    expect(status.docs.map((d) => d.state)).toEqual(ALL_DOCS.map(() => 'fresh'));
    const again = await h2.compile();
    expect(again.usage.modelCalls).toBe(0);
    expect(again.docs.every((d) => d.extractedSections.length === 0)).toBe(true);
    expect(again.exitCode).toBe(0);
    expect(countByPurpose(h2.calls)).toEqual({ extract: 0, act: 0, checkgen: 0, judge: 0 });
    expect(h2.calls).toHaveLength(0);
    await h2.close();
    expect(planFiles(p)).toEqual(before);
  });

  it('M1 R-EX4: every billing scenario and feature is reachable from the traceability data (scenario ids are stable slugs of docUri and titles)', async () => {
    const p = createProject({ docs: ['billing'] });
    project = p;
    const h = await openEngine(p);
    await h.compile();
    await h.close();
    const plans = readPlans(p);
    const ids = allScenarios(plans).map((s) => s.scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of allScenarios(plans)) {
      expect(s.feature.id.startsWith('docs-billing--')).toBe(true);
      expect(s.scenario.id.startsWith(`${s.feature.id}/`)).toBe(true);
      expect(s.scenario.review).toBe('unreviewed');
      expect(s.scenario.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(allScenarios(plans).map((s) => s.scenario.title)).toEqual([
      'Upgrade from Free to Pro',
      'Upgrade button is visible on the Free plan',
      'Downgrade is blocked with unpaid invoices',
      'Downgrade goes through without unpaid invoices',
      'Friendly confirmation after upgrading',
    ]);
  });
});
