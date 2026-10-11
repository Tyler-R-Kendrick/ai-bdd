import { describe, expect, it } from 'vitest';
import type { EffectSignature, Observation, ObservedNode } from '../../src/contracts/index.ts';
import { verifyEffect } from '../../src/recording/verify.ts';
import { node, observation } from './kit.ts';

const effect = (over: Partial<EffectSignature> = {}): EffectSignature => ({ routeBefore: '/a', routeAfter: '/a', appeared: [], disappeared: [], changed: [], ...over });
/** Observations default to the route the helper `effect` records, so a route never decides a verdict by accident. */
const obs = (nodes: ObservedNode[], route = '/a'): Observation => observation(nodes, route);
const NOTHING_NEW = 'no recorded effect element became newly true';

describe('verifyEffect verdict texts', () => {
  it('names the element that failed to appear', () => {
    const v = verifyEffect(effect({ appeared: [{ role: 'status', name: 'Saved' }] }), obs([]), obs([]));
    expect(v).toEqual({ ok: false, detail: 'expected status "Saved" to appear' });
  });

  it('names the element that failed to disappear', () => {
    const gone = [node('button', 'Go')];
    const v = verifyEffect(effect({ disappeared: [{ role: 'button', name: 'Go' }] }), obs(gone), obs(gone));
    expect(v).toEqual({ ok: false, detail: 'expected button "Go" to disappear' });
  });

  it('names the property and the JSON of the expected value when a changed element does not hold', () => {
    const changed = (state: string, to: unknown): EffectSignature =>
      effect({ changed: [{ key: { role: 'textbox', name: 'Email' }, state, from: '', to: to as string }] });
    const before = obs([node('textbox', 'Email')]);
    const after = obs([node('textbox', 'Email', { value: 'x' })]);
    expect(verifyEffect(changed('value', 'a b'), before, after)).toEqual({ ok: false, detail: 'expected textbox "Email" value to be "a b"' });
    expect(verifyEffect(changed('checked', true), before, after)).toEqual({ ok: false, detail: 'expected textbox "Email" checked to be true' });
    expect(verifyEffect(changed('value', 'x"y'), before, after)).toEqual({ ok: false, detail: 'expected textbox "Email" value to be "x\\"y"' });
  });

  it('reports a changed element that is missing or ambiguous in the after observation', () => {
    const e = effect({ changed: [{ key: { role: 'button', name: 'Dup' }, state: 'disabled', from: false, to: true }] });
    const detail = 'expected button "Dup" disabled to be true';
    expect(verifyEffect(e, obs([]), obs([]))).toEqual({ ok: false, detail });
    const two = obs([node('button', 'Dup', { states: { disabled: true } }), node('button', 'Dup', { states: { disabled: true } })]);
    expect(verifyEffect(e, obs([]), two)).toEqual({ ok: false, detail });
  });

  it('names both routes when the route does not match', () => {
    const v = verifyEffect(effect({ routeBefore: '/a', routeAfter: '/b' }), obs([], '/a'), obs([], '/c'));
    expect(v).toEqual({ ok: false, detail: 'expected route /b, got /c' });
  });
});

describe('verifyEffect newly-true accounting', () => {
  it('a disappeared element counts when it was present before', () => {
    const e = effect({ disappeared: [{ role: 'button', name: 'Go' }] });
    expect(verifyEffect(e, obs([node('button', 'Go')]), obs([]))).toEqual({ ok: true });
  });

  it('a disappeared element that was not there before does not count', () => {
    const e = effect({ disappeared: [{ role: 'button', name: 'Go' }] });
    expect(verifyEffect(e, obs([]), obs([]))).toEqual({ ok: false, detail: NOTHING_NEW });
  });

  it('an appeared element counts when it was absent before, and not when it was already there', () => {
    const e = effect({ appeared: [{ role: 'status', name: 'Saved' }] });
    expect(verifyEffect(e, obs([]), obs([node('status', 'Saved')]))).toEqual({ ok: true });
    expect(verifyEffect(e, obs([node('status', 'Saved')]), obs([node('status', 'Saved')]))).toEqual({ ok: false, detail: NOTHING_NEW });
  });

  it('a changed element counts when its property did not already hold in before', () => {
    const e = effect({ changed: [{ key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: true }] });
    expect(verifyEffect(e, obs([node('checkbox', 'Agree')]), obs([node('checkbox', 'Agree', { states: { checked: true } })]))).toEqual({ ok: true });
  });

  it('a changed element does not count when ANY node of the before group already held the value', () => {
    const e = effect({ changed: [{ key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: true }] });
    const before = obs([node('checkbox', 'Agree', { states: { checked: true } }), node('checkbox', 'Agree')]);
    const after = obs([node('checkbox', 'Agree', { states: { checked: true } })]);
    expect(verifyEffect(e, before, after)).toEqual({ ok: false, detail: NOTHING_NEW });
  });

  it('a changed element that was absent before counts as newly true', () => {
    const e = effect({ changed: [{ key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: false }] });
    expect(verifyEffect(e, obs([]), obs([node('checkbox', 'Agree')]))).toEqual({ ok: true });
  });

  it('every kind of newly true element adds up: none of them cancels another', () => {
    const appeared = { role: 'status', name: 'Saved' };
    const disappeared = { role: 'button', name: 'Go' };
    const changed = { key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: true };
    const before = obs([node('button', 'Go'), node('checkbox', 'Agree')], '/a');
    const after = obs([node('status', 'Saved'), node('checkbox', 'Agree', { states: { checked: true } })], '/b');
    const all = effect({ routeBefore: '/a', routeAfter: '/b', appeared: [appeared], disappeared: [disappeared], changed: [changed] });
    expect(verifyEffect(all, before, after)).toEqual({ ok: true });
    // each pair, so that a decrement anywhere would cancel an increment somewhere
    expect(verifyEffect(effect({ routeBefore: '/a', routeAfter: '/b', appeared: [appeared] }), obs([], '/a'), obs([node('status', 'Saved')], '/b'))).toEqual({ ok: true });
    expect(verifyEffect(effect({ appeared: [appeared], changed: [changed] }), before, obs([node('status', 'Saved'), node('checkbox', 'Agree', { states: { checked: true } })], '/a'))).toEqual({ ok: true });
    expect(verifyEffect(effect({ appeared: [appeared], disappeared: [disappeared] }), before, obs([node('status', 'Saved')], '/a'))).toEqual({ ok: true });
  });
});

describe('verifyEffect route accounting', () => {
  it('a route that stays the same is not an effect', () => {
    expect(verifyEffect(effect(), obs([], '/a'), obs([], '/a'))).toEqual({ ok: false, detail: NOTHING_NEW });
  });

  it('a recorded route that stays the same is not an effect even if the replay started elsewhere', () => {
    expect(verifyEffect(effect({ routeBefore: '/a', routeAfter: '/a' }), obs([], '/elsewhere'), obs([], '/a'))).toEqual({ ok: false, detail: NOTHING_NEW });
  });

  it('a route change counts when the replay started on a different route', () => {
    const e = effect({ routeBefore: '/a', routeAfter: '/b' });
    expect(verifyEffect(e, obs([], '/a'), obs([], '/b'))).toEqual({ ok: true });
  });

  it('a route change does not count when the replay already started on the target route', () => {
    const e = effect({ routeBefore: '/a', routeAfter: '/b' });
    expect(verifyEffect(e, obs([], '/b'), obs([], '/b'))).toEqual({ ok: false, detail: NOTHING_NEW });
  });
});
