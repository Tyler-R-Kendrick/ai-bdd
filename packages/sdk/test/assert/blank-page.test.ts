import { describe, expect, it } from 'vitest';
import type { Predicate } from '../../src/contracts/index.ts';
import { allSatisfied, evaluatePredicates } from '../../src/assert/evaluate.ts';
import { leaf, makeObs, type NodeSpec } from './helpers.ts';

const absent: Predicate = { op: 'exists', negate: true, query: { role: 'button', name: 'Delete account' } };
const none: Predicate = { op: 'count', cmp: 'eq', value: 0, query: { role: 'alert' } };
const atMost: Predicate = { op: 'count', cmp: 'lte', value: 2, query: { role: 'alert' } };
const some: Predicate = { op: 'exists', query: { role: 'heading', name: 'Billing' } };

const PAGE: NodeSpec[] = [{ role: 'document', name: 'Acme', children: [leaf('heading', 'Billing')] }];

describe('a page that shows nothing cannot show that something is absent', () => {
  it('on an observation without any node, absence and "none" and "at most" predicates are unknown, so the check fails instead of passing vacuously', () => {
    const blank = makeObs([]);
    for (const p of [absent, none, atMost]) {
      const [r] = evaluatePredicates([p], blank, {});
      expect(r?.satisfied, JSON.stringify(p)).toBe('unknown');
      expect(r?.actual).toMatchObject({ matches: 0, blank: true });
    }
    expect(allSatisfied(evaluatePredicates([absent, none], blank, {}))).toBe(false);
  });

  it('on a real page the same predicates keep their meaning: absence passes where the element is absent', () => {
    const page = makeObs(PAGE);
    expect(evaluatePredicates([absent, none, atMost], page, {}).map((r) => r.satisfied)).toEqual([true, true, true]);
    expect(allSatisfied(evaluatePredicates([absent, none, atMost, some], page, {}))).toBe(true);
  });

  it('positive predicates and non-vacuous counts on a blank page are simply false', () => {
    const blank = makeObs([]);
    expect(evaluatePredicates([some], blank, {})[0]?.satisfied).toBe(false);
    expect(evaluatePredicates([{ op: 'count', cmp: 'eq', value: 3, query: { role: 'alert' } }], blank, {})[0]?.satisfied).toBe(false);
    expect(evaluatePredicates([{ op: 'count', cmp: 'gte', value: 1, query: { role: 'alert' } }], blank, {})[0]?.satisfied).toBe(false);
    expect(evaluatePredicates([{ op: 'route', match: 'equals', value: '/' }], blank, {})[0]?.satisfied).toBe(true);
  });
});
