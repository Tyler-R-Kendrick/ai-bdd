// @ts-nocheck
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObservedNode } from '../../src/contracts/index.ts';
import { deriveSelector, findBySelector } from '../../src/recording/index.ts';
import { fromTrees, node, observation } from './kit.ts';

const RUNS = Number(process.env.FC_RUNS ?? 200);
const ROLES = ['button', 'link', 'textbox', 'region', 'form', 'listitem', 'heading'];
const NAMES = ['', 'Save', 'Cancel', 'Plan', 'Billing', '  Pay   now ', 'Pay now'];

const entry = fc.record({
  role: fc.constantFrom(...ROLES),
  name: fc.constantFrom(...NAMES),
  testId: fc.option(fc.constantFrom('a', 'b'), { nil: undefined }),
  step: fc.integer({ min: 0, max: 3 }),
  withParentRef: fc.boolean(),
});

/** Generated pre-order trees (depth consistent with parents), with duplicates on purpose. */
const observations = fc.array(entry, { minLength: 1, maxLength: 40 }).map((entries) => {
  const nodes: ObservedNode[] = [];
  const stack: ObservedNode[] = [];
  entries.forEach((e, i) => {
    const depth = Math.min(e.step === 0 ? 0 : (stack.length), Math.max(0, stack.length - (e.step - 1)));
    stack.length = depth;
    const n: ObservedNode = { ref: `n${i}`, role: e.role, name: e.name, states: {}, depth };
    if (e.testId !== undefined) n.testId = e.testId;
    const parent = stack[stack.length - 1];
    if (parent !== undefined && e.withParentRef) n.parentRef = parent.ref;
    nodes.push(n);
    stack.push(n);
  });
  return observation(nodes);
});

describe('deriveSelector / findBySelector', () => {
  it('R-CH7: round trip over generated observations returns the same node, duplicates included', () => {
    fc.assert(
      fc.property(observations, (obs) => {
        for (const n of obs.nodes) {
          const sel = deriveSelector(n, obs);
          const r = findBySelector(sel, obs);
          expect(r.status).toBe('found');
          if (r.status === 'found') expect(r.node).toBe(n);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('R-CH7: observations with unique selectors derive of=1,index=0 and round-trip', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.constantFrom(...ROLES), fc.string({ minLength: 1, maxLength: 8 })), { minLength: 1, maxLength: 20, selector: ([r, n]) => `${r}|${n.replace(/\s+/g, ' ').trim()}` }),
        (pairs) => {
          const nodes = pairs.map(([role, name], i) => node(role, name, { ref: `u${i}` }));
          const obs = observation(nodes);
          for (const n of nodes) {
            if (n.name.trim() === '') continue;
            const sel = deriveSelector(n, obs);
            expect(sel.of).toBe(1);
            expect(sel.index).toBe(0);
            const r = findBySelector(sel, obs);
            expect(r.status === 'found' && r.node === n).toBe(true);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('R-CH7: records at most 3 named ancestors, nearest first, skipping unnamed ones', () => {
    const nodes = fromTrees([
      { role: 'main', name: 'Main', children: [{ role: 'region', name: 'Plan', children: [{ role: 'group', name: '', children: [{ role: 'form', name: 'Upgrade', children: [{ role: 'button', name: 'Go' }] }] }] }] },
    ]);
    const obs = observation(nodes);
    const sel = deriveSelector(nodes[nodes.length - 1] as ObservedNode, obs);
    expect(sel.ancestors).toEqual([
      { role: 'form', name: 'Upgrade' },
      { role: 'region', name: 'Plan' },
      { role: 'main', name: 'Main' },
    ]);
    const deep = fromTrees([{ role: 'a', name: 'A', children: [{ role: 'b', name: 'B', children: [{ role: 'c', name: 'C', children: [{ role: 'd', name: 'D', children: [{ role: 'button', name: 'X' }] }] }] }] }]);
    expect(deriveSelector(deep[4] as ObservedNode, observation(deep)).ancestors.map((a) => a.name)).toEqual(['D', 'C', 'B']);
  });

  it('R-CH7: falls back to depth when parentRef is absent', () => {
    const nodes = fromTrees([{ role: 'region', name: 'Plan', children: [{ role: 'button', name: 'Go' }] }]).map((n) => {
      const { parentRef: _p, ...rest } = n;
      return rest;
    });
    expect(deriveSelector(nodes[1] as ObservedNode, observation(nodes)).ancestors).toEqual([{ role: 'region', name: 'Plan' }]);
  });

  it('R-CH7: ancestors disambiguate identical buttons (of counts role+name+testId+ancestors)', () => {
    const nodes = fromTrees([
      { role: 'region', name: 'Free', children: [{ role: 'button', name: 'Upgrade' }] },
      { role: 'region', name: 'Pro', children: [{ role: 'button', name: 'Upgrade' }] },
    ]);
    const obs = observation(nodes);
    const second = nodes[3] as ObservedNode;
    const sel = deriveSelector(second, obs);
    expect(sel).toMatchObject({ of: 1, index: 0, ancestors: [{ role: 'region', name: 'Pro' }] });
    const r = findBySelector(sel, obs);
    expect(r.status === 'found' && r.node === second).toBe(true);
  });

  it('R-CH7: index is the 0-based document position among identical candidates', () => {
    const nodes = [node('button', 'Add'), node('button', 'Add'), node('button', 'Add')];
    const obs = observation(nodes);
    expect(deriveSelector(nodes[2] as ObservedNode, obs)).toMatchObject({ of: 3, index: 2 });
  });

  it('R-CH7: testId narrows the candidates and is part of the selector', () => {
    const nodes = [node('button', 'Add', { testId: 'x' }), node('button', 'Add', { testId: 'y' })];
    const obs = observation(nodes);
    const sel = deriveSelector(nodes[1] as ObservedNode, obs);
    expect(sel).toMatchObject({ testId: 'y', of: 1, index: 0 });
    expect(findBySelector({ ...sel, testId: 'zzz' }, obs)).toEqual({ status: 'missing' });
  });

  it('R-CH7: reports missing when nothing matches (role, name or ancestors)', () => {
    const nodes = fromTrees([{ role: 'region', name: 'Plan', children: [{ role: 'button', name: 'Go' }] }]);
    const obs = observation(nodes);
    const sel = deriveSelector(nodes[1] as ObservedNode, obs);
    expect(findBySelector({ ...sel, role: 'link' }, obs).status).toBe('missing');
    expect(findBySelector({ ...sel, name: 'Stop' }, obs).status).toBe('missing');
    expect(findBySelector({ ...sel, ancestors: [{ role: 'region', name: 'Other' }] }, obs).status).toBe('missing');
  });

  it('R-CH7: cardinality change is ambiguous, never silently picks one', () => {
    const one = [node('button', 'Add')];
    const sel = deriveSelector(one[0] as ObservedNode, observation(one));
    expect(sel.of).toBe(1);
    const two = observation([node('button', 'Add'), node('button', 'Add')]);
    expect(findBySelector(sel, two)).toEqual({ status: 'ambiguous', count: 2 });

    const three = [node('button', 'Add'), node('button', 'Add'), node('button', 'Add')];
    const sel3 = deriveSelector(three[1] as ObservedNode, observation(three));
    expect(findBySelector(sel3, observation([node('button', 'Add'), node('button', 'Add')]))).toEqual({ status: 'ambiguous', count: 2 });
  });

  it('R-CH7: matches names after whitespace normalization and tolerates ancestor subsequences', () => {
    const nodes = fromTrees([
      { role: 'main', name: 'Main', children: [{ role: 'region', name: 'Plan', children: [{ role: 'button', name: '  Pay   now ' }] }] },
    ]);
    const obs = observation(nodes);
    const sel = deriveSelector(nodes[2] as ObservedNode, obs);
    expect(sel.name).toBe('Pay now');
    // Recorded with only the outer ancestor: an ordered subsequence of the live chain still matches.
    const r = findBySelector({ ...sel, ancestors: [{ role: 'main', name: 'Main' }] }, obs);
    expect(r.status).toBe('found');
    // Order matters: nearest first.
    expect(findBySelector({ ...sel, ancestors: [{ role: 'main', name: 'Main' }, { role: 'region', name: 'Plan' }] }, obs).status).toBe('missing');
  });

  it('R-CH7: an out-of-range index is missing rather than a throw', () => {
    const obs = observation([node('button', 'Add')]);
    expect(findBySelector({ role: 'button', name: 'Add', ancestors: [], index: 5, of: 1 }, obs)).toEqual({ status: 'missing' });
  });
});
