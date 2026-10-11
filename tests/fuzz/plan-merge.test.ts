import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPlanner, stableJson } from '@ai-bdd/sdk';
import type { ChunkedDoc, DocPlan, DraftFeature, ExtractionResult, JsonValue, ResolvedConfig, StepKind } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { hostileString, jsonEqual, params } from './helpers.ts';
import { META, buildDoc, feature, ref, result, scenario, step } from '../../packages/sdk/test/plan/fixtures.ts';
import { parseDocPlan } from '../../packages/sdk/src/plan/schema.ts';

const planner = createPlanner({} as ResolvedConfig);
const text = (p: DocPlan): string => stableJson(p as unknown as JsonValue);

// ───────────────────────── generators

const word = fc.stringMatching(/^[a-z]{3,9}$/);
const label = fc.oneof({ weight: 4, arbitrary: fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(' ')) }, { weight: 1, arbitrary: hostileString({ maxLength: 24 }) });
const kind = fc.constantFrom<StepKind>('given', 'when', 'then');

interface DraftSpec {
  title: string;
  /** indexes into the section's paragraphs; never empty */
  sources: number[];
  scenarios: { title: string; steps: { kind: StepKind; text: string; sources: number[] }[]; sources: number[] }[];
}
interface SectionCase { title: string; paras: string[]; drafts: DraftSpec[] }

function sectionCase(index: number): fc.Arbitrary<SectionCase> {
  return fc.integer({ min: 1, max: 4 }).chain((paraCount) => {
    const paraIdx = fc.array(fc.integer({ min: 0, max: paraCount - 1 }), { minLength: 1, maxLength: 3 });
    const draft: fc.Arbitrary<DraftSpec> = fc.record({
      title: label,
      sources: paraIdx,
      scenarios: fc.array(
        fc.record({ title: label, sources: paraIdx, steps: fc.array(fc.record({ kind, text: label, sources: fc.array(fc.integer({ min: 0, max: paraCount - 1 }), { maxLength: 2 }) }), { minLength: 1, maxLength: 4 }) }),
        { minLength: 1, maxLength: 3 },
      ),
    });
    return fc.array(draft, { minLength: 0, maxLength: 3 }).map((drafts) => ({
      title: `Topic ${index}`,
      paras: Array.from({ length: paraCount }, (_, i) => `Section ${index} paragraph ${i} states behaviour number ${index * 17 + i}.`),
      drafts,
    }));
  });
}

const cases = fc.integer({ min: 1, max: 4 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => sectionCase(i))));

function build(sections: readonly SectionCase[]): { doc: ChunkedDoc; extracted: ExtractionResult[] } {
  const doc = buildDoc('docs/fuzz.md', sections.map((s) => ({ title: s.title, paras: s.paras })));
  const extracted = sections.map((s, si) => {
    const refs = (idxs: number[]) => [...new Set(idxs)].map((i) => ref(doc, s.paras[i] as string));
    const drafts: DraftFeature[] = s.drafts.map((d) =>
      feature(
        d.title,
        refs(d.sources),
        d.scenarios.map((sc) => scenario(sc.title, sc.steps.map((st) => step(st.kind, st.text, refs(st.sources))), refs(sc.sources))),
      ),
    );
    return result(doc.sections[si]?.id ?? '', drafts);
  });
  return { doc, extracted };
}

const toMap = (list: readonly ExtractionResult[]): Map<string, ExtractionResult> => new Map(list.map((r) => [r.sectionId, r]));

function ids(plan: DocPlan): string[] {
  return plan.features.flatMap((f) => [f.id, ...f.scenarios.map((s) => s.id)]);
}

function permute<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let x = (seed >>> 0) || 1;
  for (let i = a.length - 1; i > 0; i -= 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// ───────────────────────── merge

describe('fuzz: planner.merge', () => {
  it('produces a schema-valid plan whose ids are unique and whose refs all point into the document', () => {
    fc.assert(
      fc.property(cases, (sections) => {
        const { doc, extracted } = build(sections);
        const m = planner.merge(doc, null, toMap(extracted), META);
        const parsed = parseDocPlan(JSON.parse(text(m.plan)));
        expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
        const all = ids(m.plan);
        expect(new Set(all).size).toBe(all.length);
        const chunkIds = new Set(doc.chunks.map((c) => c.id));
        for (const f of m.plan.features) {
          expect(f.docUri).toBe(doc.doc.uri);
          for (const s of f.scenarios) {
            expect(s.featureId).toBe(f.id);
            expect(s.id.startsWith(`${f.id}/`)).toBe(true);
            for (const r of [...s.sources, ...s.steps.flatMap((x) => x.sources)]) expect(chunkIds.has(r.chunkId)).toBe(true);
            // step keys are unique within a scenario
            expect(new Set(s.steps.map((x) => x.key)).size).toBe(s.steps.length);
          }
          for (const r of f.sources) expect(chunkIds.has(r.chunkId)).toBe(true);
        }
        expect(m.plan.sections.map((s) => s.id)).toEqual(doc.sections.map((s) => s.id));
        // the change report names exactly the features and scenarios that exist now
        expect([...m.added].sort()).toEqual([...all].sort());
        expect(m.updated).toEqual([]);
        expect(m.removed).toEqual([]);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('is idempotent: merging the same extraction again (or nothing) onto its own result changes nothing', () => {
    fc.assert(
      fc.property(cases, (sections) => {
        const { doc, extracted } = build(sections);
        const first = planner.merge(doc, null, toMap(extracted), META).plan;
        const again = planner.merge(doc, first, toMap(extracted), META);
        expect(text(again.plan)).toBe(text(first));
        expect(again.updated).toEqual([]);
        expect(again.removed).toEqual([]);
        const quiet = planner.merge(doc, first, new Map(), META);
        expect(text(quiet.plan)).toBe(text(first));
        expect([quiet.added, quiet.updated, quiet.removed]).toEqual([[], [], []]);
        expect(planner.dirtySections(doc, first, { full: false })).toEqual([]);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('does not depend on the iteration order of the extraction map, nor on the order results were produced in', () => {
    fc.assert(
      fc.property(cases, fc.integer(), (sections, seed) => {
        const { doc, extracted } = build(sections);
        const a = planner.merge(doc, null, toMap(extracted), META);
        const b = planner.merge(doc, null, toMap(permute(extracted, seed)), META);
        expect(text(b.plan)).toBe(text(a.plan));
        expect(b.added).toEqual(a.added);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('the order of sections in the document does not change feature or scenario ids when titles are distinct', () => {
    fc.assert(
      fc.property(cases, fc.integer(), (sections, seed) => {
        // Make every feature title unique so that no id depends on first-come suffixes.
        const unique = sections.map((s, si) => ({ ...s, drafts: s.drafts.map((d, di) => ({ ...d, title: `${d.title} f${si}.${di}`, scenarios: d.scenarios.map((sc, ci) => ({ ...sc, title: `${sc.title} s${ci}` })) })) }));
        const shuffled = permute(unique, seed);
        const a = build(unique);
        const b = build(shuffled);
        const pa = planner.merge(a.doc, null, toMap(a.extracted), META).plan;
        const pb = planner.merge(b.doc, null, toMap(b.extracted), META).plan;
        const byTitle = (p: DocPlan): Record<string, string[]> =>
          Object.fromEntries(p.features.map((f) => [f.title, [f.id, ...f.scenarios.map((s) => s.id).sort()]]));
        expect(byTitle(pb)).toEqual(byTitle(pa));
        expect([...ids(pb)].sort()).toEqual([...ids(pa)].sort());
      }),
      params({ scale: 0.5 }),
    );
  });

  it('editing one paragraph keeps the ids of every feature and scenario (identity follows the draft, not the text hash)', () => {
    fc.assert(
      fc.property(cases, fc.nat(), (sections, pick) => {
        const { doc, extracted } = build(sections);
        const plan = planner.merge(doc, null, toMap(extracted), META).plan;
        if (plan.features.length === 0) return;
        const si = pick % sections.length;
        const edited = sections.map((s, i) => (i === si ? { ...s, paras: s.paras.map((p, k) => (k === 0 ? `${p} (edited)` : p)) } : s));
        const next = build(edited);
        const merged = planner.merge(next.doc, plan, toMap(next.extracted), META).plan;
        expect([...ids(merged)].sort()).toEqual([...ids(plan)].sort());
      }),
      params({ scale: 0.5 }),
    );
  });
});

// ───────────────────────── review

describe('fuzz: planner.review', () => {
  /** Small counterexamples: only the sections and two target picks are generated; the plan is rebuilt from them. */
  const reviewCase = fc.record({ sections: cases, a: fc.nat(), b: fc.nat() }).map(({ sections, a, b }) => {
    const { doc, extracted } = build(sections);
    const plan = planner.merge(doc, null, toMap(extracted), META).plan;
    const targets = ids(plan);
    return { sections, plan, doc, extracted, id: targets[a % Math.max(1, targets.length)] ?? '', second: targets[b % Math.max(1, targets.length)] ?? '' };
  }).filter((c) => c.plan.features.length > 0);

  const ACTIONS = ['accept', 'reject', 'pin', 'unpin'] as const;

  it('every action is idempotent, pure (the input plan is untouched) and keeps the plan schema-valid', () => {
    fc.assert(
      fc.property(reviewCase, fc.constantFrom(...ACTIONS), (c, action) => {
        const before = text(c.plan);
        const once = planner.review(c.plan, c.id, action);
        expect(text(c.plan)).toBe(before);
        expect(text(planner.review(once, c.id, action))).toBe(text(once));
        const parsed = parseDocPlan(JSON.parse(text(once)));
        expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
        const fps = once.rejected.map((r) => r.fingerprint);
        expect(new Set(fps).size).toBe(fps.length);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('pin and unpin are inverse on an unpinned plan; accept and reject override each other', () => {
    fc.assert(
      fc.property(reviewCase, (c) => {
        expect(text(planner.review(planner.review(c.plan, c.id, 'pin'), c.id, 'unpin'))).toBe(text(c.plan));
        // accept after reject is the same as accept; reject after accept is the same as reject
        expect(text(planner.review(planner.review(c.plan, c.id, 'reject'), c.id, 'accept'))).toBe(text(planner.review(c.plan, c.id, 'accept')));
        expect(text(planner.review(planner.review(c.plan, c.id, 'accept'), c.id, 'reject'))).toBe(text(planner.review(c.plan, c.id, 'reject')));
        // pinning does not touch review state or coverage
        const pinned = planner.review(c.plan, c.id, 'pin');
        expect(pinned.uncovered).toEqual(c.plan.uncovered);
        expect(pinned.rejected).toEqual(c.plan.rejected);
      }),
      params({ scale: 0.5 }),
    );
  });

  it('actions on different targets commute for accept/reject/pin/unpin', () => {
    fc.assert(
      fc.property(reviewCase, fc.constantFrom(...ACTIONS), fc.constantFrom(...ACTIONS), (c, a1, a2) => {
        // Two actions on unrelated owners commute. Related ids (a feature and its scenario, or two scenarios of one feature) may not,
        // because a feature-level action rewrites its scenarios.
        const owner = (id: string): string => c.plan.features.find((f) => f.id === id || f.scenarios.some((s) => s.id === id))?.id ?? '';
        if (owner(c.id) === owner(c.second)) return;
        const ab = planner.review(planner.review(c.plan, c.id, a1), c.second, a2);
        const ba = planner.review(planner.review(c.plan, c.second, a2), c.id, a1);
        // `rejected` is a set recorded in action order: compare it sorted
        const norm = (p: DocPlan): string => text({ ...p, rejected: [...p.rejected].sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1)) });
        expect(norm(ab)).toBe(norm(ba));
      }),
      params({ scale: 0.5 }),
    );
  });

  it('reject drops the item from coverage, a following merge never resurrects it, and accept restores it', () => {
    fc.assert(
      fc.property(reviewCase, (c) => {
        const target = c.plan.features.find((f) => f.id === c.id) ?? c.plan.features.find((f) => f.scenarios.some((s) => s.id === c.id));
        if (target === undefined) return;
        const rejected = planner.review(c.plan, c.id, 'reject');
        const remerged = planner.merge(c.doc, rejected, toMap(c.extracted), META).plan;
        const rejectedFps = new Set(remerged.rejected.map((r) => r.fingerprint));
        for (const f of remerged.features) for (const s of f.scenarios) if (rejectedFps.has(s.fingerprint)) expect(s.review).toBe('rejected');
        // accepting the original again restores the review state the reject changed
        const restored = planner.review(rejected, c.id, 'accept');
        const scenarioIds = target.id === c.id ? target.scenarios.map((s) => s.id) : [c.id];
        for (const f of restored.features) for (const s of f.scenarios) if (scenarioIds.includes(s.id)) expect(s.review).toBe('accepted');
      }),
      params({ scale: 0.5 }),
    );
  });

  it('an unknown id (including prototype-key names) is SCENARIO_NOT_FOUND and the plan is left alone', () => {
    fc.assert(
      fc.property(reviewCase, fc.oneof(hostileString({ maxLength: 30 }), fc.constantFrom('__proto__', 'constructor', 'toString', '')), fc.constantFrom(...ACTIONS), (c, id, action) => {
        fc.pre(!ids(c.plan).includes(id));
        const before = text(c.plan);
        try {
          planner.review(c.plan, id, action);
          expect.unreachable('review of an unknown id must throw');
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'SCENARIO_NOT_FOUND').toBe(true);
        }
        expect(text(c.plan)).toBe(before);
        expect(jsonEqual(JSON.parse(before), JSON.parse(text(c.plan)))).toBe(true);
      }),
      params({ scale: 0.5 }),
    );
  });
});
