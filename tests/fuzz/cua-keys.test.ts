import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseKey, type CuaKey } from '@ai-bdd/driver-cua';
import { PROTO_KEYS, hostileString, params } from './helpers.ts';

const META = process.platform === 'darwin' ? 'cmd' : 'super';
const MODIFIER_NAMES: Record<string, string[]> = {
  ctrl: ['Control', 'Ctrl', 'control', 'CTRL'],
  shift: ['Shift', 'shift', 'SHIFT'],
  alt: ['Alt', 'Option', 'alt', 'option'],
  [META]: ['Meta', 'Cmd', 'Command', 'Super', 'Win', 'meta', 'COMMAND'],
};
const NAMED: [string, string][] = [
  ['Enter', 'enter'], ['Return', 'return'], ['Tab', 'tab'], ['Escape', 'escape'], ['Esc', 'escape'], ['Space', 'space'], [' ', 'space'], ['Backspace', 'backspace'],
  ['Delete', 'delete'], ['Del', 'delete'], ['Insert', 'insert'], ['Home', 'home'], ['End', 'end'], ['PageUp', 'pageup'], ['PageDown', 'pagedown'],
  ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'], ['Up', 'up'], ['Down', 'down'], ['Left', 'left'], ['Right', 'right'],
];
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const KNOWN_KEY_VALUES = new Set(NAMED.map(([, v]) => v));
const KNOWN_MODIFIERS = new Set(Object.keys(MODIFIER_NAMES));

/** Canonical spelling of a parsed key; `parseKey(format(k))` must give `k` back. */
function format(k: CuaKey): string {
  const mods = k.modifiers.map((m) => ({ ctrl: 'Control', shift: 'Shift', alt: 'Alt', cmd: 'Meta', super: 'Meta' })[m] as string);
  const key = k.key === '+' ? '+' : k.key;
  return [...mods, key].join('+');
}

const modifierSet = fc.subarray(Object.keys(MODIFIER_NAMES), { maxLength: 4 }).chain((mods) =>
  fc.tuple(...mods.map((m) => fc.constantFrom(...(MODIFIER_NAMES[m] as string[])))).map((spelled) => ({ mods, spelled })),
);
const keyArb = fc.oneof(
  fc.constantFrom(...NAMED).map(([spec, key]) => ({ spec, key })),
  fc.constantFrom(...FUNCTION_KEYS).map((spec) => ({ spec, key: spec.toLowerCase() })),
  fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }).filter((c) => c !== '+' && c.length === 1).map((c) => ({ spec: c, key: NAMED.find(([s]) => s.toLowerCase() === c.toLowerCase())?.[1] ?? c })),
  fc.constant({ spec: '+', key: '+' }),
);

describe('fuzz: parseKey', () => {
  it('never throws, and returns undefined or a well-formed key (known name, function key or single character; known modifiers, no duplicates)', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 40 }), fc.string({ unit: 'binary', maxLength: 20 }), fc.constantFrom(...PROTO_KEYS), fc.array(fc.constantFrom('Control', 'Shift', '+', 'a', 'Enter', '', 'constructor', '__proto__', 'F5', 'f13'), { maxLength: 6 }).map((p) => p.join('+'))), (spec) => {
        const k = parseKey(spec);
        if (k === undefined) return;
        expect(typeof k.key).toBe('string');
        expect(k.key.length).toBeGreaterThan(0);
        expect(KNOWN_KEY_VALUES.has(k.key) || /^f([1-9]|1[0-2])$/.test(k.key) || [...k.key].length === 1 || k.key.length === 1, `key ${JSON.stringify(k.key)} from ${JSON.stringify(spec)}`).toBe(true);
        expect(k.modifiers.every((m) => KNOWN_MODIFIERS.has(m)), `modifiers ${JSON.stringify(k.modifiers)}`).toBe(true);
        expect(new Set(k.modifiers).size).toBe(k.modifiers.length);
      }),
      params({ scale: 2 }),
    );
  });

  it('prototype-member names are not keys or modifiers (constructor, __proto__, toString, ...)', () => {
    for (const name of PROTO_KEYS) {
      expect(parseKey(name), name).toBeUndefined();
      expect(parseKey(`${name}+a`), `${name}+a`).toBeUndefined();
      expect(parseKey(`Control+${name}`), `Control+${name}`).toBeUndefined();
      expect(parseKey(name.toUpperCase()), name.toUpperCase()).toBeUndefined();
    }
  });

  it('accepts every well-formed spec with the modifiers and key it names, whatever the spelling and modifier order', () => {
    fc.assert(
      fc.property(modifierSet, keyArb, fc.integer(), ({ mods, spelled }, key, seed) => {
        const order = spelled.map((_, i) => i).sort((a, b) => ((a * 31 + seed) % 7) - ((b * 17 + seed) % 7) || a - b);
        const spec = [...order.map((i) => spelled[i] as string), key.spec].join('+');
        const k = parseKey(spec);
        expect(k, JSON.stringify(spec)).toBeDefined();
        expect(k?.key).toBe(key.key);
        expect([...(k?.modifiers ?? [])].sort()).toEqual([...mods].sort());
      }),
      params(),
    );
  });

  it('accepted specs round-trip through a formatter, and the formatted spec is a fixed point', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 20 }), modifierSet.chain((m) => keyArb.map((k) => [...m.spelled, k.spec].join('+'))), fc.array(fc.constantFrom('Control', 'Shift', 'Alt', '+', 'a', 'A', 'Enter', ' ', 'F5', '1', ''), { maxLength: 5 }).map((p) => p.join('+'))), (spec) => {
        const k = parseKey(spec);
        fc.pre(k !== undefined);
        const again = parseKey(format(k as CuaKey));
        expect(again, `${JSON.stringify(spec)} -> ${JSON.stringify(k)} -> ${format(k as CuaKey)}`).toEqual(k);
        expect(format(again as CuaKey)).toBe(format(k as CuaKey));
      }),
      params({ scale: 2 }),
    );
  });

  it('rejects an unknown modifier, a missing key, an unknown multi-character key and out-of-range function keys', () => {
    for (const bad of ['', 'Control+', '+Enter', 'Foo+a', 'Control+Foo', 'Ctrl+Ctrl+', 'F0', 'F13', 'f99', 'Control+F13', 'ab', 'Shift+ab', 'Escape+a', 'a+b', 'Control+Shift']) {
      expect(parseKey(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseKey('Control++')).toEqual({ key: '+', modifiers: ['ctrl'] });
    expect(parseKey('+')).toEqual({ key: '+', modifiers: [] });
    expect(parseKey('Control+Control+a')).toEqual({ key: 'a', modifiers: ['ctrl'] });
  });
});
