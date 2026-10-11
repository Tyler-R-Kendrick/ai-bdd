import { describe, expect, it } from 'vitest';
import type { ObservedNode, Selector } from '../../src/contracts/index.ts';
import { deriveSelector, findBySelector } from '../../src/recording/index.ts';
import { node, observation } from './kit.ts';

const sel = (over: Partial<Selector> = {}): Selector => ({ role: 'button', name: 'Go', ancestors: [], index: 0, of: 1, ...over });
const at = (nodes: ObservedNode[], i: number): ObservedNode => nodes[i] as ObservedNode;

describe('deriveSelector parent resolution', () => {
  it('parentRef wins over depth: the referenced node is the parent even when a nearer shallower node precedes the child', () => {
    const nodes = [
      node('region', 'Outer', { ref: 'outer', depth: 0 }),
      node('region', 'Inner', { ref: 'inner', depth: 0 }),
      node('button', 'Go', { ref: 'go', depth: 1, parentRef: 'outer' }),
    ];
    expect(deriveSelector(at(nodes, 2), observation(nodes)).ancestors).toEqual([{ role: 'region', name: 'Outer' }]);
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Outer' }] }), observation(nodes))).toEqual({ status: 'found', node: at(nodes, 2) });
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Inner' }] }), observation(nodes))).toEqual({ status: 'missing' });
  });

  it('parentRef is used when every node carries one, including a parent that comes later in the list', () => {
    const nodes = [
      node('button', 'Go', { ref: 'go', depth: 0, parentRef: 'later' }),
      node('region', 'Later', { ref: 'later', depth: 0, parentRef: 'nowhere' }),
    ];
    expect(deriveSelector(at(nodes, 0), observation(nodes)).ancestors).toEqual([{ role: 'region', name: 'Later' }]);
  });

  it('an unresolvable parentRef falls back to depth; a parentRef pointing at the node itself is ignored', () => {
    const nodes = [
      node('region', 'Top', { ref: 'top', depth: 0 }),
      node('button', 'Lost', { ref: 'lost', depth: 1, parentRef: 'missing' }),
      node('button', 'Self', { ref: 'self', depth: 1, parentRef: 'self' }),
    ];
    const obs = observation(nodes);
    expect(deriveSelector(at(nodes, 1), obs).ancestors).toEqual([{ role: 'region', name: 'Top' }]);
    expect(deriveSelector(at(nodes, 2), obs).ancestors).toEqual([{ role: 'region', name: 'Top' }]);
  });

  it('the first node wins when several share a ref', () => {
    const nodes = [
      node('region', 'First', { ref: 'dup', depth: 0 }),
      node('group', 'Between', { ref: 'b', depth: 0 }),
      node('region', 'Second', { ref: 'dup', depth: 0 }),
      node('button', 'Go', { ref: 'go', depth: 1, parentRef: 'dup' }),
    ];
    expect(deriveSelector(at(nodes, 3), observation(nodes)).ancestors).toEqual([{ role: 'region', name: 'First' }]);
  });

  it('the depth fallback looks only backwards: a shallower node that follows the child is not its parent', () => {
    const nodes = [node('region', 'Before', { depth: 0 }), node('button', 'Go', { depth: 1 }), node('heading', 'After', { depth: 0 })];
    expect(deriveSelector(at(nodes, 1), observation(nodes)).ancestors).toEqual([{ role: 'region', name: 'Before' }]);
  });

  it('a node at the head of the list may still have a parent through its parentRef', () => {
    const nodes = [node('button', 'Go', { ref: 'go', parentRef: 'box' }), node('group', 'Box', { ref: 'box', depth: 0 })];
    expect(deriveSelector(at(nodes, 0), observation(nodes)).ancestors).toEqual([{ role: 'group', name: 'Box' }]);
  });

  it('a parentRef cycle lists every ancestor once and stops', () => {
    const nodes = [
      node('group', 'X', { ref: 'x', depth: 0, parentRef: 'y' }),
      node('group', 'Y', { ref: 'y', depth: 0, parentRef: 'x' }),
      node('button', 'Go', { ref: 'go', depth: 0, parentRef: 'x' }),
    ];
    expect(deriveSelector(at(nodes, 2), observation(nodes)).ancestors).toEqual([
      { role: 'group', name: 'X' },
      { role: 'group', name: 'Y' },
    ]);
  });
});

describe('deriveSelector node lookup', () => {
  it('a node that is not the observed object is located by its ref', () => {
    const nodes = [
      node('region', 'Free', { ref: 'f', depth: 0 }),
      node('button', 'Go', { ref: 'a', depth: 1 }),
      node('region', 'Pro', { ref: 'p', depth: 0 }),
      node('button', 'Go', { ref: 'b', depth: 1 }),
      node('button', 'Go', { ref: 'c', depth: 1 }),
    ];
    const obs = observation(nodes);
    const clone: ObservedNode = { ...at(nodes, 4) };
    expect(deriveSelector(clone, obs)).toEqual({ role: 'button', name: 'Go', ancestors: [{ role: 'region', name: 'Pro' }], index: 1, of: 2 });
  });

  it('the observed object wins over an earlier node that shares its ref', () => {
    const nodes = [node('button', 'Go', { ref: 'dup' }), node('button', 'Go', { ref: 'dup' })];
    expect(deriveSelector(at(nodes, 1), observation(nodes))).toEqual({ role: 'button', name: 'Go', ancestors: [], index: 1, of: 2 });
  });

  it('a node that is not in the observation at all gets index 0 and no ancestors', () => {
    const nodes = [node('region', 'R', { ref: 'r' }), node('button', 'Add', { ref: 'a', depth: 1 }), node('button', 'Add', { ref: 'b', depth: 1 })];
    const stranger = node('button', 'Add', { ref: 'zzz', depth: 1 });
    expect(deriveSelector(stranger, observation(nodes))).toEqual({ role: 'button', name: 'Add', ancestors: [], index: 0, of: 2 });
    expect(deriveSelector(stranger, observation([]))).toEqual({ role: 'button', name: 'Add', ancestors: [], index: 0, of: 1 });
  });
});

describe('deriveSelector testId', () => {
  it('records a non-empty testId and leaves the key out for an absent or empty one', () => {
    const nodes = [node('button', 'A', { testId: 'x' }), node('button', 'B', { testId: '' }), node('button', 'C')];
    const obs = observation(nodes);
    expect(deriveSelector(at(nodes, 0), obs)).toEqual({ role: 'button', name: 'A', testId: 'x', ancestors: [], index: 0, of: 1 });
    const empty = deriveSelector(at(nodes, 1), obs);
    expect('testId' in empty).toBe(false);
    expect(empty).toEqual({ role: 'button', name: 'B', ancestors: [], index: 0, of: 1 });
    expect('testId' in deriveSelector(at(nodes, 2), obs)).toBe(false);
  });
});

describe('findBySelector', () => {
  it('a selector without testId matches nodes whatever their testId is', () => {
    const nodes = [node('button', 'Go', { testId: 'x' })];
    expect(findBySelector(sel(), observation(nodes))).toEqual({ status: 'found', node: at(nodes, 0) });
  });

  it('a selector with a testId matches only nodes that carry exactly that testId', () => {
    const nodes = [node('button', 'Go'), node('button', 'Go', { testId: 'x' })];
    expect(findBySelector(sel({ testId: 'x' }), observation(nodes))).toEqual({ status: 'found', node: at(nodes, 1) });
    expect(findBySelector(sel({ testId: 'y' }), observation(nodes))).toEqual({ status: 'missing' });
  });

  it('ancestors may be matched by a single wanted entry that is the nearest of a longer chain', () => {
    const nodes = [
      node('main', 'Main', { ref: 'm', depth: 0 }),
      node('region', 'Plan', { ref: 'p', depth: 1, parentRef: 'm' }),
      node('button', 'Go', { ref: 'g', depth: 2, parentRef: 'p' }),
    ];
    const obs = observation(nodes);
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Plan' }] }), obs)).toEqual({ status: 'found', node: at(nodes, 2) });
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Plan' }, { role: 'main', name: 'Main' }] }), obs)).toEqual({ status: 'found', node: at(nodes, 2) });
  });

  it('an ancestor must match on its role as well as its name', () => {
    const nodes = [node('region', 'Plan', { ref: 'p', depth: 0 }), node('button', 'Go', { ref: 'g', depth: 1, parentRef: 'p' })];
    const obs = observation(nodes);
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Plan' }] }), obs).status).toBe('found');
    expect(findBySelector(sel({ ancestors: [{ role: 'group', name: 'Plan' }] }), obs)).toEqual({ status: 'missing' });
  });

  it('finds through parentRef when depth alone would name another ancestor', () => {
    const nodes = [
      node('region', 'Outer', { ref: 'outer', depth: 0 }),
      node('region', 'Inner', { ref: 'inner', depth: 0 }),
      node('button', 'Go', { ref: 'go', depth: 1, parentRef: 'inner' }),
      node('button', 'Go', { ref: 'go2', depth: 1, parentRef: 'outer' }),
    ];
    const obs = observation(nodes);
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Inner' }] }), obs)).toEqual({ status: 'found', node: at(nodes, 2) });
    expect(findBySelector(sel({ ancestors: [{ role: 'region', name: 'Outer' }] }), obs)).toEqual({ status: 'found', node: at(nodes, 3) });
  });
});
