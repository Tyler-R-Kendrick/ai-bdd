import { describe, expect, it } from 'vitest';
import { effectSatisfied, computeEffect } from '@ai-bdd/act';
import type { EffectSignature, Observation, ObservedNode } from '@ai-bdd/contracts';

/** Attack 6: make a replay pass when the effect did not happen. */
function observation(nodes: ObservedNode[], route = '/settings/billing'): Observation {
  return { revision: 1, nodes, treeHash: JSON.stringify(nodes), route, tainted: false, maskingProven: true, settled: true, capturedAt: '2026-10-09T00:00:00.000Z' };
}

const badge: ObservedNode = { ref: 'r1', role: 'text', name: 'Plan: Pro plan' };
const upgrade: EffectSignature = { elements: [{ selector: { role: 'text', name: 'Plan: Pro plan' }, change: 'appeared' }] };

describe('attack 6: effect already present before the replay', () => {
  it('does not count an element that was already there as a verified effect', () => {
    const before = observation([badge]);
    const after = observation([badge]);
    expect(effectSatisfied(upgrade, before, after)).toBe(false);
  });

  it('counts an element that appears during the replay', () => {
    const before = observation([{ ref: 'r1', role: 'text', name: 'Plan: Free plan' }]);
    const after = observation([badge]);
    expect(effectSatisfied(upgrade, before, after)).toBe(true);
  });

  it('requires a route change to be a change on the after state', () => {
    const before = observation([], '/settings/billing');
    const after = observation([], '/dashboard');
    const routeEffect: EffectSignature = { elements: [], route: { after: '/dashboard' } };
    expect(effectSatisfied(routeEffect, before, after)).toBe(true);
    // The route was already /dashboard before the replay, so nothing was verified.
    expect(effectSatisfied(routeEffect, observation([], '/dashboard'), after)).toBe(false);
  });

  it('computes a diff that ignores identical nodes', () => {
    const before = observation([{ ref: 'a', role: 'text', name: 'Plan: Free plan' }]);
    const after = observation([{ ref: 'b', role: 'text', name: 'Plan: Pro plan' }]);
    const effect = computeEffect(before, after);
    expect(effect.elements.map((element) => element.change).sort()).toEqual(['appeared', 'disappeared']);
  });
});
