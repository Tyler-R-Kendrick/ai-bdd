import { describe, expect, it } from 'vitest';
import type { ChunkRef, DocPlan, Feature, ResolvedConfig, Scenario } from '../../src/contracts/index.ts';
import { createPlanner } from '../../src/plan/index.ts';
import { BILLING_PARAS, META, billingDoc, buildDoc, chunkIdOf, downgradeDraft, feature, firstSectionId, mapOf, ref, result, scenario, step, upgradeDraft } from './fixtures.ts';

/**
 * Exact-value tests that pin planner behaviour the broader suites only touch loosely (ids, directives, ordering,
 * notTestable relocation, status and review bookkeeping). Every case builds a tiny hand-made doc or plan.
 */
const planner = createPlanner({} as ResolvedConfig);

function at<T>(items: readonly T[], i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no item at ${i}`);
  return v;
}

function mergeFresh(doc: ReturnType<typeof buildDoc>, ...results: ReturnType<typeof result>[]): DocPlan {
  return planner.merge(doc, null, mapOf(...results), META).plan;
}

describe('ids', () => {
  it('feature ids only drop the final extension of the docUri, keeping inner dots', () => {
    const doc = buildDoc('docs/v1.2.md', [{ title: 'Alpha', paras: ['Customers can pay by card.'] }]);
    const r = ref(doc, 'Customers can pay by card.');
    const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [feature('Pay', [r], [scenario('Pay now', [step('when', 'they pay', [r])], [r])])]));
    expect(at(plan.features, 0).id).toBe('docs-v1-2--pay');
    expect(at(at(plan.features, 0).scenarios, 0).id).toBe('docs-v1-2--pay/pay-now');
  });

  it('three features and three scenarios with the same title count -2, -3', () => {
    const doc = billingDoc();
    const r = ref(doc, BILLING_PARAS.upgrade);
    const make = (n: number): ReturnType<typeof feature> =>
      feature('Same', [r], [
        scenario('Twin', [step('when', `first twin ${n}`, [r])], [r]),
        scenario('Twin', [step('when', `second twin ${n}`, [r])], [r]),
        scenario('Twin', [step('when', `third twin ${n}`, [r])], [r]),
      ]);
    const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [make(1), make(2), make(3)]));
    expect(plan.features.map((f) => f.id)).toEqual(['docs-billing--same', 'docs-billing--same-2', 'docs-billing--same-3']);
    expect(at(plan.features, 2).scenarios.map((s) => s.id)).toEqual([
      'docs-billing--same-3/twin',
      'docs-billing--same-3/twin-2',
      'docs-billing--same-3/twin-3',
    ]);
  });

  it('a fresh feature id never takes an id reserved for a later draft that inherits it', () => {
    const doc = billingDoc();
    const r = ref(doc, BILLING_PARAS.upgrade);
    const original = scenario('Original scenario', [step('when', 'original step text', [r])], [r]);
    const first = mergeFresh(doc, result(firstSectionId(doc, 0), [feature('Foo', [r], [original])]));
    expect(at(first.features, 0).id).toBe('docs-billing--foo');
    const other = scenario('Different scenario', [step('when', 'something unrelated entirely', [r])], [r]);
    const next = planner.merge(doc, first, mapOf(result(firstSectionId(doc, 0), [feature('Foo', [r], [other]), feature('Foo', [r], [original])])), META).plan;
    const byScenario = (title: string): Feature => at(next.features.filter((f) => f.scenarios.some((s) => s.title === title)), 0);
    expect(byScenario('Original scenario').id).toBe('docs-billing--foo');
    expect(byScenario('Different scenario').id).toBe('docs-billing--foo-2');
  });

  it('a fresh scenario id never takes the id of a matched sibling scenario', () => {
    const doc = billingDoc();
    const r = ref(doc, BILLING_PARAS.upgrade);
    const old = scenario('Alpha scenario', [step('when', 'the old steps run', [r])], [r]);
    const first = mergeFresh(doc, result(firstSectionId(doc, 0), [feature('Foo', [r], [old])]));
    const fresh = scenario('Alpha scenario', [step('when', 'brand new unrelated steps', [r])], [r]);
    const next = planner.merge(doc, first, mapOf(result(firstSectionId(doc, 0), [feature('Foo', [r], [fresh, old])])), META).plan;
    const f = at(next.features, 0);
    const ids = new Map(f.scenarios.map((s) => [at(s.steps, 0).text, s.id]));
    expect(ids.get('the old steps run')).toBe('docs-billing--foo/alpha-scenario');
    expect(ids.get('brand new unrelated steps')).toBe('docs-billing--foo/alpha-scenario-2');
  });
});

describe('step bodies', () => {
  it('copies params and fixture args, and keeps nature only on then and requiresState only on given', () => {
    const doc = billingDoc();
    const r = ref(doc, BILLING_PARAS.upgrade);
    const params = { plan: 'pro' };
    const args = { amount: '10' };
    const given = { ...step('given', 'a given step', [r]), nature: 'objective' as const, requiresState: true, params, fixture: { name: 'seed', args } };
    const when = { ...step('when', 'a when step', [r]), nature: 'objective' as const, requiresState: true };
    const then = { ...step('then', 'a then step', [r]), nature: 'subjective' as const, requiresState: true, params: { a: 'b' } };
    const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [feature('Steps', [r], [scenario('All kinds', [given, when, then], [r])])]));
    const steps = at(at(plan.features, 0).scenarios, 0).steps;
    const base = (s: { text: string }): Record<string, unknown> => ({ text: s.text, grounding: 'quoted' });
    expect(steps.map((s) => ({ kind: s.kind, nature: s.nature, requiresState: s.requiresState, params: s.params, fixture: s.fixture }))).toEqual([
      { kind: 'given', nature: undefined, requiresState: true, params: { plan: 'pro' }, fixture: { name: 'seed', args: { amount: '10' } } },
      { kind: 'when', nature: undefined, requiresState: undefined, params: {}, fixture: undefined },
      { kind: 'then', nature: 'subjective', requiresState: undefined, params: { a: 'b' }, fixture: undefined },
    ]);
    expect(Object.keys(at(steps, 0)).sort()).toEqual(['fixture', 'grounding', 'key', 'kind', 'params', 'requiresState', 'sources', 'text']);
    expect(Object.keys(at(steps, 1)).sort()).toEqual(['grounding', 'key', 'kind', 'params', 'sources', 'text']);
    expect(Object.keys(at(steps, 2)).sort()).toEqual(['grounding', 'key', 'kind', 'nature', 'params', 'sources', 'text']);
    expect(base(at(steps, 0))).toEqual({ text: 'a given step', grounding: 'quoted' });
  });
});

describe('directives', () => {
  const doc = buildDoc('docs/d.md', [
    {
      title: 'Alpha',
      paras: [
        'Plain source paragraph.',
        { text: 'Driver source paragraph.', directives: { driver: 'pw', start: '/start', tags: ['@t1'], fuzzy: true } },
        { text: 'Feature level paragraph.', directives: { driver: 'feat-driver', start: '/feat', tags: ['@ft'] } },
        { text: 'Context paragraph.', directives: { context: true, driver: 'ctx-driver', start: '/ctx', tags: ['@ctx'], fuzzy: true } },
      ],
    },
  ]);
  const plain = ref(doc, 'Plain source paragraph.');
  const driven = ref(doc, 'Driver source paragraph.');
  const featRef = ref(doc, 'Feature level paragraph.');
  const ctx = ref(doc, 'Context paragraph.', 'context');

  const plan = mergeFresh(
    doc,
    result(firstSectionId(doc, 0), [
      feature('Directives', [featRef], [
        scenario('plain own source', [step('when', 'plain step', [])], [plain]),
        scenario('own source plus context ref', [step('when', 'driven step', [ctx])], [driven]),
        scenario('context only falls back', [step('when', 'context step', [ctx])], []),
        scenario('nothing at all falls back', [step('when', 'bare step', [])], []),
        scenario('step source only', [step('when', 'sourced step', [driven])], []),
      ]),
    ]),
  );
  const byTitle = (t: string): Scenario => at(at(plan.features, 0).scenarios.filter((s) => s.title === t), 0);

  it('a scenario with its own plain source gets no tags, driver, start url or @fuzzy', () => {
    const s = byTitle('plain own source');
    expect(s.tags).toEqual([]);
    expect('driver' in s).toBe(false);
    expect('startUrl' in s).toBe(false);
  });

  it('only source refs contribute directives: a context ref never does, and a mixed scenario does not fall back', () => {
    const s = byTitle('own source plus context ref');
    expect(s.tags).toEqual(['@t1', '@fuzzy']);
    expect(s.driver).toBe('pw');
    expect(s.startUrl).toBe('/start');
  });

  it('without any source ref a scenario inherits the directives of the feature sources', () => {
    for (const t of ['context only falls back', 'nothing at all falls back']) {
      const s = byTitle(t);
      expect(s.tags).toEqual(['@ft']);
      expect(s.driver).toBe('feat-driver');
      expect(s.startUrl).toBe('/feat');
    }
  });

  it('a source ref on a step alone is enough to take the directives from the step sources', () => {
    const s = byTitle('step source only');
    expect(s.tags).toEqual(['@t1', '@fuzzy']);
    expect(s.driver).toBe('pw');
    expect(at(plan.features, 0).tags).toEqual(['@ft']);
  });
});

describe('feature bodies', () => {
  it('a feature with only context sources is not planned, a feature without scenarios is', () => {
    const doc = billingDoc();
    const src = ref(doc, BILLING_PARAS.upgrade);
    const ctx = ref(doc, BILLING_PARAS.perf, 'context');
    const plan = mergeFresh(
      doc,
      result(firstSectionId(doc, 0), [feature('Only context', [ctx], [scenario('Ctx', [step('when', 'x', [ctx])], [ctx])]), feature('No scenarios yet', [src], [])]),
    );
    expect(plan.features.map((f) => [f.title, f.scenarios.length])).toEqual([['No scenarios yet', 0]]);
  });

  it('a feature whose scenarios were all rejected is dropped', () => {
    const doc = billingDoc();
    const first = mergeFresh(doc, result(firstSectionId(doc, 0), [upgradeDraft(doc)]));
    const rejected = planner.review(first, at(at(first.features, 0).scenarios, 0).id, 'reject');
    const next = planner.merge(doc, rejected, mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)])), META).plan;
    expect(next.features).toEqual([]);
  });
});

describe('context changes', () => {
  it('reports changed context chunks sorted by id, with the exact diagnostic', () => {
    const mk = (two: string, three: string): ReturnType<typeof buildDoc> =>
      buildDoc('docs/c.md', [
        {
          title: 'Alpha',
          paras: ['Source paragraph one.', { text: two, directives: { context: true } }, { text: three, directives: { context: true } }],
        },
      ]);
    const doc0 = mk('Context two.', 'Context three.');
    const src = ref(doc0, 'Source paragraph one.');
    const three = ref(doc0, 'Context three.', 'context');
    const two = ref(doc0, 'Context two.', 'context');
    const first = mergeFresh(doc0, result(firstSectionId(doc0, 0), [feature('Login', [src], [scenario('Log in', [step('given', 'ctx first', [three, two])], [src])])]));
    const doc1 = mk('Context two edited.', 'Context three edited.');
    const next = planner.merge(doc1, first, new Map(), META);
    expect(next.diagnostics).toEqual([
      {
        code: 'PLAN_CONTEXT_CHANGED',
        severity: 'warning',
        message: 'context chunks changed for feature docs-c--login',
        uri: 'docs/c.md',
        details: { featureId: 'docs-c--login', chunkIds: ['docs/c.md#alpha/p2', 'docs/c.md#alpha/p3'] },
      },
    ]);
    const refs = at(at(next.plan.features, 0).scenarios, 0).steps[0]?.sources ?? [];
    expect(refs.map((r) => [r.chunkId, r.hash])).toEqual([
      ['docs/c.md#alpha/p3', doc1.chunks.find((c) => c.text === 'Context three edited.')?.hash],
      ['docs/c.md#alpha/p2', doc1.chunks.find((c) => c.text === 'Context two edited.')?.hash],
    ]);
  });
});

describe('feature order', () => {
  const doc = buildDoc('docs/o.md', [{ title: 'Alpha', paras: ['First paragraph.', 'Second paragraph.', 'Third paragraph.'] }]);
  const p1 = ref(doc, 'First paragraph.');
  const p2 = ref(doc, 'Second paragraph.');
  const p3 = ref(doc, 'Third paragraph.');
  const p1ctx = ref(doc, 'First paragraph.', 'context');

  it('orders by the earliest source ref of the feature, ignoring context refs and scenario refs when feature sources exist', () => {
    const plan = mergeFresh(
      doc,
      result(firstSectionId(doc, 0), [
        feature('Zulu', [p3], [scenario('Z', [step('when', 'z acts', [p1])], [p1])]),
        feature('Alpha', [p2], [scenario('A', [step('when', 'a acts', [p2])], [p2])]),
        feature('Charlie', [p3, p1ctx], [scenario('C', [step('when', 'c acts', [p3])], [p3])]),
        feature('Kilo', [p1, p3], [scenario('K', [step('when', 'k acts', [p1])], [p1])]),
      ]),
    );
    expect(plan.features.map((f) => f.title)).toEqual(['Kilo', 'Alpha', 'Charlie', 'Zulu']);
  });

  function base(): { plan: DocPlan; f: Feature } {
    const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [feature('Base', [p1], [scenario('B', [step('when', 'b acts', [p1])], [p1])])]));
    return { plan, f: at(plan.features, 0) };
  }
  const withFeatures = (plan: DocPlan, features: Feature[]): DocPlan => ({ ...structuredClone(plan), features });
  const clone = (f: Feature, over: Partial<Feature>): Feature => ({ ...structuredClone(f), ...over });
  const refTo = (chunk: string, relation: ChunkRef['relation']): ChunkRef => {
    const c = doc.chunks.find((x) => x.text === chunk);
    if (c === undefined) throw new Error('chunk');
    return { chunkId: c.id, hash: c.hash, relation };
  };

  it('a kept feature whose own sources are context only is placed by its scenario source refs', () => {
    const { plan, f } = base();
    const ctxOnly = clone(f, {
      id: 'docs-o--ctx-only',
      title: 'Ctx only',
      sources: [refTo('Third paragraph.', 'context')],
      scenarios: f.scenarios.map((s) => ({ ...s, id: 'docs-o--ctx-only/b', featureId: 'docs-o--ctx-only', sources: [refTo('First paragraph.', 'source')], steps: [] })),
    });
    const later = clone(f, { id: 'docs-o--later', title: 'Later', sources: [refTo('Second paragraph.', 'source')], scenarios: [] });
    const next = planner.merge(doc, withFeatures(plan, [later, ctxOnly]), new Map(), META).plan;
    expect(next.features.map((x) => x.id)).toEqual(['docs-o--ctx-only', 'docs-o--later']);
  });

  it('ties on the source position are broken by title, then by id', () => {
    const { plan, f } = base();
    const byTitle = [clone(f, { id: 'docs-o--a-id', title: 'Beta' }), clone(f, { id: 'docs-o--b-id', title: 'Alpha' })];
    expect(
      planner.merge(doc, withFeatures(plan, [byTitle[1] as Feature, byTitle[0] as Feature]), new Map(), META).plan.features.map((x) => x.id),
    ).toEqual(['docs-o--b-id', 'docs-o--a-id']);
    // Input order is the reverse of the sorted order for both a title tie and a position tie.
    const titleFirst = [clone(f, { id: 'docs-o--zz', title: 'Same' }), clone(f, { id: 'docs-o--aa', title: 'Same' })];
    expect(planner.merge(doc, withFeatures(plan, titleFirst), new Map(), META).plan.features.map((x) => x.id)).toEqual(['docs-o--aa', 'docs-o--zz']);
    const mixed = [clone(f, { id: 'docs-o--m1', title: 'Beta' }), clone(f, { id: 'docs-o--m2', title: 'Alpha' })];
    expect(planner.merge(doc, withFeatures(plan, mixed), new Map(), META).plan.features.map((x) => x.title)).toEqual(['Alpha', 'Beta']);
  });
});

describe('coverage bookkeeping', () => {
  const doc = buildDoc('docs/u.md', [
    {
      title: 'Alpha',
      paras: ['P1 feature only.', 'P2 scenario only.', 'P3 step only.', 'P4 cited as context.', 'P5 uncited.', 'P6 rejected scenario only.'],
    },
  ]);
  const id = (n: number): string => `docs/u.md#alpha/p${n}`;
  const r = (text: string, rel: 'source' | 'context' = 'source'): ReturnType<typeof ref> => ref(doc, text, rel);

  const draft = feature('Coverage', [r('P1 feature only.')], [
    scenario('Kept', [step('when', 'kept step', [r('P3 step only.'), r('P4 cited as context.', 'context')])], [r('P2 scenario only.')]),
    scenario('Doomed', [step('when', 'doomed step', [])], [r('P6 rejected scenario only.')]),
  ]);
  const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [draft]));

  it('feature, scenario and step sources all cover; context refs do not', () => {
    expect(plan.uncovered).toEqual([id(4), id(5)]);
  });

  it('a rejected scenario stops covering its sources on the next merge', () => {
    const doomed = at(at(plan.features, 0).scenarios.filter((s) => s.title === 'Doomed'), 0);
    const rejected = planner.review(plan, doomed.id, 'reject');
    expect(planner.merge(doc, rejected, new Map(), META).plan.uncovered).toEqual([id(4), id(5), id(6)]);
  });

  it('review refreshes uncovered per ref level and ignores context refs and headings', () => {
    const fid = at(plan.features, 0).id;
    const rejected = planner.review(plan, fid, 'reject');
    expect(rejected.uncovered).toEqual([id(1), id(2), id(3), id(4), id(5), id(6)]);
    const accepted = planner.review(rejected, fid, 'accept');
    expect(accepted.uncovered).toEqual([id(4), id(5)]);
    const kept = at(plan.features, 0).scenarios.find((s) => s.title === 'Kept') as Scenario;
    expect(planner.review(plan, kept.id, 'reject').uncovered).toEqual([id(2), id(3), id(4), id(5)]);
  });

  it('a live scenario of a rejected feature does not cover (the feature state wins)', () => {
    const fid = at(plan.features, 0).id;
    const other = buildDoc('docs/g.md', [{ title: 'Beta', paras: ['G source.'] }]);
    const g = mergeFresh(other, result(firstSectionId(other, 0), [feature('G', [ref(other, 'G source.')], [scenario('G s', [], [ref(other, 'G source.')])])]));
    const mixed: DocPlan = { ...structuredClone(plan), features: [{ ...structuredClone(at(plan.features, 0)), review: 'rejected' }, ...g.features] };
    const out = planner.review(mixed, at(g.features, 0).id, 'accept');
    expect(out.uncovered).toEqual([id(1), id(2), id(3), id(4), id(5), id(6)]);
    expect(fid).toBe('docs-u--coverage');
  });

  it('a rejected feature that cites a heading does not list the heading as uncovered', () => {
    const b = billingDoc();
    const heading = ref(b, 'Upgrading');
    const para = ref(b, BILLING_PARAS.upgrade);
    const p = mergeFresh(b, result(firstSectionId(b, 0), [feature('Heading cite', [heading, para], [scenario('S', [], [para])])]));
    const out = planner.review(p, at(p.features, 0).id, 'reject');
    expect(out.uncovered).toEqual(b.chunks.filter((c) => c.kind !== 'heading').map((c) => c.id));
  });
});

describe('change report', () => {
  it('reports a story edit on the feature and a tag edit on the scenario as updates', () => {
    const doc = billingDoc();
    const r = ref(doc, BILLING_PARAS.upgrade);
    const mk = (iWant: string, tags: string[]): ReturnType<typeof feature> => ({
      ...feature('Story', [r], [scenario('Tagged', [step('when', 'story step', [r])], [r], tags)]),
      story: { asA: 'customer', iWant },
    });
    const sec = firstSectionId(doc, 0);
    const first = mergeFresh(doc, result(sec, [mk('to upgrade', ['@a'])]));
    const story = planner.merge(doc, first, mapOf(result(sec, [mk('to upgrade quickly', ['@a'])])), META);
    expect(story.updated).toEqual(['docs-billing--story']);
    expect(story.added).toEqual([]);
    expect(story.removed).toEqual([]);
    const tags = planner.merge(doc, first, mapOf(result(sec, [mk('to upgrade', ['@b'])])), META);
    expect(tags.updated).toEqual(['docs-billing--story/tagged']);
    expect(tags.added).toEqual([]);
    expect(tags.removed).toEqual([]);
  });
});

describe('failed sections', () => {
  it('a failed extraction of an up-to-date section keeps its features and warns with the exact diagnostic', () => {
    const doc = billingDoc();
    const sec0 = firstSectionId(doc, 0);
    const sec1 = firstSectionId(doc, 1);
    const first = mergeFresh(doc, result(sec0, [upgradeDraft(doc)]), result(sec1, [downgradeDraft(doc)]));
    const failed = { ...result(sec0, []), failed: true };
    const next = planner.merge(doc, first, mapOf(failed), META);
    expect(next.diagnostics).toEqual([
      { code: 'EXTRACT_SECTION_FAILED', severity: 'warning', message: `section ${sec0} was not extracted; previous features are kept`, uri: 'docs/billing.md', details: { sectionId: sec0 } },
    ]);
    expect(next.plan.features).toEqual(first.features);
    expect(next.plan.sections).toEqual([{ id: sec0, hash: at(first.sections, 0).hash, failed: true }, at(first.sections, 1)]);
  });
});

describe('pinned features', () => {
  const doc = buildDoc('docs/p.md', [
    { title: 'Alpha', paras: ['Alpha source.'] },
    { title: 'Beta', paras: ['Beta source.'] },
    { title: 'Gamma', paras: ['Gamma source.'] },
  ]);
  const draftFor = (title: string, text: string): ReturnType<typeof feature> => {
    const r = ref(doc, text);
    return feature(title, [r], [scenario(`${title} scenario`, [step('when', `${title} acts`, [r])], [r])]);
  };
  const plan = mergeFresh(
    doc,
    result(firstSectionId(doc, 0), [draftFor('Fa', 'Alpha source.')]),
    result(firstSectionId(doc, 1), [draftFor('Fb', 'Beta source.')]),
    result(firstSectionId(doc, 2), [draftFor('Fc', 'Gamma source.')]),
  );
  const refTo = (text: string, relation: ChunkRef['relation']): ChunkRef => {
    const c = doc.chunks.find((x) => x.text === text);
    if (c === undefined) throw new Error('chunk');
    return { chunkId: c.id, hash: c.hash, relation };
  };

  it('a pinned feature is kept exactly once whether its section is kept or re-extracted', () => {
    const pinned = planner.review(plan, at(plan.features, 0).id, 'pin');
    const kept = planner.merge(doc, pinned, new Map(), META);
    expect(kept.plan.features.map((f) => f.id)).toEqual(['docs-p--fa', 'docs-p--fb', 'docs-p--fc']);
    expect(kept.diagnostics).toEqual([]);
    expect(at(kept.plan.features, 0).pinned).toBe(true);
  });

  it('a pinned feature whose sources changed is warned about with the exact diagnostic', () => {
    const pinned = planner.review(plan, at(plan.features, 0).id, 'pin');
    const edited = buildDoc('docs/p.md', [
      { title: 'Alpha', paras: ['Alpha source edited.'] },
      { title: 'Beta', paras: ['Beta source.'] },
      { title: 'Gamma', paras: ['Gamma source.'] },
    ]);
    const out = planner.merge(edited, pinned, new Map(), META);
    expect(out.diagnostics).toEqual([
      { code: 'EXTRACT_SECTION_FAILED', severity: 'warning', message: 'section docs/p.md#alpha was not extracted; previous features are kept', uri: 'docs/p.md', details: { sectionId: 'docs/p.md#alpha' } },
      { code: 'PLAN_PINNED_STALE', severity: 'warning', message: 'pinned feature docs-p--fa has changed sources', uri: 'docs/p.md', details: { featureId: 'docs-p--fa' } },
    ]);
  });

  it('a pinned feature with a vanished section moves to the section of its first source ref; one with a live section stays', () => {
    const f = at(plan.features, 0);
    const gone: Feature = {
      ...structuredClone(f),
      id: 'docs-p--gone',
      title: 'Gone',
      sectionId: 'docs/p.md#gone',
      pinned: true,
      sources: [refTo('Alpha source.', 'context'), refTo('Beta source.', 'source'), refTo('Gamma source.', 'source')],
    };
    const stay: Feature = { ...structuredClone(f), id: 'docs-p--stay', title: 'Stay', sectionId: 'docs/p.md#alpha', pinned: true, sources: [refTo('Beta source.', 'source')] };
    const prev: DocPlan = { ...structuredClone(plan), features: [gone, stay] };
    const out = planner.merge(doc, prev, new Map(), META);
    expect(Object.fromEntries(out.plan.features.map((x) => [x.id, x.sectionId]))).toEqual({
      'docs-p--gone': 'docs/p.md#beta',
      'docs-p--stay': 'docs/p.md#alpha',
    });
  });

  it('a draft of another section that resembles a pinned feature is still planned', () => {
    const b = billingDoc();
    const sec0 = firstSectionId(b, 0);
    const sec1 = firstSectionId(b, 1);
    const first = mergeFresh(b, result(sec0, [upgradeDraft(b)]));
    const pinned = planner.review(first, at(first.features, 0).id, 'pin');
    const next = planner.merge(b, pinned, mapOf(result(sec1, [downgradeDraft(b, 'Upgrade to Pro')])), META).plan;
    expect(next.features.map((f) => [f.id, f.sectionId])).toEqual([
      ['docs-billing--upgrade-to-pro', sec0],
      ['docs-billing--upgrade-to-pro-2', sec1],
    ]);
  });
});

describe('notTestable', () => {
  const path = 'docs/n.md';
  const idOf = (n: number): string => `${path}#alpha/p${n}`;
  const mk = (paras: (string | { text: string; directives: { ignore: true } })[]): ReturnType<typeof buildDoc> => buildDoc(path, [{ title: 'Alpha', paras }]);
  const prevFor = (doc: ReturnType<typeof buildDoc>, notTestable: { chunkId: string; reason: string }[]): DocPlan => ({
    ...mergeFresh(doc, result(firstSectionId(doc, 0), [])),
    notTestable,
  });
  const A = 'AAA first paragraph here.';
  const B = 'BBB second paragraph here.';
  const C = 'CCC third paragraph here.';

  it('an entry follows its text when the chunk id now holds other text and exactly one chunk has the old text', () => {
    const prev = prevFor(mk([A, B, C]), [{ chunkId: idOf(1), reason: 'r-a' }]);
    const out = planner.merge(mk(['ZZZ new paragraph here.', A, B, C]), prev, new Map(), META).plan;
    expect(out.notTestable).toEqual([{ chunkId: idOf(2), reason: 'r-a' }]);
  });

  it('an entry whose chunk was edited in place stays on that chunk when its old text is nowhere else', () => {
    const prev = prevFor(mk([A, B, C]), [{ chunkId: idOf(1), reason: 'r-a' }]);
    const out = planner.merge(mk(['AAA edited paragraph.', B, C]), prev, new Map(), META).plan;
    expect(out.notTestable).toEqual([{ chunkId: idOf(1), reason: 'r-a' }]);
  });

  it('an entry whose old text now occurs twice stays on its own chunk', () => {
    const prev = prevFor(mk([A, B, C]), [{ chunkId: idOf(1), reason: 'r-a' }]);
    const out = planner.merge(mk(['ZZZ new paragraph here.', A, A, C]), prev, new Map(), META).plan;
    expect(out.notTestable).toEqual([{ chunkId: idOf(1), reason: 'r-a' }]);
  });

  it('an unchanged chunk keeps its entry even when it became ignored and another chunk repeats its text', () => {
    const prev = prevFor(mk([A, B, C]), [{ chunkId: idOf(1), reason: 'r-a' }]);
    const out = planner.merge(mk([{ text: A, directives: { ignore: true } }, A, C]), prev, new Map(), META).plan;
    expect(out.notTestable).toEqual([{ chunkId: idOf(1), reason: 'r-a' }]);
  });

  it('the first entry wins when two entries land on the same chunk', () => {
    const prev = prevFor(mk([A, B, A]), [
      { chunkId: idOf(1), reason: 'first' },
      { chunkId: idOf(3), reason: 'second' },
    ]);
    const out = planner.merge(mk([A, B]), prev, new Map(), META).plan;
    expect(out.notTestable).toEqual([{ chunkId: idOf(1), reason: 'first' }]);
  });

  it('new entries from an extraction are checked against the doc and the retained entries, and the result is in document order', () => {
    const doc = buildDoc(path, [
      { title: 'Alpha', paras: [A, B] },
      { title: 'Beta', paras: [C, 'DDD fourth paragraph here.'] },
    ]);
    const prev = {
      ...mergeFresh(doc, result(firstSectionId(doc, 0), []), result(firstSectionId(doc, 1), [])),
      notTestable: [
        { chunkId: 'docs/n.md#beta/p2', reason: 'prev b2' },
        { chunkId: 'docs/n.md#alpha/p2', reason: 'old a2' },
      ],
    };
    const out = planner.merge(
      doc,
      prev,
      mapOf(
        result(firstSectionId(doc, 0), [], [
          { chunkId: 'docs/n.md#alpha/p2', reason: 'new a2' },
          { chunkId: 'docs/n.md#alpha/p1', reason: 'new a1' },
          { chunkId: 'docs/n.md#nowhere/p9', reason: 'bogus' },
          { chunkId: 'docs/n.md#beta/p2', reason: 'dup' },
        ]),
      ),
      META,
    ).plan;
    expect(out.notTestable).toEqual([
      { chunkId: 'docs/n.md#alpha/p1', reason: 'new a1' },
      { chunkId: 'docs/n.md#alpha/p2', reason: 'new a2' },
      { chunkId: 'docs/n.md#beta/p2', reason: 'prev b2' },
    ]);
  });
});

describe('plan shell', () => {
  it('a re-extraction replaces the extractor meta of a plan that has one already', () => {
    const doc = billingDoc();
    const first = mergeFresh(doc, result(firstSectionId(doc, 0), [upgradeDraft(doc)]));
    const next = planner.merge(doc, first, mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)])), { extractor: { modelId: 'newer', promptVersion: 'extract-v2' } });
    expect(next.plan.extractor).toEqual({ modelId: 'newer', promptVersion: 'extract-v2' });
  });

  it('ignored chunks are left out of plan.chunks, and excerpts are redacted before being cut to 80 characters', () => {
    const long = 'abcdefghij'.repeat(12);
    const doc = buildDoc('docs/e.md', [{ title: 'Alpha', paras: [long, { text: 'An ignored paragraph.', directives: { ignore: true } }, 'short one'] }]);
    const plain = planner.merge(doc, null, new Map(), META).plan;
    expect(plain.chunks.map((c) => c.id)).toEqual(['docs/e.md#alpha/h', 'docs/e.md#alpha/p1', 'docs/e.md#alpha/p3']);
    expect(plain.chunks.map((c) => c.excerpt)).toEqual(['Alpha', long.slice(0, 80), 'short one']);
    const redacting = createPlanner({} as ResolvedConfig, (t) => t.toUpperCase());
    const out = redacting.merge(doc, null, new Map(), META).plan;
    expect(out.chunks.map((c) => c.excerpt)).toEqual(['ALPHA', long.toUpperCase().slice(0, 80), 'SHORT ONE']);
    expect(at(out.chunks, 1).excerpt).toHaveLength(80);
  });
});

describe('status', () => {
  it('a doc without a plan is new: every section dirty, everything else empty', () => {
    const doc = billingDoc();
    expect(planner.status([doc], [])).toEqual({
      docs: [{ docUri: 'docs/billing.md', state: 'new', dirtySections: doc.sections.map((s) => s.id), staleFeatures: [], uncovered: [], notTestable: [], unreviewedScenarios: [] }],
    });
  });

  it('a plan without a doc is orphaned and carries its notTestable, uncovered and unreviewed lists', () => {
    const doc = billingDoc();
    const perf = chunkIdOf(doc, BILLING_PARAS.perf);
    const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [upgradeDraft(doc)], [{ chunkId: perf, reason: 'slow' }]));
    expect(planner.status([], [plan])).toEqual({
      docs: [
        {
          docUri: 'docs/billing.md',
          state: 'orphaned',
          dirtySections: [],
          staleFeatures: [],
          uncovered: plan.uncovered,
          notTestable: [perf],
          unreviewedScenarios: ['docs-billing--upgrade-to-pro/upgrade-a-free-account'],
        },
      ],
    });
  });

  it('lists only unreviewed scenarios', () => {
    const doc = billingDoc();
    const plan = mergeFresh(doc, result(firstSectionId(doc, 1), [downgradeDraft(doc)]));
    const [first, second] = at(plan.features, 0).scenarios;
    const accepted = planner.review(plan, (first as Scenario).id, 'accept');
    const st = at(planner.status([doc], [accepted]).docs, 0);
    expect(st.unreviewedScenarios).toEqual([(second as Scenario).id]);
  });

  it('staleFeatures lists only pinned features with changed sources', () => {
    const doc = buildDoc('docs/s.md', [
      { title: 'One', paras: ['One source.'] },
      { title: 'Two', paras: ['Two source.'] },
      { title: 'Three', paras: ['Three source.'] },
    ]);
    const mkDraft = (title: string, text: string): ReturnType<typeof feature> => {
      const r = ref(doc, text);
      return feature(title, [r], [scenario(`${title} s`, [step('when', `${title} acts`, [r])], [r])]);
    };
    const plan = mergeFresh(
      doc,
      result(firstSectionId(doc, 0), [mkDraft('F1', 'One source.')]),
      result(firstSectionId(doc, 1), [mkDraft('F2', 'Two source.')]),
      result(firstSectionId(doc, 2), [mkDraft('F3', 'Three source.')]),
    );
    const pinned = planner.review(planner.review(plan, 'docs-s--f1', 'pin'), 'docs-s--f3', 'pin');
    const fresh = at(planner.status([doc], [pinned]).docs, 0);
    expect(fresh).toMatchObject({ state: 'fresh', dirtySections: [], staleFeatures: [] });
    const edited = buildDoc('docs/s.md', [
      { title: 'One', paras: ['One source edited.'] },
      { title: 'Two', paras: ['Two source edited.'] },
      { title: 'Three', paras: ['Three source.'] },
    ]);
    const stale = at(planner.status([edited], [pinned]).docs, 0);
    expect(stale.state).toBe('stale');
    expect(stale.dirtySections).toEqual(['docs/s.md#one', 'docs/s.md#two']);
    expect(stale.staleFeatures).toEqual(['docs-s--f1']);
  });

  it('a stale pinned feature alone makes the doc stale', () => {
    const doc = billingDoc();
    const plan = mergeFresh(doc, result(firstSectionId(doc, 0), [upgradeDraft(doc)]), result(firstSectionId(doc, 1), []));
    const f = at(plan.features, 0);
    const lost: Feature = { ...structuredClone(f), sectionId: 'docs/billing.md#nowhere', pinned: true, sources: f.sources.map((r) => ({ ...r, hash: 'f'.repeat(64) })) };
    const st = at(planner.status([doc], [{ ...plan, features: [lost] }]).docs, 0);
    expect(st.dirtySections).toEqual([]);
    expect(st.staleFeatures).toEqual([f.id]);
    expect(st.state).toBe('stale');
  });
});

describe('review', () => {
  const doc = billingDoc();
  const plan = mergeFresh(doc, result(firstSectionId(doc, 1), [downgradeDraft(doc)]));
  const feat = at(plan.features, 0);
  const s1 = at(feat.scenarios, 0);
  const s2 = at(feat.scenarios, 1);

  it('the review of a feature follows the states of its scenarios', () => {
    const a1 = planner.review(plan, s1.id, 'accept');
    expect(at(a1.features, 0).review).toBe('unreviewed');
    const a2 = planner.review(a1, s2.id, 'accept');
    expect(at(a2.features, 0).review).toBe('accepted');
    const r1 = planner.review(a2, s1.id, 'reject');
    expect(at(r1.features, 0).review).toBe('unreviewed');
    const r2 = planner.review(r1, s2.id, 'reject');
    expect(at(r2.features, 0).review).toBe('rejected');
    const mixed = planner.review(planner.review(plan, s1.id, 'reject'), s2.id, 'accept');
    expect(at(mixed.features, 0).review).toBe('unreviewed');
  });

  it('accepting a feature without scenarios accepts the feature', () => {
    const empty = mergeFresh(doc, result(firstSectionId(doc, 0), [feature('Empty', [ref(doc, BILLING_PARAS.upgrade)], [])]));
    const id = at(empty.features, 0).id;
    expect(at(planner.review(empty, id, 'accept').features, 0).review).toBe('accepted');
    expect(at(planner.review(empty, id, 'reject').features, 0).review).toBe('rejected');
  });

  it('accepting a scenario removes only its own fingerprint from rejected', () => {
    const both = planner.review(plan, feat.id, 'reject');
    expect(both.rejected.map((r) => r.title)).toEqual([s1.title, s2.title]);
    const one = planner.review(both, s1.id, 'accept');
    expect(one.rejected).toEqual([{ fingerprint: s2.fingerprint, title: s2.title }]);
  });

  it('an unknown id throws SCENARIO_NOT_FOUND with the id in message and details', () => {
    let caught: unknown;
    try {
      planner.review(plan, 'no/such', 'accept');
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ name: 'AiBddError', code: 'SCENARIO_NOT_FOUND', message: 'no feature or scenario with id "no/such"', details: { id: 'no/such' } });
  });
});
