import { describe, expect, it } from 'vitest';
import type { DocPlan, ResolvedConfig } from '../../src/contracts/index.ts';
import { createPlanner } from '../../src/plan/index.ts';
import { sha256Hex, stableJson } from '../../src/util/index.ts';
import type { JsonValue } from '../../src/contracts/index.ts';
import {
  BILLING_PARAS,
  META,
  billingDoc,
  buildDoc,
  downgradeDraft,
  feature,
  firstSectionId,
  mapOf,
  ref,
  result,
  failedResult,
  scenario,
  step,
  upgradeDraft,
} from './fixtures.ts';

const planner = createPlanner({} as ResolvedConfig);
const json = (p: DocPlan): string => stableJson(p as unknown as JsonValue);

function firstCompile(doc = billingDoc()): DocPlan {
  const r = planner.merge(
    doc,
    null,
    mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)]), result(firstSectionId(doc, 1), [downgradeDraft(doc)])),
    META,
  );
  return r.plan;
}

describe('R-EX1: incremental compile is byte-identical when nothing changed', () => {
  it('R-EX1: second merge with no extraction results reproduces the plan bytes and finds no dirty sections', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    expect(planner.dirtySections(doc, plan, { full: false })).toEqual([]);
    const again = planner.merge(doc, plan, new Map(), META);
    expect(json(again.plan)).toBe(json(plan));
    expect(again.added).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.diagnostics).toEqual([]);
  });

  it('R-EX1: with no previous plan every section is dirty; with full:true too', () => {
    const doc = billingDoc();
    expect(planner.dirtySections(doc, null, { full: false })).toEqual(doc.sections.map((s) => s.id));
    expect(planner.dirtySections(doc, firstCompile(doc), { full: true })).toEqual(doc.sections.map((s) => s.id));
  });

  it('R-EX1: plan carries no timestamps and the extractor meta only changes when something was extracted', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    expect(json(plan)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const again = planner.merge(doc, plan, new Map(), { extractor: { modelId: 'other', promptVersion: 'x' } });
    expect(again.plan.extractor).toEqual(META.extractor);
  });

  it('R-EX1: first merge builds ids, keys and fingerprints per §8.1/§8.2', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const f = plan.features[0];
    expect(f?.id).toBe('docs-billing--upgrade-to-pro');
    const s = f?.scenarios[0];
    expect(s?.id).toBe('docs-billing--upgrade-to-pro/upgrade-a-free-account');
    expect(s?.featureId).toBe(f?.id);
    expect(s?.steps[0]?.key).toBe(`given:${sha256Hex('the customer is on the free plan').slice(0, 12)}`);
    expect(s?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(s?.review).toBe('unreviewed');
    for (const c of plan.chunks) expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    for (const r of f?.sources ?? []) expect(r.hash).toBe(doc.chunks.find((c) => c.id === r.chunkId)?.hash);
  });

  it('R-EX1: duplicate titles get -2, -3 suffixes and identical steps get #2 keys', () => {
    const doc = billingDoc();
    const r = ref(doc, BILLING_PARAS.upgrade);
    const f = (): ReturnType<typeof feature> =>
      feature('Same title', [r], [
        scenario('Same scenario', [step('when', 'the customer clicks Upgrade', [r]), step('when', 'the customer clicks Upgrade', [r]), step('then', 'it works', [r])], [r]),
        scenario('Same scenario', [step('when', 'something else happens', [r]), step('then', 'it works', [r])], [r]),
      ]);
    const plan = planner.merge(doc, null, mapOf(result(firstSectionId(doc, 0), [f(), f()])), META).plan;
    expect(plan.features.map((x) => x.id)).toEqual(['docs-billing--same-title', 'docs-billing--same-title-2']);
    const first = plan.features[0];
    expect(first?.scenarios.map((s) => s.id)).toEqual(['docs-billing--same-title/same-scenario', 'docs-billing--same-title/same-scenario-2']);
    const keys = first?.scenarios[0]?.steps.map((s) => s.key) ?? [];
    expect(keys[1]).toBe(`${keys[0]}#2`);
  });
});

describe('R-EX4: coverage', () => {
  it('R-EX4: uncovered lists chunks not cited as source; headings, ignored, context and notTestable are excluded', () => {
    const doc = buildDoc('docs/a.md', [
      {
        title: 'Alpha',
        paras: [
          'First covered paragraph about logging in.',
          'Second paragraph nobody cites at all.',
          { text: 'An ignored paragraph.', directives: { ignore: true } },
          { text: 'A context paragraph.', directives: { context: true } },
          'Performance must be great.',
          'Third uncited paragraph.',
        ],
      },
    ]);
    const r = ref(doc, 'First covered paragraph about logging in.');
    const nt = { chunkId: doc.chunks.find((c) => c.text === 'Performance must be great.')?.id ?? '', reason: 'not UI' };
    const plan = planner.merge(
      doc,
      null,
      mapOf(result(firstSectionId(doc, 0), [feature('Login', [r], [scenario('Log in', [step('when', 'the user logs in', [r]), step('then', 'the dashboard shows', [r])], [r])])], [nt])),
      META,
    ).plan;
    expect(plan.uncovered).toEqual(['docs/a.md#alpha/p2', 'docs/a.md#alpha/p6']);
    expect(plan.notTestable).toEqual([nt]);
    const st = planner.status([doc], [plan]).docs[0];
    expect(st?.uncovered).toEqual(plan.uncovered);
    expect(st?.notTestable).toEqual([nt.chunkId]);
  });

  it('R-EX4: rejected scenarios no longer cover their sources (uncovered refreshed on review)', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const upId = plan.features[0]?.scenarios[0]?.id ?? '';
    const before = plan.uncovered;
    const rejected = planner.review(plan, upId, 'reject');
    expect(rejected.uncovered).toContain(doc.chunks.find((c) => c.text === BILLING_PARAS.upgrade)?.id);
    expect(before).not.toContain(doc.chunks.find((c) => c.text === BILLING_PARAS.upgrade)?.id);
    const re = planner.merge(doc, rejected, new Map(), META).plan;
    expect(re.uncovered).toEqual(rejected.uncovered);
  });

  it('R-EX4: notTestable of re-extracted sections is replaced; of untouched sections is kept and relocated', () => {
    const doc = billingDoc();
    const perf = doc.chunks.find((c) => c.text === BILLING_PARAS.perf)?.id ?? '';
    const plan = planner.merge(
      doc,
      null,
      mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)], [{ chunkId: perf, reason: 'non-functional' }]), result(firstSectionId(doc, 1), [downgradeDraft(doc)])),
      META,
    ).plan;
    expect(plan.notTestable).toEqual([{ chunkId: perf, reason: 'non-functional' }]);
    // Move the perf paragraph into the other section: still notTestable, no section dirty.
    const moved = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade] },
      { title: 'Downgrading', paras: [BILLING_PARAS.downgrade, BILLING_PARAS.invoices, BILLING_PARAS.perf] },
    ]);
    expect(planner.dirtySections(moved, plan, { full: false })).toEqual([]);
    const re = planner.merge(moved, plan, new Map(), META).plan;
    expect(re.notTestable).toEqual([{ chunkId: 'docs/billing.md#downgrading/p3', reason: 'non-functional' }]);
    // Re-extracting the upgrading section without the notTestable entry drops it.
    const edited = billingDoc({ upgrade: 'Customers can upgrade at any moment from the billing page.' });
    const re2 = planner.merge(edited, plan, mapOf(result(firstSectionId(edited, 0), [upgradeDraft(edited)])), META).plan;
    expect(re2.notTestable).toEqual([]);
  });
});

describe('R-EX5: rejected scenarios never come back', () => {
  it('R-EX5: review reject stores the scenario fingerprint and title and marks it rejected', () => {
    const plan = firstCompile();
    const s = plan.features[0]?.scenarios[0];
    const out = planner.review(plan, s?.id ?? '', 'reject');
    expect(out.rejected).toEqual([{ fingerprint: s?.fingerprint, title: s?.title }]);
    expect(out.features[0]?.scenarios[0]?.review).toBe('rejected');
    expect(plan.rejected).toEqual([]); // input untouched
  });

  it('R-EX5: a re-proposed scenario with a rejected fingerprint is dropped on a full recompile', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const down = plan.features[1]?.scenarios[0];
    const rejected = planner.review(plan, down?.id ?? '', 'reject');
    const re = planner.merge(
      doc,
      rejected,
      mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)]), result(firstSectionId(doc, 1), [downgradeDraft(doc)])),
      META,
    );
    const ids = re.plan.features.flatMap((f) => f.scenarios.map((s) => s.title));
    expect(ids).not.toContain('Downgrade a pro account');
    expect(ids).toContain('Downgrade blocked by unpaid invoices');
    expect(re.plan.rejected).toEqual(rejected.rejected);
  });

  it('R-EX5: rejecting a feature rejects all its scenarios; when everything proposed is rejected the feature is not re-proposed', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const fid = plan.features[1]?.id ?? '';
    const rejected = planner.review(plan, fid, 'reject');
    expect(rejected.features[1]?.review).toBe('rejected');
    expect(rejected.features[1]?.scenarios.every((s) => s.review === 'rejected')).toBe(true);
    expect(rejected.rejected).toHaveLength(2);
    const re = planner.merge(doc, rejected, mapOf(result(firstSectionId(doc, 1), [downgradeDraft(doc)])), META).plan;
    expect(re.features.map((f) => f.title)).toEqual(['Upgrade to Pro']);
  });

  it('R-EX5: accept after reject restores the scenario and removes the fingerprint from rejected', () => {
    const plan = firstCompile();
    const id = plan.features[0]?.scenarios[0]?.id ?? '';
    const back = planner.review(planner.review(plan, id, 'reject'), id, 'accept');
    expect(back.rejected).toEqual([]);
    expect(back.features[0]?.scenarios[0]?.review).toBe('accepted');
    expect(back.features[0]?.review).toBe('accepted');
  });

  it('R-EX5: unknown ids fail with SCENARIO_NOT_FOUND', () => {
    expect(() => planner.review(firstCompile(), 'nope', 'accept')).toThrowError(expect.objectContaining({ code: 'SCENARIO_NOT_FOUND' }));
  });
});

describe('R-PL1: ids and review survive recompiles', () => {
  it('R-PL1: matching by fingerprint keeps ids and review state', () => {
    const doc = billingDoc();
    const plan = planner.review(firstCompile(doc), 'docs-billing--upgrade-to-pro', 'accept');
    const re = planner.merge(doc, plan, mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)])), META).plan;
    expect(re.features[0]?.id).toBe('docs-billing--upgrade-to-pro');
    expect(re.features[0]?.review).toBe('accepted');
    expect(re.features[0]?.scenarios[0]?.review).toBe('accepted');
  });

  it('R-PL1: a renamed feature with the same title-less content still matches via Jaccard and keeps its id', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const edited = billingDoc({ upgrade: 'Customers can upgrade from Free to Pro on the billing page.' });
    const renamed = upgradeDraft(edited, 'Moving to the Pro plan');
    const out = planner.merge(edited, plan, mapOf(result(firstSectionId(edited, 0), [renamed])), META);
    expect(out.plan.features.find((f) => f.title === 'Moving to the Pro plan')?.id).toBe('docs-billing--upgrade-to-pro');
    expect(out.updated).toContain('docs-billing--upgrade-to-pro');
  });

  it('R-PL1: equal normalized title matches even when the steps changed, and a changed fingerprint resets review to unreviewed', () => {
    const doc = billingDoc();
    const plan = planner.review(firstCompile(doc), 'docs-billing--upgrade-to-pro', 'accept');
    const r = ref(doc, BILLING_PARAS.upgrade);
    const changed = feature('  UPGRADE to pro ', [r], [
      scenario('Upgrade a free account', [step('given', 'a free customer'), step('when', 'they pick the Pro plan', [r]), step('then', 'billing confirms the new plan', [r])], [r]),
    ]);
    const out = planner.merge(doc, plan, mapOf(result(firstSectionId(doc, 0), [changed])), META).plan;
    const f = out.features.find((x) => x.sectionId === firstSectionId(doc, 0));
    expect(f?.id).toBe('docs-billing--upgrade-to-pro');
    expect(f?.review).toBe('unreviewed');
    expect(f?.scenarios[0]?.id).toBe('docs-billing--upgrade-to-pro/upgrade-a-free-account');
    expect(f?.scenarios[0]?.review).toBe('unreviewed');
  });

  it('R-PL1: scenario-level review survives when only a sibling scenario changed', () => {
    const doc = billingDoc();
    const base = firstCompile(doc);
    const blocked = base.features[1]?.scenarios[1]?.id ?? '';
    const plan = planner.review(base, blocked, 'accept');
    const draft = downgradeDraft(doc);
    const first = draft.scenarios[0];
    if (first === undefined) throw new Error('fixture');
    first.steps = [...first.steps, step('then', 'a confirmation email is sent', first.sources)];
    const out = planner.merge(doc, plan, mapOf(result(firstSectionId(doc, 1), [draft])), META).plan;
    const f = out.features.find((x) => x.id === 'docs-billing--downgrade-to-free');
    expect(f?.review).toBe('unreviewed');
    expect(f?.scenarios[0]?.review).toBe('unreviewed');
    expect(f?.scenarios[1]?.review).toBe('accepted');
    expect(f?.scenarios[1]?.id).toBe(blocked);
  });

  it('R-PL1: unmatched previous features are reported removed; unmatched drafts get fresh non-colliding ids', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const other = feature('Completely unrelated zebra topic', [ref(doc, BILLING_PARAS.upgrade)], [
      scenario('Zebra crossing', [step('when', 'zebras cross'), step('then', 'traffic stops')], [ref(doc, BILLING_PARAS.upgrade)]),
    ]);
    const out = planner.merge(doc, plan, mapOf(result(firstSectionId(doc, 0), [other])), META);
    expect(out.removed).toContain('docs-billing--upgrade-to-pro');
    expect(out.removed).toContain('docs-billing--upgrade-to-pro/upgrade-a-free-account');
    expect(out.added).toContain('docs-billing--completely-unrelated-zebra-topic');
    expect(out.plan.features.map((f) => f.id)).toEqual(['docs-billing--completely-unrelated-zebra-topic', 'docs-billing--downgrade-to-free']);
  });

  it('R-PL1: a fresh id never steals an id inherited by another feature of the same doc', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    // The new draft has the title of the existing first feature but lives in the other section's extraction.
    const r = ref(doc, BILLING_PARAS.downgrade);
    const d = feature('Upgrade to Pro', [r], [scenario('Zebra crossing', [step('when', 'zebras cross the road', [r]), step('then', 'traffic stops completely', [r])], [r])]);
    const out = planner.merge(doc, plan, mapOf(result(firstSectionId(doc, 1), [d])), META).plan;
    const ids = out.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('docs-billing--upgrade-to-pro');
    expect(ids).toContain('docs-billing--upgrade-to-pro-2');
  });

  it('R-PL1: directives flow into scenarios: first driver/start wins, tags union, fuzzy becomes @fuzzy', () => {
    const doc = buildDoc('docs/d.md', [
      {
        title: 'Dir',
        paras: [
          { text: 'First paragraph of the directive doc.', directives: { driver: 'playwright', start: '/first', tags: ['a', 'b'], fuzzy: true } },
          { text: 'Second paragraph of the directive doc.', directives: { driver: 'fake', start: '/second', tags: ['b', 'c'] } },
        ],
      },
    ]);
    const r1 = ref(doc, 'First paragraph of the directive doc.');
    const r2 = ref(doc, 'Second paragraph of the directive doc.');
    const plan = planner.merge(
      doc,
      null,
      mapOf(result(firstSectionId(doc, 0), [feature('Dir feature', [r1, r2], [scenario('Dir scenario', [step('when', 'x happens', [r1]), step('then', 'y shows', [r2])], [r1, r2], ['own'])])])),
      META,
    ).plan;
    const s = plan.features[0]?.scenarios[0];
    expect(s?.driver).toBe('playwright');
    expect(s?.startUrl).toBe('/first');
    expect(s?.tags).toEqual(['own', 'a', 'b', 'c', '@fuzzy']);
    expect(plan.features[0]?.tags).toEqual(['a', 'b', 'c']);
  });

  it('R-PL1: features are ordered by the document position of their first source chunk, then title', () => {
    const doc = billingDoc();
    const up = upgradeDraft(doc);
    const down = downgradeDraft(doc);
    const plan = planner.merge(doc, null, mapOf(result(firstSectionId(doc, 1), [down]), result(firstSectionId(doc, 0), [up])), META).plan;
    expect(plan.features.map((f) => f.title)).toEqual(['Upgrade to Pro', 'Downgrade to Free']);
  });

  it('R-PL1: drafts citing unknown chunks or no source at all are not planned (defence in depth)', () => {
    const doc = billingDoc();
    const ghost = feature('Ghost', [{ chunkId: 'docs/billing.md#nope/p1', relation: 'source' }], [scenario('Ghost run', [step('when', 'a ghost')], [])]);
    const plan = planner.merge(doc, null, mapOf(result(firstSectionId(doc, 0), [ghost, upgradeDraft(doc)])), META).plan;
    expect(plan.features.map((f) => f.title)).toEqual(['Upgrade to Pro']);
  });
});

describe('R-PL2: staleness by chunk hash with move relocation', () => {
  it('R-PL2: editing a paragraph dirties exactly its section', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const edited = billingDoc({ downgrade: 'Customers can downgrade from Pro to Free whenever they like.' });
    expect(planner.dirtySections(edited, plan, { full: false })).toEqual([firstSectionId(edited, 1)]);
  });

  it('R-PL2: deleting an uncited paragraph or adding a paragraph dirties its section', () => {
    const plan = firstCompile();
    const deleted = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade] },
      { title: 'Downgrading', paras: [BILLING_PARAS.downgrade, BILLING_PARAS.invoices] },
    ]);
    expect(planner.dirtySections(deleted, plan, { full: false })).toEqual(['docs/billing.md#upgrading']);
    const withNew = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade, BILLING_PARAS.perf] },
      { title: 'Downgrading', paras: [BILLING_PARAS.downgrade, BILLING_PARAS.invoices, 'A brand new paragraph appears.'] },
    ]);
    expect(planner.dirtySections(withNew, plan, { full: false })).toEqual(['docs/billing.md#downgrading']);
  });

  it('R-PL2: moving an unedited cited paragraph within a section relocates refs and dirties nothing', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const reordered = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade, BILLING_PARAS.perf] },
      { title: 'Downgrading', paras: [BILLING_PARAS.invoices, BILLING_PARAS.downgrade] },
    ]);
    expect(planner.dirtySections(reordered, plan, { full: false })).toEqual([]);
    const re = planner.merge(reordered, plan, new Map(), META);
    const down = re.plan.features.find((f) => f.id === 'docs-billing--downgrade-to-free');
    const idOfDowngrade = reordered.chunks.find((c) => c.text === BILLING_PARAS.downgrade)?.id;
    expect(down?.sources[0]?.chunkId).toBe(idOfDowngrade);
    expect(down?.scenarios[0]?.steps[1]?.sources[0]?.chunkId).toBe(idOfDowngrade);
    expect(down?.sources[0]?.hash).toBe(sha256Hex(BILLING_PARAS.downgrade));
    expect(planner.status([reordered], [re.plan]).docs[0]?.state).toBe('fresh');
  });

  it('R-PL2: moving a cited paragraph into another section relocates the ref and dirties neither section', () => {
    const plan = firstCompile();
    const moved = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade, BILLING_PARAS.perf, BILLING_PARAS.invoices] },
      { title: 'Downgrading', paras: [BILLING_PARAS.downgrade] },
    ]);
    expect(planner.dirtySections(moved, plan, { full: false })).toEqual([]);
    const re = planner.merge(moved, plan, new Map(), META).plan;
    const down = re.features.find((f) => f.id === 'docs-billing--downgrade-to-free');
    expect(down?.scenarios[1]?.sources[0]?.chunkId).toBe('docs/billing.md#upgrading/p3');
    expect(down?.sectionId).toBe('docs/billing.md#downgrading');
  });

  it('R-PL2: a ref whose old hash matches several current chunks is ambiguous and the section is dirty', () => {
    const dupText = 'The same sentence appears twice in this document.';
    const other = 'Some other paragraph that sits in between them.';
    const doc = buildDoc('docs/dup.md', [{ title: 'Dups', paras: [dupText, dupText, other] }]);
    const r = ref(doc, dupText);
    const second = { ...r, chunkId: 'docs/dup.md#dups/p2' };
    const plan = planner.merge(doc, null, mapOf(result(firstSectionId(doc, 0), [feature('Dups', [second], [scenario('Dup', [step('when', 'x', [second]), step('then', 'y', [second])], [second])])])), META).plan;
    expect(planner.dirtySections(doc, plan, { full: false })).toEqual([]);
    // Same multiset of chunks, but the cited copy's id now holds other text and the old hash sits at two other places.
    const reordered = buildDoc('docs/dup.md', [{ title: 'Dups', paras: [dupText, other, dupText] }]);
    expect(planner.dirtySections(reordered, plan, { full: false })).toEqual(['docs/dup.md#dups']);
    // A reorder that leaves exactly one candidate is a clean move.
    const unique = buildDoc('docs/dup.md', [{ title: 'Dups', paras: [dupText, dupText, other] }]);
    expect(planner.dirtySections(unique, plan, { full: false })).toEqual([]);
  });

  it('R-PL2: renaming a section heading changes its id, so the section is dirty and its old features are dropped', () => {
    const plan = firstCompile();
    const renamed = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade, BILLING_PARAS.perf] },
      { title: 'Going down', paras: [BILLING_PARAS.downgrade, BILLING_PARAS.invoices] },
    ]);
    expect(planner.dirtySections(renamed, plan, { full: false })).toEqual(['docs/billing.md#going-down']);
  });

  it('R-PL2: context chunk changes never dirty a section; context refs are refreshed with PLAN_CONTEXT_CHANGED', () => {
    const ctxText = 'Glossary: a plan is Free or Pro.';
    const doc = buildDoc('docs/c.md', [{ title: 'Main', paras: ['The customer can pick a plan.', { text: ctxText, directives: { context: true } }] }]);
    const src = ref(doc, 'The customer can pick a plan.');
    const ctx = ref(doc, ctxText, 'context');
    const plan = planner.merge(doc, null, mapOf(result(firstSectionId(doc, 0), [feature('Pick a plan', [src, ctx], [scenario('Pick', [step('when', 'a plan is picked', [src]), step('then', 'it is shown', [src])], [src])])])), META).plan;
    const edited = buildDoc('docs/c.md', [{ title: 'Main', paras: ['The customer can pick a plan.', { text: 'Glossary: plans are Free, Pro or Team.', directives: { context: true } }] }]);
    expect(planner.dirtySections(edited, plan, { full: false })).toEqual([]);
    const out = planner.merge(edited, plan, new Map(), META);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['PLAN_CONTEXT_CHANGED']);
    const ctxRef = out.plan.features[0]?.sources.find((r) => r.relation === 'context');
    expect(ctxRef?.hash).toBe(sha256Hex('Glossary: plans are Free, Pro or Team.'));
    // After the refresh the warning does not repeat.
    expect(planner.merge(edited, out.plan, new Map(), META).diagnostics).toEqual([]);
  });

  it('R-PL2: status reports new, orphaned, stale and fresh; --frozen callers key off state !== fresh', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const other = buildDoc('docs/other.md', [{ title: 'Other', paras: ['Some other paragraph here.'] }]);
    const edited = billingDoc({ upgrade: 'Customers can upgrade from the Free plan to the Pro plan at checkout.' });
    const gone: DocPlan = { ...plan, docUri: 'docs/gone.md' };
    const status = planner.status([doc, other], [plan, gone]);
    expect(status.docs.map((d) => [d.docUri, d.state])).toEqual([
      ['docs/billing.md', 'fresh'],
      ['docs/gone.md', 'orphaned'],
      ['docs/other.md', 'new'],
    ]);
    expect(status.docs[2]?.dirtySections).toEqual(['docs/other.md#other']);
    const stale = planner.status([edited], [plan]).docs[0];
    expect(stale?.state).toBe('stale');
    expect(stale?.dirtySections).toEqual(['docs/billing.md#upgrading']);
    expect(stale?.unreviewedScenarios).toHaveLength(3);
  });

  it('R-PL2: a failed section keeps its previous features and previous hash, and stays dirty', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const edited = billingDoc({ downgrade: 'Customers can downgrade from Pro to Free whenever they like.' });
    const sid = firstSectionId(edited, 1);
    const out = planner.merge(edited, plan, mapOf(failedResult(sid)), META);
    expect(out.diagnostics.map((d) => d.code)).toContain('EXTRACT_SECTION_FAILED');
    expect(out.plan.features.map((f) => f.id)).toEqual(plan.features.map((f) => f.id));
    expect(out.plan.sections.find((s) => s.id === sid)).toEqual({ id: sid, hash: plan.sections[1]?.hash, failed: true });
    expect(planner.dirtySections(edited, out.plan, { full: false })).toEqual([sid]);
    expect(planner.status([edited], [out.plan]).docs[0]?.state).toBe('stale');
  });

  it('R-PL2: a dirty section absent from the extraction map is treated as failed; a new doc section that fails gets no features', () => {
    const doc = billingDoc();
    const out = planner.merge(doc, null, mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)])), META);
    expect(out.plan.features.map((f) => f.title)).toEqual(['Upgrade to Pro']);
    const failed = out.plan.sections.find((s) => s.id === firstSectionId(doc, 1));
    expect(failed?.failed).toBe(true);
    expect(planner.dirtySections(doc, out.plan, { full: false })).toEqual([firstSectionId(doc, 1)]);
  });
});

describe('R-PL3: pinned features are never overwritten', () => {
  it('R-PL3: pin and unpin toggle the flag on the feature (also via a scenario id) without mutating the input', () => {
    const plan = firstCompile();
    const scenarioId = plan.features[0]?.scenarios[0]?.id ?? '';
    const pinned = planner.review(plan, scenarioId, 'pin');
    expect(pinned.features[0]?.pinned).toBe(true);
    expect(plan.features[0]?.pinned).toBeUndefined();
    const unpinned = planner.review(pinned, 'docs-billing--upgrade-to-pro', 'unpin');
    expect('pinned' in (unpinned.features[0] ?? {})).toBe(false);
  });

  it('R-PL3: a pinned feature survives a re-extraction of its section verbatim and the matching draft is discarded', () => {
    const doc = billingDoc();
    const pinned = planner.review(firstCompile(doc), 'docs-billing--upgrade-to-pro', 'pin');
    const edited = billingDoc({ perf: 'The billing page should load in under one second.' });
    const draft = upgradeDraft(edited, 'Upgrade to Pro');
    draft.scenarios[0]?.steps.push(step('then', 'a thank-you banner is shown'));
    const out = planner.merge(edited, pinned, mapOf(result(firstSectionId(edited, 0), [draft])), META);
    expect(out.plan.features.filter((f) => f.sectionId === firstSectionId(edited, 0))).toHaveLength(1);
    expect(out.plan.features[0]).toEqual(pinned.features[0]);
    expect(out.diagnostics.map((d) => d.code)).not.toContain('PLAN_PINNED_STALE');
  });

  it('R-PL3: a pinned feature whose source changed is kept, warned (PLAN_PINNED_STALE) and listed in staleFeatures', () => {
    const doc = billingDoc();
    const pinned = planner.review(firstCompile(doc), 'docs-billing--upgrade-to-pro', 'pin');
    const edited = billingDoc({ upgrade: 'Customers can upgrade from Free to Pro whenever they like.' });
    const out = planner.merge(edited, pinned, mapOf(result(firstSectionId(edited, 0), [])), META);
    expect(out.plan.features[0]?.id).toBe('docs-billing--upgrade-to-pro');
    expect(out.plan.features[0]?.pinned).toBe(true);
    expect(out.plan.features[0]?.sources[0]?.hash).toBe(sha256Hex(BILLING_PARAS.upgrade));
    expect(out.diagnostics.map((d) => d.code)).toContain('PLAN_PINNED_STALE');
    const st = planner.status([edited], [out.plan]).docs[0];
    expect(st?.staleFeatures).toEqual(['docs-billing--upgrade-to-pro']);
    expect(st?.state).toBe('stale');
  });

  it('R-PL3: a pinned feature survives when its section disappears (re-homed to the section now holding its source)', () => {
    const doc = billingDoc();
    const pinned = planner.review(firstCompile(doc), 'docs-billing--downgrade-to-free', 'pin');
    const renamed = buildDoc('docs/billing.md', [
      { title: 'Upgrading', paras: [BILLING_PARAS.upgrade, BILLING_PARAS.perf] },
      { title: 'Going down', paras: [BILLING_PARAS.downgrade, BILLING_PARAS.invoices] },
    ]);
    const out = planner.merge(renamed, pinned, mapOf(result('docs/billing.md#going-down', [])), META);
    const f = out.plan.features.find((x) => x.id === 'docs-billing--downgrade-to-free');
    expect(f?.pinned).toBe(true);
    expect(f?.sectionId).toBe('docs/billing.md#going-down');
    expect(f?.sources[0]?.chunkId).toBe('docs/billing.md#going-down/p1');
  });
});

describe('R-EX1: planner is pure', () => {
  it('R-EX1: merge does not mutate its inputs', () => {
    const doc = billingDoc();
    const plan = firstCompile(doc);
    const before = json(plan);
    const edited = billingDoc({ downgrade: 'Customers can downgrade whenever they like, from Pro to Free.' });
    const map = mapOf(result(firstSectionId(edited, 1), [downgradeDraft(edited)]));
    const mapBefore = JSON.stringify([...map]);
    planner.merge(edited, plan, map, META);
    planner.review(plan, 'docs-billing--upgrade-to-pro', 'reject');
    expect(json(plan)).toBe(before);
    expect(JSON.stringify([...map])).toBe(mapBefore);
  });
});
