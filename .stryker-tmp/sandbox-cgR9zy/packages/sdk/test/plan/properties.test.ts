// @ts-nocheck
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DocPlan, ExtractionResult, JsonValue, ResolvedConfig } from '../../src/contracts/index.ts';
import { createPlanner } from '../../src/plan/index.ts';
import { stableJson } from '../../src/util/index.ts';
import { META, buildDoc, feature, ref, result, scenario, step } from './fixtures.ts';

const RUNS = Number(process.env['FC_RUNS'] ?? 200);
const planner = createPlanner({} as ResolvedConfig);
const json = (p: DocPlan): string => stableJson(p as unknown as JsonValue);

/** Distinct paragraph texts: unique per (section, index) so hashes never collide. */
const sectionCounts = fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 4 });

function textOf(s: number, i: number): string {
  return `Section ${s} paragraph ${i} explains behaviour number ${s * 31 + i} in plain words.`;
}

function layout(counts: readonly number[]): { title: string; paras: string[] }[] {
  return counts.map((n, s) => ({ title: `Topic ${s}`, paras: Array.from({ length: n }, (_, i) => textOf(s, i)) }));
}

/** One feature per section citing all of its paragraphs. */
function extractAll(doc: ReturnType<typeof buildDoc>, counts: readonly number[]): ExtractionResult[] {
  return counts.map((n, s) => {
    const refs = Array.from({ length: n }, (_, i) => ref(doc, textOf(s, i)));
    return result(doc.sections[s]?.id ?? '', [
      feature(`Topic ${s} feature`, refs, [
        scenario(`Topic ${s} scenario`, [step('when', `the user does thing ${s}`, refs), step('then', `thing ${s} happened`, refs)], refs),
      ]),
    ]);
  });
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let x = seed || 1;
  for (let i = a.length - 1; i > 0; i -= 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe('R-PL1: merge determinism properties', () => {
  it('R-PL1: property: merge is deterministic and independent of Map iteration order', () => {
    fc.assert(
      fc.property(sectionCounts, fc.integer(), (counts, seed) => {
        const doc = buildDoc('docs/p.md', layout(counts));
        const results = extractAll(doc, counts);
        const a = planner.merge(doc, null, new Map(results.map((r) => [r.sectionId, r])), META);
        const b = planner.merge(doc, null, new Map(shuffle(results, seed).map((r) => [r.sectionId, r])), META);
        const c = planner.merge(doc, null, new Map(results.map((r) => [r.sectionId, r])), META);
        expect(json(b.plan)).toBe(json(a.plan));
        expect(json(c.plan)).toBe(json(a.plan));
        expect(b.diagnostics).toEqual(a.diagnostics);
        expect(b.added).toEqual(a.added);
        // Re-merging with the previous plan and a shuffled partial map is also order independent.
        const prev = a.plan;
        const edited = layout(counts).map((s, i) => (i === 0 ? { ...s, paras: [...s.paras, 'A freshly added paragraph.'] } : s));
        const doc2 = buildDoc('docs/p.md', edited);
        const first = doc2.sections[0];
        const r0 = ref(doc2, textOf(0, 0));
        const redo = result(first?.id ?? '', [feature('Topic 0 feature', [r0], [scenario('Topic 0 scenario', [step('when', 'the user does thing 0', [r0]), step('then', 'thing 0 happened', [r0])], [r0])])]);
        const m1 = planner.merge(doc2, prev, new Map([[redo.sectionId, redo]]), META);
        const m2 = planner.merge(doc2, prev, new Map([...shuffle([[redo.sectionId, redo] as const], seed)]), META);
        expect(json(m2.plan)).toBe(json(m1.plan));
      }),
      { numRuns: RUNS },
    );
  });

  it('R-PL1: property: re-merging an unchanged doc is a fixed point (byte-identical, nothing added/updated/removed)', () => {
    fc.assert(
      fc.property(sectionCounts, (counts) => {
        const doc = buildDoc('docs/p.md', layout(counts));
        const plan = planner.merge(doc, null, new Map(extractAll(doc, counts).map((r) => [r.sectionId, r])), META).plan;
        const again = planner.merge(doc, plan, new Map(), META);
        expect(json(again.plan)).toBe(json(plan));
        expect([again.added, again.updated, again.removed]).toEqual([[], [], []]);
        expect(planner.dirtySections(doc, plan, { full: false })).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('R-PL2: relocation properties', () => {
  it('R-PL2: property: moving an unedited paragraph (within or across sections) never dirties a section', () => {
    fc.assert(
      fc.property(sectionCounts, fc.nat(), fc.nat(), fc.nat(), (counts, pickSection, pickIndex, pickTarget) => {
        const specs = layout(counts);
        const doc = buildDoc('docs/p.md', specs);
        const plan = planner.merge(doc, null, new Map(extractAll(doc, counts).map((r) => [r.sectionId, r])), META).plan;

        const from = pickSection % specs.length;
        const source = specs[from];
        if (source === undefined || source.paras.length === 0) return;
        const idx = pickIndex % source.paras.length;
        const moved = source.paras[idx] as string;
        const to = pickTarget % specs.length;
        const next = specs.map((s) => ({ title: s.title, paras: [...s.paras] }));
        (next[from] as { paras: string[] }).paras.splice(idx, 1);
        const target = next[to] as { paras: string[] };
        target.paras.splice(Math.min(pickTarget % (target.paras.length + 1), target.paras.length), 0, moved);

        const doc2 = buildDoc('docs/p.md', next);
        expect(planner.dirtySections(doc2, plan, { full: false })).toEqual([]);
        const merged = planner.merge(doc2, plan, new Map(), META);
        expect(merged.diagnostics).toEqual([]);
        // Every ref points at the chunk that now carries the same text.
        for (const f of merged.plan.features) {
          for (const r of f.sources) {
            expect(doc2.chunks.find((c) => c.id === r.chunkId)?.hash).toBe(r.hash);
          }
        }
        expect(planner.status([doc2], [merged.plan]).docs[0]?.state).toBe('fresh');
      }),
      { numRuns: RUNS },
    );
  });

  it('R-PL2: property: editing one paragraph dirties exactly the section that holds it', () => {
    fc.assert(
      fc.property(sectionCounts, fc.nat(), fc.nat(), (counts, pickSection, pickIndex) => {
        const specs = layout(counts);
        const doc = buildDoc('docs/p.md', specs);
        const plan = planner.merge(doc, null, new Map(extractAll(doc, counts).map((r) => [r.sectionId, r])), META).plan;
        const s = pickSection % specs.length;
        const sec = specs[s];
        if (sec === undefined) return;
        const i = pickIndex % sec.paras.length;
        const next = specs.map((x, k) => (k === s ? { ...x, paras: x.paras.map((p, j) => (j === i ? `${p} It was edited.` : p)) } : x));
        const doc2 = buildDoc('docs/p.md', next);
        expect(planner.dirtySections(doc2, plan, { full: false })).toEqual([doc2.sections[s]?.id]);
      }),
      { numRuns: RUNS },
    );
  });
});
