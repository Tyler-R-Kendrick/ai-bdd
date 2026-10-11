import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, stableJson } from '@ai-bdd/sdk';
import type { JsonValue } from '@ai-bdd/sdk/contracts';
import { assertPrototypeClean, jsonEqual, jsonValue, params } from './helpers.ts';

/** Rebuilds every object with its keys in a different order (own `__proto__` keys stay own keys). */
function reorder(value: JsonValue, rotate: number, reverse: boolean): JsonValue {
  if (Array.isArray(value)) return value.map((v) => reorder(v, rotate, reverse));
  if (value !== null && typeof value === 'object') {
    let keys = Object.keys(value);
    if (reverse) keys = keys.reverse();
    if (keys.length > 0) {
      const r = rotate % keys.length;
      keys = [...keys.slice(r), ...keys.slice(0, r)];
    }
    return Object.fromEntries(keys.map((k) => [k, reorder((value as Record<string, JsonValue>)[k] as JsonValue, rotate, reverse)]));
  }
  return value;
}

/** Independent reference for RFC 8785 on the value space generated here: JSON.stringify of recursively key-sorted data. */
function reference(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(reference).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${reference((value as Record<string, JsonValue>)[k] as JsonValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const json = jsonValue({ maxDepth: 5, maxKeys: 6 });

describe('fuzz: canonicalJson', () => {
  it('is deterministic and independent of key insertion order', () => {
    fc.assert(
      fc.property(json, fc.nat(10), fc.boolean(), (v, rotate, reverse) => {
        const text = canonicalJson(v);
        expect(canonicalJson(v)).toBe(text);
        expect(canonicalJson(reorder(v, rotate, reverse))).toBe(text);
      }),
      params(),
    );
  });

  it('matches a reference RFC 8785 serialization and parses back to a deep-equal value (own __proto__ keys included)', () => {
    fc.assert(
      fc.property(json, (v) => {
        const text = canonicalJson(v);
        expect(text).toBe(reference(v));
        const back = JSON.parse(text) as JsonValue;
        expect(jsonEqual(back, v)).toBe(true);
        expect(canonicalJson(back)).toBe(text);
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('emits no insignificant whitespace between tokens', () => {
    fc.assert(
      fc.property(json, (v) => {
        const text = canonicalJson(v);
        // Strip string literals, then nothing but structural characters and scalars may remain.
        const structural = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        expect(structural).not.toMatch(/\s/);
      }),
      params(),
    );
  });

  it('omits undefined-valued keys and rejects non-finite numbers', () => {
    fc.assert(
      fc.property(json, fc.stringMatching(/^[a-z]{1,5}$/), (v, key) => {
        const obj = { [key]: v, gone: undefined } as unknown as JsonValue;
        expect(canonicalJson(obj)).toBe(canonicalJson({ [key]: v }));
      }),
      params(),
    );
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
      expect(() => canonicalJson({ a: [bad] })).toThrow(TypeError);
    }
    expect(canonicalJson(-0)).toBe('0');
  });
});

describe('fuzz: stableJson', () => {
  it('is deterministic, key-order independent, ends with exactly one newline, and uses LF only', () => {
    fc.assert(
      fc.property(json, fc.nat(10), fc.boolean(), (v, rotate, reverse) => {
        const text = stableJson(v);
        expect(stableJson(reorder(v, rotate, reverse))).toBe(text);
        expect(text).toMatch(/[^\n]\n$/);
        expect(text).not.toContain('\r');
      }),
      params(),
    );
  });

  it('parse(stableJson(x)) deep-equals x, and re-serializing the parse is a fixed point', () => {
    fc.assert(
      fc.property(json, (v) => {
        const text = stableJson(v);
        const back = JSON.parse(text) as JsonValue;
        expect(jsonEqual(back, v)).toBe(true);
        expect(stableJson(back)).toBe(text);
        // both serializers describe the same data
        expect(canonicalJson(back)).toBe(canonicalJson(v));
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('keeps an own "__proto__" key as data without touching the prototype chain, at any depth', () => {
    fc.assert(
      fc.property(json, (inner) => {
        const evil = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}') as JsonValue;
        const wrapped = { deep: [{ evil, inner }] } as unknown as JsonValue;
        const text = stableJson(wrapped);
        const back = JSON.parse(text) as { deep: { evil: object }[] };
        expect(Object.getPrototypeOf(back.deep[0]?.evil)).toBe(Object.prototype);
        expect(Object.hasOwn(back.deep[0]?.evil as object, '__proto__')).toBe(true);
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
        assertPrototypeClean();
      }),
      params({ scale: 0.3 }),
    );
  });
});
