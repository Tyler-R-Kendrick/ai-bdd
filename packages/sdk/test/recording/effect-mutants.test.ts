import { describe, expect, it } from 'vitest';
import { compareKeys, compareStrings, computeEffect } from '../../src/recording/effect.ts';
import { node, observation } from './kit.ts';

describe('compareStrings / compareKeys', () => {
  it('orders by code unit and returns exactly -1, 1 or 0', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
    expect(compareStrings('B', 'a')).toBe(-1);
    expect(compareStrings('', 'a')).toBe(-1);
    expect(compareStrings('a', '')).toBe(1);
  });

  it('compares the role first and the name only for equal roles', () => {
    expect(compareKeys({ role: 'a', name: 'z' }, { role: 'b', name: 'a' })).toBe(-1);
    expect(compareKeys({ role: 'b', name: 'a' }, { role: 'a', name: 'z' })).toBe(1);
    expect(compareKeys({ role: 'a', name: 'b' }, { role: 'a', name: 'a' })).toBe(1);
    expect(compareKeys({ role: 'a', name: 'a' }, { role: 'a', name: 'b' })).toBe(-1);
    expect(compareKeys({ role: 'a', name: 'a' }, { role: 'a', name: 'a' })).toBe(0);
  });
});

describe('computeEffect ordering', () => {
  it('sorts appeared and disappeared by role, then name, whichever way the nodes arrive', () => {
    const nodes = [node('link', 'A'), node('button', 'B'), node('button', 'A'), node('alert', 'Z')];
    const expected = [
      { role: 'alert', name: 'Z' },
      { role: 'button', name: 'A' },
      { role: 'button', name: 'B' },
      { role: 'link', name: 'A' },
    ];
    for (const order of [nodes, [...nodes].reverse(), [nodes[1], nodes[3], nodes[0], nodes[2]] as typeof nodes]) {
      expect(computeEffect(observation([]), observation(order)).appeared).toEqual(expected);
      expect(computeEffect(observation(order), observation([])).disappeared).toEqual(expected);
    }
  });

  it('sorts changed entries by key first and by state name second', () => {
    const before = observation([
      node('textbox', 'Zed', { value: '' }),
      node('checkbox', 'Agree', { value: '', states: { checked: false, selected: false } }),
      node('checkbox', 'Also', { states: { pressed: false } }),
    ]);
    const after = observation([
      node('textbox', 'Zed', { value: 'x' }),
      node('checkbox', 'Agree', { value: 'v', states: { checked: true, selected: true } }),
      node('checkbox', 'Also', { states: { pressed: true } }),
    ]);
    expect(computeEffect(before, after).changed).toEqual([
      { key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: true },
      { key: { role: 'checkbox', name: 'Agree' }, state: 'selected', from: false, to: true },
      { key: { role: 'checkbox', name: 'Agree' }, state: 'value', from: '', to: 'v' },
      { key: { role: 'checkbox', name: 'Also' }, state: 'pressed', from: false, to: true },
      { key: { role: 'textbox', name: 'Zed' }, state: 'value', from: '', to: 'x' },
    ]);
  });
});

describe('computeEffect volatile groups', () => {
  it('a group is volatile when any one of its nodes has a volatile value (appeared and disappeared)', () => {
    const group = [node('textbox', 'Clock', { value: '' }), node('textbox', 'Clock', { value: '12:30' })];
    expect(computeEffect(observation([]), observation(group)).appeared).toEqual([]);
    expect(computeEffect(observation(group), observation([])).disappeared).toEqual([]);
  });

  it('a node with a volatile value is excluded even when its name is stable', () => {
    const volatile = [node('textbox', 'Added at', { value: '2026-10-09' })];
    expect(computeEffect(observation([]), observation(volatile)).appeared).toEqual([]);
    expect(computeEffect(observation(volatile), observation([])).disappeared).toEqual([]);
    const stable = [node('textbox', 'Added at', { value: 'yesterday' })];
    expect(computeEffect(observation([]), observation(stable)).appeared).toEqual([{ role: 'textbox', name: 'Added at' }]);
    expect(computeEffect(observation(stable), observation([])).disappeared).toEqual([{ role: 'textbox', name: 'Added at' }]);
  });

  it('a group whose name is volatile is excluded even when all values are stable', () => {
    const named = [node('status', 'Synced 10:15', { value: 'ok' })];
    expect(computeEffect(observation([]), observation(named)).appeared).toEqual([]);
    expect(computeEffect(observation(named), observation([])).disappeared).toEqual([]);
  });

  it('no change is reported for a node whose (unchanged) name is volatile', () => {
    const before = observation([node('checkbox', 'Reminder 10:15', { states: { checked: false } })]);
    const after = observation([node('checkbox', 'Reminder 10:15', { states: { checked: true } })]);
    expect(computeEffect(before, after).changed).toEqual([]);
  });

  it('a value change is dropped when the old value is volatile, when the new one is, and kept when neither is', () => {
    const change = (from: string, to: string) =>
      computeEffect(observation([node('textbox', 'Note', { value: from })]), observation([node('textbox', 'Note', { value: to })])).changed;
    expect(change('10:15', 'done')).toEqual([]);
    expect(change('done', '10:15')).toEqual([]);
    expect(change('draft', 'done')).toEqual([{ key: { role: 'textbox', name: 'Note' }, state: 'value', from: 'draft', to: 'done' }]);
  });
});

describe('computeEffect with duplicate keys', () => {
  it('reports no change when the key is duplicated in only one of the two observations', () => {
    const one = [node('button', 'Dup')];
    const two = [node('button', 'Dup', { states: { disabled: true } }), node('button', 'Dup')];
    expect(computeEffect(observation(two), observation([node('button', 'Dup')])).changed).toEqual([]);
    expect(computeEffect(observation(one), observation(two)).changed).toEqual([]);
  });
});

describe('computeEffect afterProbe identity of appeared groups', () => {
  const dup = (extra: Parameters<typeof node>[2] = {}) => node('button', 'Item', extra);

  it('a group whose size differs in the probe is not stable and does not appear', () => {
    const after = observation([dup(), dup()]);
    const probe = observation([dup()]);
    expect(computeEffect(observation([]), after, probe).appeared).toEqual([]);
    expect(computeEffect(observation([]), after).appeared).toEqual([{ role: 'button', name: 'Item' }]);
  });

  it('a group of several nodes is stable when its size matches the probe, whatever the nodes hold', () => {
    const after = observation([dup({ value: 'a' }), dup()]);
    const probe = observation([dup({ value: 'other' }), dup({ states: { disabled: true } })]);
    expect(computeEffect(observation([]), after, probe).appeared).toEqual([{ role: 'button', name: 'Item' }]);
  });

  it('a single node is stable only when its tracked properties match the probe', () => {
    const probeSame = observation([dup({ value: 'v', states: { checked: true } })]);
    const after = observation([dup({ value: 'v', states: { checked: true } })]);
    expect(computeEffect(observation([]), after, probeSame).appeared).toEqual([{ role: 'button', name: 'Item' }]);
    expect(computeEffect(observation([]), after, observation([dup({ value: 'w', states: { checked: true } })])).appeared).toEqual([]);
    expect(computeEffect(observation([]), after, observation([dup({ value: 'v' })])).appeared).toEqual([]);
    expect(computeEffect(observation([]), after, observation([])).appeared).toEqual([]);
  });
});
