import { describe, expect, it } from 'vitest';
import type { Predicate } from '../../src/contracts/index.ts';
import { evaluatePredicates } from '../../src/assert/index.ts';
import { buildNodes, makeObs, type NodeSpec } from './helpers.ts';

function wideTree(n: number): NodeSpec[] {
  const regions: NodeSpec[] = [];
  const perRegion = 20;
  for (let r = 0; r * perRegion < n; r += 1) {
    regions.push({
      role: 'region', name: `Region ${r}`,
      children: Array.from({ length: perRegion }, (_, i) => ({
        role: i % 3 === 0 ? 'button' : i % 3 === 1 ? 'listitem' : 'link', name: `Item ${r}-${i}`, states: i % 5 === 0 ? { disabled: true } : {},
      })),
    });
  }
  return [{ role: 'main', name: 'Content', children: regions }];
}

const PREDICATES: Predicate[] = [
  { op: 'exists', query: { role: 'button', name: 'item 3-0' } },
  { op: 'count', query: { role: 'listitem', within: { role: 'region', name: 'Region 7' } }, cmp: 'gte', value: 1 },
  { op: 'count', query: { role: 'link', name: 'item', nameMatch: 'contains' }, cmp: 'gte', value: 1 },
  { op: 'text', query: { role: 'button', name: 'Item 9-0' }, match: 'equals', value: { literal: 'item 9-0' } },
  { op: 'state', query: { role: 'button', name: 'Item 9-0' }, state: 'disabled', value: true },
  { op: 'exists', query: { role: 'tab' }, negate: true },
  { op: 'exists', query: { role: 'button', within: { role: 'main', name: 'Content' } } },
  { op: 'route', match: 'prefix', value: '/' },
];

function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('evaluation time is linear in node count (R-AS3)', () => {
  it('R-AS3: 8 predicates over 10k nodes finish in under 50ms', () => {
    const obs = makeObs(buildNodes(wideTree(10_000)), '/billing');
    expect(obs.nodes.length).toBeGreaterThanOrEqual(10_000);
    evaluatePredicates(PREDICATES, obs, {}); // warm up
    expect(bestOf(5, () => evaluatePredicates(PREDICATES, obs, {}))).toBeLessThan(50);
  });

  it('R-AS3: 4x the nodes costs well under 16x the time', () => {
    const small = makeObs(buildNodes(wideTree(10_000)), '/');
    const large = makeObs(buildNodes(wideTree(40_000)), '/');
    evaluatePredicates(PREDICATES, small, {});
    const ts = Math.max(bestOf(5, () => evaluatePredicates(PREDICATES, small, {})), 0.2);
    const tl = bestOf(5, () => evaluatePredicates(PREDICATES, large, {}));
    expect(tl).toBeLessThan(ts * 10 + 5);
  });

  it('R-AS3: a 10k-deep chain with a within query does not go quadratic', () => {
    const depth = 10_000;
    const nodes = buildNodes([{ role: 'group', name: 'Root' }]);
    for (let i = 1; i < depth; i += 1) {
      nodes.push({ ref: `d${i}`, role: i === depth - 1 ? 'button' : 'group', name: `G${i}`, states: {}, depth: i, parentRef: i === 1 ? nodes[0]!.ref : `d${i - 1}` });
    }
    const obs = makeObs(nodes);
    const preds: Predicate[] = [
      { op: 'exists', query: { role: 'button', within: { role: 'group', name: 'Root' } } },
      { op: 'exists', query: { role: 'button', within: { role: 'group', name: 'Absent' } }, negate: true },
    ];
    evaluatePredicates(preds, obs, {});
    expect(bestOf(5, () => expect(evaluatePredicates(preds, obs, {}).every((r) => r.satisfied === true)).toBe(true))).toBeLessThan(50);
  });

  it('R-AS3: many distinct within keys stay linear per key', () => {
    const obs = makeObs(buildNodes(wideTree(10_000)), '/');
    const preds: Predicate[] = Array.from({ length: 8 }, (_, i) => ({
      op: 'count', query: { role: 'button', within: { role: 'region', name: `Region ${i}` } }, cmp: 'gte', value: 1,
    }));
    evaluatePredicates(preds, obs, {});
    expect(bestOf(5, () => evaluatePredicates(preds, obs, {}))).toBeLessThan(50);
  });
});
