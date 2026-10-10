import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serialize, stableStringify } from '@ai-bdd/verify';
import { assertPrototypeClean, hostileKey, hostileString, jsonEqual, jsonValue, params } from './helpers.ts';

// ───────────────────────── arbitrary JavaScript values (not just JSON)

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

type Container = unknown[] | Record<string, unknown> | Map<unknown, unknown> | Set<unknown>;

const leaf: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -100, max: 100 }),
  fc.double(),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, Number.MAX_SAFE_INTEGER, 1e21, 5e-324),
  fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }),
  hostileString({ maxLength: 40 }),
  fc.constant(Symbol('s')),
  fc.constant(() => 1),
  fc.date({ noInvalidDate: false }),
  fc.uint8Array({ maxLength: 40 }),
  fc.string({ maxLength: 10 }).map((m) => new Error(m)),
  fc.constant(new Point(1, 2)),
);

/** Trees of containers over `leaf`; `cycles` links some containers back to one of their ancestors or to themselves. */
function jsValue(opts: { cycles: boolean }): fc.Arbitrary<unknown> {
  const tree = fc.letrec<{ v: unknown; arr: unknown[]; obj: Record<string, unknown>; map: Map<unknown, unknown>; set: Set<unknown> }>((tie) => ({
    v: fc.oneof({ maxDepth: 3, depthSize: 'small' }, leaf, leaf, tie('arr'), tie('obj'), tie('map'), tie('set')),
    arr: fc.array(tie('v'), { maxLength: 4 }),
    obj: fc.array(fc.tuple(hostileKey, tie('v')), { maxLength: 4 }).map((e) => Object.fromEntries(e)),
    map: fc.array(fc.tuple(fc.oneof(hostileKey, fc.integer({ min: 0, max: 3 })), tie('v')), { maxLength: 3 }).map((e) => new Map(e)),
    set: fc.array(tie('v'), { maxLength: 3 }).map((e) => new Set(e)),
  })).v;
  if (!opts.cycles) return tree;
  return fc.tuple(tree, fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 3 })).map(([root, links]) => {
    const containers: Container[] = [];
    const seen = new Set<unknown>();
    const visit = (v: unknown): void => {
      if (v === null || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v) || v instanceof Map || v instanceof Set || Object.getPrototypeOf(v) === Object.prototype) containers.push(v as Container);
      if (Array.isArray(v)) v.forEach(visit);
      else if (v instanceof Map) [...v.values()].forEach(visit);
      else if (v instanceof Set) [...v].forEach(visit);
      else Object.values(v).forEach(visit);
    };
    visit(root);
    for (const [a, b] of links) {
      const from = containers[a % Math.max(1, containers.length)];
      const to = containers[b % Math.max(1, containers.length)];
      if (from === undefined || to === undefined) continue;
      if (Array.isArray(from)) from.push(to);
      else if (from instanceof Map) from.set('cycle', to);
      else if (from instanceof Set) from.add(to);
      else (from as Record<string, unknown>)['cycle'] = to;
    }
    return root;
  });
}

describe('fuzz: stableStringify / serialize', () => {
  it('never throws on arbitrary JavaScript values, cycles included, and always yields parseable JSON', () => {
    fc.assert(
      fc.property(jsValue({ cycles: true }), (value) => {
        const text = stableStringify(value);
        expect(typeof text).toBe('string');
        expect(() => JSON.parse(text)).not.toThrow();
        const s = serialize(value);
        expect(['txt', 'bin', 'json']).toContain(s.extension);
        assertPrototypeClean();
      }),
      params({ scale: 2 }),
    );
  });

  it('is deterministic and independent of property insertion order (maps and objects)', () => {
    const reorder = (v: unknown, rot: number): unknown => {
      if (Array.isArray(v)) return v.map((x) => reorder(x, rot));
      if (v instanceof Map) {
        const e = [...v.entries()].map(([k, x]) => [k, reorder(x, rot)] as const);
        return new Map(e.slice(rot % Math.max(1, e.length)).concat(e.slice(0, rot % Math.max(1, e.length))));
      }
      if (v instanceof Set) return new Set([...v].map((x) => reorder(x, rot)));
      if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        const e = Object.entries(v).map(([k, x]) => [k, reorder(x, rot)] as const);
        return Object.fromEntries(e.slice(rot % Math.max(1, e.length)).concat(e.slice(0, rot % Math.max(1, e.length))));
      }
      return v;
    };
    fc.assert(
      fc.property(jsValue({ cycles: false }), fc.nat(5), (value, rot) => {
        expect(stableStringify(value)).toBe(stableStringify(value));
        expect(stableStringify(reorder(value, rot))).toBe(stableStringify(value));
      }),
      params(),
    );
  });

  it('JSON data round-trips: parse(stableStringify(x)) is x, an own "__proto__" key stays a key, and re-serializing is a fixed point', () => {
    fc.assert(
      fc.property(jsonValue({ maxDepth: 4, maxKeys: 5 }), (value) => {
        const text = stableStringify(value);
        const back = JSON.parse(text) as unknown;
        expect(jsonEqual(back, value)).toBe(true);
        expect(stableStringify(back)).toBe(text);
        assertPrototypeClean();
      }),
      params(),
    );
    const evil = JSON.parse('{"__proto__":{"admin":true},"nested":{"__proto__":[1],"constructor":{"prototype":{"x":1}}}}') as unknown;
    const text = stableStringify(evil);
    expect(text).toContain('"__proto__"');
    expect(JSON.parse(text)).toEqual(evil);
  });

  it('is a fixed point on its own output for any value (what was serialized serializes to itself)', () => {
    // An Error is rendered as { name, message } in that fixed order for readability; re-reading it as a plain object sorts the keys,
    // so values holding an Error are not a fixed point by design (and are covered by the unit test of the Error format).
    fc.assert(
      fc.property(jsValue({ cycles: true }).filter((v) => !containsError(v, new Set())), (value) => {
        const once = stableStringify(value);
        expect(stableStringify(JSON.parse(once))).toBe(once);
      }),
      params(),
    );
  });

  it('marks only true cycles as [circular]: a value shared twice in a DAG is written out in full both times', () => {
    fc.assert(
      fc.property(jsValue({ cycles: false }), (shared) => {
        const twice = stableStringify({ a: shared, b: shared });
        const copies = stableStringify({ a: structuredCloneSafe(shared), b: structuredCloneSafe(shared) });
        expect(twice).toBe(copies);
        const loop: Record<string, unknown> = { v: 1 };
        loop['self'] = loop;
        expect(JSON.parse(stableStringify({ shared, loop }))).toMatchObject({ loop: { self: '[circular]', v: 1 } });
      }),
      params(),
    );
  });

  it('keeps distinct values distinct: different Map contents, Set order aside, never serialize alike', () => {
    // Map keys that stringify alike must not collapse into one entry, or two different values would share a snapshot.
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.oneof(fc.integer({ min: 0, max: 3 }).map(String), fc.integer({ min: 0, max: 3 }), fc.constantFrom<unknown>({ a: 1 }, { a: 2 }, [1], [2], true, 'true', null, 'null')), fc.integer({ min: 0, max: 9 })), { minLength: 1, maxLength: 5 }), (entries) => {
        const map = new Map<unknown, number>();
        for (const [k, v] of entries) map.set(k, v);
        const text = stableStringify(map);
        // every value stored in the map appears in the output, so no entry was overwritten
        const present = (JSON.stringify(JSON.parse(text)).match(/\d+/g) ?? []).length;
        expect(present, `${[...map.entries()].map(([k, v]) => `${JSON.stringify(k)}=${v}`).join(', ')} -> ${text}`).toBeGreaterThanOrEqual(map.size);
      }),
      params(),
    );
  });

  it('a Map with string keys reads like the equivalent plain object, whatever the keys sort like', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(hostileKey, jsonValue({ maxDepth: 2, maxKeys: 3 })), { selector: ([k]) => k, maxLength: 6 }), (entries) => {
        expect(stableStringify(new Map(entries))).toBe(stableStringify(Object.fromEntries(entries)));
      }),
      params(),
    );
    // keys that differ only by case or accents sort by code unit, never by the machine's locale
    expect(Object.keys(JSON.parse(stableStringify(new Map([['b', 1], ['B', 2], ['a', 3], ['\u00e4', 4]]))) as object)).toEqual(['B', 'a', 'b', '\u00e4']);
  });

  it('serialize: strings stay strings, bytes stay bytes, anything else becomes JSON', () => {
    fc.assert(
      fc.property(hostileString(), fc.uint8Array({ maxLength: 20 }), jsValue({ cycles: false }), (str, bytes, other) => {
        expect(serialize(str)).toEqual({ bytes: undefined, text: str, extension: 'txt' });
        expect(serialize(bytes).bytes).toBe(bytes);
        expect(serialize(bytes).extension).toBe('bin');
        const o = serialize(other);
        if (typeof other !== 'string' && !(other instanceof Uint8Array)) {
          expect(o.extension).toBe('json');
          expect(o.text).toBe(stableStringify(other));
        }
      }),
      params(),
    );
  });
});

function containsError(v: unknown, seen: Set<unknown>): boolean {
  if (v instanceof Error) return true;
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v) || v instanceof Set) return [...v].some((x) => containsError(x, seen));
  if (v instanceof Map) return [...v.entries()].some(([k, x]) => containsError(k, seen) || containsError(x, seen));
  return Object.values(v).some((x) => containsError(x, seen));
}

/** structuredClone cannot clone functions or symbols; copy the shapes the generator makes by hand. */
function structuredCloneSafe(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(structuredCloneSafe);
  if (v instanceof Map) return new Map([...v.entries()].map(([k, x]) => [k, structuredCloneSafe(x)]));
  if (v instanceof Set) return new Set([...v].map(structuredCloneSafe));
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof Error) return Object.assign(new Error(v.message), { name: v.name });
  if (v instanceof Point) return new Point(v.x, v.y);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneSafe(x)]));
  return v;
}
