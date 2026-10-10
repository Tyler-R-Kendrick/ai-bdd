import { describe, expect, it } from 'vitest';
import { computeEffect } from '../../src/recording/index.ts';
import { isVolatileText } from '../../src/recording/volatile.ts';
import { node, observation } from './kit.ts';

describe('computeEffect', () => {
  it('R-CH7: reports appeared, disappeared and route on normalized keys', () => {
    const before = observation([node('button', 'Upgrade to Pro'), node('heading', 'Plan: Free')], '/billing');
    const after = observation([node('heading', 'Plan:  Free'), node('status', 'Upgraded to Pro'), node('link', 'Receipt')], '/billing/done');
    const e = computeEffect(before, after);
    expect(e.routeBefore).toBe('/billing');
    expect(e.routeAfter).toBe('/billing/done');
    expect(e.appeared).toEqual([{ role: 'link', name: 'Receipt' }, { role: 'status', name: 'Upgraded to Pro' }]);
    expect(e.disappeared).toEqual([{ role: 'button', name: 'Upgrade to Pro' }]);
    expect(e.changed).toEqual([]);
  });

  it('R-CH7: reports changed states and values only for keys unique in both observations', () => {
    const before = observation([
      node('checkbox', 'Agree', { states: { checked: false } }),
      node('textbox', 'Email'),
      node('button', 'Dup'),
      node('button', 'Dup'),
    ]);
    const after = observation([
      node('checkbox', 'Agree', { states: { checked: true } }),
      node('textbox', 'Email', { value: 'a@b.c' }),
      node('button', 'Dup', { states: { disabled: true } }),
      node('button', 'Dup'),
    ]);
    const e = computeEffect(before, after);
    expect(e.changed).toEqual([
      { key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: true },
      { key: { role: 'textbox', name: 'Email' }, state: 'value', from: '', to: 'a@b.c' },
    ]);
  });

  it('R-CH7: unset states count as false, and focus/busy are not application effects', () => {
    const before = observation([node('button', 'Save')]);
    const after = observation([node('button', 'Save', { states: { focused: true, busy: true, disabled: false } })]);
    const e = computeEffect(before, after);
    expect(e.changed).toEqual([]);
  });

  it('R-CH7: ignores unnamed nodes', () => {
    const e = computeEffect(observation([]), observation([node('generic', ''), node('button', '   ')]));
    expect(e.appeared).toEqual([]);
  });

  it('R-CH7: output is deterministic and sorted regardless of node order', () => {
    const a = [node('link', 'B'), node('button', 'A'), node('link', 'A')];
    const e1 = computeEffect(observation([]), observation(a));
    const e2 = computeEffect(observation([]), observation([...a].reverse()));
    expect(e1).toEqual(e2);
    expect(e1.appeared.map((k) => `${k.role}:${k.name}`)).toEqual(['button:A', 'link:A', 'link:B']);
  });

  it('R-CH7: volatile names and values are excluded from the effect', () => {
    const before = observation([node('status', 'Synced 10:15'), node('textbox', 'Added at', { value: '' }), node('button', 'Add')]);
    const after = observation([
      node('status', 'Synced 10:16'),
      node('textbox', 'Added at', { value: '2026-10-09' }),
      node('listitem', 'Order 123456'),
      node('listitem', 'Order #deadbeef1234'),
      node('listitem', 'Buy milk'),
      node('button', 'Add'),
    ]);
    const e = computeEffect(before, after);
    expect(e.appeared).toEqual([{ role: 'listitem', name: 'Buy milk' }]);
    expect(e.disappeared).toEqual([]);
    expect(e.changed).toEqual([]);
  });

  it('R-CH7: excludes elements that do not hold identically in afterProbe', () => {
    const before = observation([node('button', 'Old'), node('checkbox', 'Opt', { states: { checked: false } })]);
    const after = observation([
      node('status', 'Saved'),
      node('status', 'Flash message'),
      node('alert', 'Shown value', { value: 'a' }),
      node('checkbox', 'Opt', { states: { checked: true } }),
    ]);
    const probe = observation([
      node('status', 'Saved'),
      node('alert', 'Shown value', { value: 'b' }),
      node('button', 'Old'),
      node('checkbox', 'Opt', { states: { checked: false } }),
    ]);
    const e = computeEffect(before, after, probe);
    expect(e.appeared).toEqual([{ role: 'status', name: 'Saved' }]);
    expect(e.disappeared).toEqual([]);
    expect(e.changed).toEqual([]);
    expect(computeEffect(before, after).appeared.length).toBe(3);
  });

  it('R-CH7: stable changes survive the afterProbe filter', () => {
    const before = observation([node('checkbox', 'Opt', { states: { checked: false } }), node('button', 'Gone')]);
    const after = observation([node('checkbox', 'Opt', { states: { checked: true } })]);
    const e = computeEffect(before, after, after);
    expect(e.changed).toHaveLength(1);
    expect(e.disappeared).toEqual([{ role: 'button', name: 'Gone' }]);
  });
});

describe('local volatile patterns (SPEC 10.4)', () => {
  it.each([
    ['12:30', true],
    ['at 9:05:11.250 today', true],
    ['2026-10-09', true],
    ['10/9/26', true],
    ['123e4567-e89b-12d3-a456-426614174000', true],
    ['deadbeef1', true],
    ['deadbeef', false],
    ['12345678', true],
    ['1234', false],
    ['3 minutes ago', true],
    ['Just now', true],
    ['Upgrade to Pro', false],
    ['Plan: Free', false],
    ['abcdefgh', false],
  ])('classifies %j as volatile=%s', (text, expected) => {
    expect(isVolatileText(text)).toBe(expected);
  });

  it('R-AS2: adversarial 100k-char inputs stay linear-time', () => {
    for (const s of ['a'.repeat(100_000), '1'.repeat(100_000), '1:'.repeat(50_000), 'deadbeef'.repeat(12_500), '1 '.repeat(50_000) + 'x']) {
      const t = performance.now();
      isVolatileText(s);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });
});
