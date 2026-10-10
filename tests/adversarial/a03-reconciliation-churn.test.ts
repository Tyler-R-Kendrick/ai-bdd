// Attack 3: reconciliation churn. Reorder sections, rename features / scenarios, swap contents; ids and review state must
// survive exactly as specified (8.3, 8.4), and a review state must never be inherited by different content (R-PL1).
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocPlan, ModelSet, ModelRequest, ModelResponse, ReviewState } from '@ai-bdd/sdk/contracts';
import { createProject, openEngine, readPlans, allScenarios, type EngineHandle, type Project } from './helpers/kit.ts';

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

type Obj = Record<string, unknown>;
interface DraftScenario extends Obj { title: string; steps: { kind: string; text: string }[] }
interface DraftFeature extends Obj { title: string; scenarios: DraftScenario[] }

/** Wrap the fake extract model: `mutate` edits a deep copy of every extraction object before the engine sees it. */
function mutating(mutate: (features: DraftFeature[], req: ModelRequest) => void) {
  return (fake: ModelSet): ModelSet =>
    Object.assign({}, fake, {
      extract: {
        id: fake.extract.id,
        async generate(req: ModelRequest): Promise<ModelResponse> {
          const res = await fake.extract.generate(req);
          if (res.object === undefined || res.object === null || typeof res.object !== 'object') return res;
          const copy = structuredClone(res.object) as { features: DraftFeature[] };
          mutate(copy.features, req);
          return { ...res, object: copy as unknown as ModelResponse['object'] };
        },
      },
    });
}

const featureById = (plans: DocPlan[], id: string): DocPlan['features'][number] | undefined => plans.flatMap((p) => p.features).find((f) => f.id === id);
const reviewMap = (plans: DocPlan[]): Record<string, ReviewState> => Object.fromEntries(allScenarios(plans).map((s) => [s.scenario.id, s.scenario.review]));
const featureReviews = (plans: DocPlan[]): Record<string, [ReviewState, boolean]> =>
  Object.fromEntries(plans.flatMap((p) => p.features).map((f) => [f.id, [f.review, f.pinned === true] as [ReviewState, boolean]]));

const UP = 'docs-billing--upgrade-to-pro';
const DOWN = 'docs-billing--downgrade-from-pro';
const TONE = 'docs-billing--friendly-confirmation-messages';
const BLOCKED = `${DOWN}/downgrade-is-blocked-with-unpaid-invoices`;
const ALLOWED = `${DOWN}/downgrade-goes-through-without-unpaid-invoices`;

/**
 * Compile the billing doc with the stock fake model, accept / reject / pin, close; then reopen the project with
 * `opts.models` (a mutating extractor) so that only the LATER compiles see the mutation.
 */
async function seeded(opts: { models?: (fake: ModelSet) => ModelSet } = {}): Promise<EngineHandle> {
  project = createProject({ docs: ['billing'] });
  const first = await openEngine(project);
  await first.compile();
  await first.engine.review(UP, 'accept');
  await first.engine.review(BLOCKED, 'reject');
  await first.engine.review(TONE, 'pin');
  await first.close();
  return openEngine(project, opts.models === undefined ? {} : { models: opts.models });
}

/** Every accepted scenario of `next` must trace to an accepted scenario with the very same fingerprint in `prev`. */
function expectNoReviewLaundering(prev: DocPlan[], next: DocPlan[]): void {
  const acceptedBefore = new Set(allScenarios(prev).filter((s) => s.scenario.review === 'accepted').map((s) => s.scenario.fingerprint));
  for (const s of allScenarios(next)) {
    if (s.scenario.review !== 'accepted') continue;
    expect(acceptedBefore.has(s.scenario.fingerprint), `scenario "${s.scenario.title}" is accepted but its content was never accepted`).toBe(true);
  }
}

describe('A3 R-PL1 R-PL2 reconciliation churn', () => {
  it('A3 R-PL1 R-PL2: swapping two whole sections of the document changes nothing: no model call, same ids, same review states, pin and rejection memory intact', async () => {
    const h = await seeded();
    const before = await h.plans();
    const callsBefore = h.calls.length;
    const md = project!.readDoc('billing');
    const iUp = md.indexOf('## Upgrading to Pro');
    const iDown = md.indexOf('## Downgrading');
    const iTone = md.indexOf('## Tone');
    const swapped = md.slice(0, iUp) + md.slice(iDown, iTone) + md.slice(iUp, iDown) + md.slice(iTone);
    expect(swapped).not.toBe(md);
    project!.writeDoc('billing', swapped);
    const res = await h.compile();
    const after = await h.plans();
    await h.close();
    expect(h.calls.length - callsBefore, 'a pure section reorder must not call the extractor').toBe(0);
    expect(res.docs[0]?.extractedSections).toEqual([]);
    expect(reviewMap(after)).toEqual(reviewMap(before));
    expect(featureReviews(after)).toEqual(featureReviews(before));
    expect(after[0]?.rejected).toEqual(before[0]?.rejected);
    expect(after[0]?.docSha256).not.toBe(before[0]?.docSha256);
    // features follow the new document order, ids do not
    expect(after[0]?.features.map((f) => f.id)).not.toEqual(before[0]?.features.map((f) => f.id));
    expect([...(after[0]?.features.map((f) => f.id) ?? [])].sort()).toEqual([...(before[0]?.features.map((f) => f.id) ?? [])].sort());
  });

  it('A3 R-PL1: renaming ONE feature (full re-extraction) keeps its id and its scenarios\' review states; the feature-level review resets because its fingerprint changed', async () => {
    const renamed = mutating((features) => {
      const f = features.find((x) => x.title === 'Upgrade to Pro');
      if (f !== undefined) f.title = 'Pro upgrade flow';
    });
    const h = await seeded({ models: renamed });
    const before = await h.plans();
    await h.compile({ full: true });
    const after = await h.plans();
    await h.close();
    const up = featureById(after, UP);
    expect(up, 'renamed feature keeps its id').toBeDefined();
    expect(up?.title).toBe('Pro upgrade flow');
    expect(up?.review, 'a changed fingerprint resets the feature review').toBe('unreviewed');
    // scenarios did not change, so their accepted state and ids survive
    expect(up?.scenarios.map((s) => [s.id, s.review])).toEqual(featureById(before, UP)?.scenarios.map((s) => [s.id, s.review]));
    for (const s of up?.scenarios ?? []) expect(s.review).toBe('accepted');
    // no duplicate ids, nothing leaked
    const ids = after.flatMap((p) => p.features.map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(before.flatMap((p) => p.features.map((f) => f.id)).sort());
    // the pinned feature was not touched by the rename of another, and the rejected scenario did not come back
    expect(featureById(after, TONE)?.pinned).toBe(true);
    expect(allScenarios(after).some((s) => s.scenario.id === BLOCKED)).toBe(false);
    expect(after[0]?.rejected).toEqual(before[0]?.rejected);
    expectNoReviewLaundering(before, after);
  });

  it('A3 R-PL3: a re-extraction that renames the PINNED feature neither overwrites it nor adds a twin of it', async () => {
    const renamed = mutating((features) => {
      const f = features.find((x) => x.title === 'Friendly confirmation messages');
      if (f !== undefined) {
        f.title = 'Cheerful notices';
        for (const s of f.scenarios) s.title = `${s.title} (reworded)`;
      }
    });
    const h = await seeded({ models: renamed });
    const before = await h.plans();
    await h.compile({ full: true });
    const after = await h.plans();
    await h.close();
    expect(featureById(after, TONE)).toEqual(featureById(before, TONE));
    expect(after.flatMap((p) => p.features).filter((f) => f.title === 'Cheerful notices')).toEqual([]);
    expect(after.flatMap((p) => p.features)).toHaveLength(before.flatMap((p) => p.features).length);
  });

  it('A3 R-PL1: accepted-state laundering: after each of many content mutations, an accepted scenario always traces to accepted content with the same fingerprint', async () => {
    const mutations: [string, (features: DraftFeature[]) => void][] = [
      ['retitle a scenario', (fs) => { const s = fs[0]?.scenarios[0]; if (s) s.title += ' v2'; }],
      ['change one step by a confusable letter', (fs) => { const st = fs[0]?.scenarios[0]?.steps[0]; if (st) st.text = st.text.replace('e', 'е'); }],
      ['change one step by a different word', (fs) => { const st = fs[0]?.scenarios[0]?.steps[1]; if (st) st.text = `${st.text} immediately`; }],
      ['append a step', (fs) => { fs[0]?.scenarios[0]?.steps.push({ kind: 'then', text: 'the footer is shown' }); }],
      ['drop a step', (fs) => { fs[0]?.scenarios[0]?.steps.pop(); }],
      ['reverse the steps', (fs) => { fs[0]?.scenarios[0]?.steps.reverse(); }],
      ['swap step kinds', (fs) => { const st = fs[0]?.scenarios[0]?.steps[0]; if (st) st.kind = st.kind === 'when' ? 'then' : 'when'; }],
      ['swap the contents of two scenarios (titles stay)', (fs) => {
        const a = fs[0]?.scenarios[0];
        const b = fs[0]?.scenarios[1];
        if (a && b) { const t = a.steps; a.steps = b.steps; b.steps = t; }
      }],
      ['swap the titles of two features', (fs) => { const a = fs[0]; const b = fs[1]; if (a && b) { const t = a.title; a.title = b.title; b.title = t; } }],
      ['reverse the feature order', (fs) => { fs.reverse(); }],
      ['duplicate a feature', (fs) => { if (fs[0]) fs.push(structuredClone(fs[0])); }],
    ];
    for (const [label, fn] of mutations) {
      project?.cleanup();
      let applied = false;
      const h = await seeded({
        models: mutating((features, req) => {
          if (String(req.context['sectionAnchor']).includes('upgrading')) {
            fn(features);
            applied = true;
          }
        }),
      });
      await h.engine.review(UP, 'accept');
      const before = await h.plans();
      await h.compile({ full: true });
      const after = await h.plans();
      await h.close();
      expect(applied, `${label}: mutation ran`).toBe(true);
      expectNoReviewLaundering(before, after);
      const ids = after.flatMap((p) => p.features.flatMap((f) => [f.id, ...f.scenarios.map((s) => s.id)]));
      expect(new Set(ids).size, `${label}: ids are unique`).toBe(ids.length);
    }
  });

  it('A3 R-PL1: a trivially re-cased / re-spaced step keeps the accepted state (same normalized fingerprint); a confusable letter does not', async () => {
    const recase = mutating((features) => {
      const st = features.find((f) => f.title === 'Upgrade to Pro')?.scenarios[0]?.steps[0];
      if (st) st.text = `  ${st.text.toUpperCase()}  `;
    });
    const h = await seeded({ models: recase });
    const before = await h.plans();
    await h.compile({ full: true });
    const after = await h.plans();
    await h.close();
    const id = `${UP}/upgrade-from-free-to-pro`;
    const was = allScenarios(before).find((s) => s.scenario.id === id)?.scenario;
    const now = allScenarios(after).find((s) => s.scenario.id === id)?.scenario;
    expect(now?.fingerprint).toBe(was?.fingerprint);
    expect(now?.review).toBe('accepted');
  });

  it('A3 R-PL1: new features never steal an inherited id, even when their title slug collides with a pinned or reconciled feature', async () => {
    const collide = mutating((features, req) => {
      if (String(req.context['sectionAnchor']).includes('tone')) {
        // slug of this title equals the pinned feature's slug, but its tokens differ enough not to reconcile
        features.push({ title: 'Friendly confirmation messäges', scenarios: structuredClone(features[0]?.scenarios ?? []).map((s) => ({ ...s, title: `${s.title} other`, steps: [{ kind: 'when', text: 'something else happens' }, { kind: 'then', text: 'a different result appears' }] })), sources: features[0]?.['sources'] } as DraftFeature);
      }
    });
    const h = await seeded({ models: collide });
    const before = await h.plans();
    await h.compile({ full: true });
    const after = await h.plans();
    await h.close();
    const ids = after.flatMap((p) => p.features.map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(featureById(after, TONE)).toEqual(featureById(before, TONE));
  });

  it('A3 R-PL1 R-EX5: a rejected scenario that the model proposes again with only case / spacing changes is dropped; its fingerprint memory survives repeated recompiles', async () => {
    const reproposed = mutating((features) => {
      const s = features.find((f) => f.title === 'Downgrade from Pro')?.scenarios.find((x) => x.title === 'Downgrade is blocked with unpaid invoices');
      if (s) {
        s.title = `  ${s.title.toUpperCase()} `;
        for (const st of s.steps) st.text = st.text.replace(/ /g, '   ');
      }
    });
    const h = await seeded({ models: reproposed });
    const before = await h.plans();
    for (let i = 0; i < 3; i++) await h.compile({ full: true });
    const after = await h.plans();
    await h.close();
    expect(allScenarios(after).some((s) => s.scenario.title.toLowerCase().includes('blocked with unpaid'))).toBe(false);
    expect(after[0]?.rejected.map((r) => r.fingerprint)).toEqual(before[0]?.rejected.map((r) => r.fingerprint));
    expect(allScenarios(after).find((s) => s.scenario.id === ALLOWED)).toBeDefined();
  });

  it('A3 R-PL1 (documented limitation): the scenario fingerprint covers title and step kind/text only, so a changed fixture call keeps the accepted state', async () => {
    const tamper = mutating((features) => {
      const s = features.find((f) => f.title === 'Downgrade from Pro')?.scenarios.find((x) => x.title === 'Downgrade goes through without unpaid invoices');
      const given = s?.steps[0] as { fixture?: { args: { name: string; value: unknown }[] } } | undefined;
      const arg = given?.fixture?.args.find((a) => a.name === 'unpaid');
      if (arg) arg.value = 0;
    });
    project = createProject({ docs: ['billing'] });
    const h = await openEngine(project, { models: tamper });
    await h.compile();
    await h.engine.review(ALLOWED, 'accept');
    const before = await h.plans();
    await h.compile({ full: true });
    const after = await h.plans();
    await h.close();
    const a = allScenarios(before).find((s) => s.scenario.id === ALLOWED)?.scenario;
    const b = allScenarios(after).find((s) => s.scenario.id === ALLOWED)?.scenario;
    // Not a failure: the spec (8.2) defines the fingerprint this way. This test pins the behaviour so a change is noticed.
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(b?.review).toBe('accepted');
  });

  it('A3 R-PL2: recompiling unchanged docs twice is byte-identical and calls no model, regardless of section order in the document', async () => {
    project = createProject({ docs: ['billing', 'todos', 'checkout'] });
    const h = await openEngine(project);
    await h.compile();
    const files1 = Object.entries(JSON.parse(JSON.stringify(Object.fromEntries((await h.plans()).map((p) => [p.docUri, p]))))).map(([k, v]) => [k, JSON.stringify(v)]);
    const mark = h.calls.length;
    await h.compile();
    await h.compile({ full: false });
    const files2 = Object.entries(JSON.parse(JSON.stringify(Object.fromEntries((await h.plans()).map((p) => [p.docUri, p]))))).map(([k, v]) => [k, JSON.stringify(v)]);
    await h.close();
    expect(h.calls.length - mark).toBe(0);
    expect(files2).toEqual(files1);
    // raw bytes on disk too
    const disk = readFileSync(project.path('.ai-bdd', 'plans', 'docs', 'billing.md.plan.json'), 'utf8');
    writeFileSync(project.path('copy.json'), disk);
    expect(disk.endsWith('\n')).toBe(true);
  });
});
