import { describe, expect, it } from 'vitest';
import { parseFrontmatter, toJsonValue } from '../../src/markdown/frontmatter.ts';

describe('toJsonValue', () => {
  it('maps null and undefined to null and passes strings and booleans through', () => {
    expect(toJsonValue(null)).toBeNull();
    expect(toJsonValue(undefined)).toBeNull();
    expect(toJsonValue('s')).toBe('s');
    expect(toJsonValue(false)).toBe(false);
  });

  it('keeps finite numbers and turns NaN and infinities into their string names', () => {
    expect(toJsonValue(1.5)).toBe(1.5);
    expect(toJsonValue(Number.NaN)).toBe('NaN');
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(toJsonValue(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  it('renders bigint as its decimal string (JSON has no bigint)', () => {
    expect(toJsonValue(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('renders a valid Date as an ISO string and an invalid Date as null', () => {
    expect(toJsonValue(new Date('2001-02-03T04:05:06.000Z'))).toBe('2001-02-03T04:05:06.000Z');
    expect(toJsonValue(new Date('not a date'))).toBeNull();
  });

  it('converts a Map to a plain object, stringifying keys and dropping __proto__', () => {
    const m = new Map<unknown, unknown>([
      ['a', 1],
      [2, new Map([['inner', true]])],
      ['__proto__', { polluted: true }],
    ]);
    const out = toJsonValue(m);
    expect(out).toEqual({ a: 1, '2': { inner: true } });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops an own __proto__ key from plain objects and recurses into arrays and objects', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"keep":[1,{"__proto__":1,"x":"y"}]}') as unknown;
    const out = toJsonValue(hostile);
    expect(out).toEqual({ keep: [1, { x: 'y' }] });
    expect(Object.keys(out as object)).toEqual(['keep']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('maps values that are not data (functions, symbols) to null', () => {
    expect(toJsonValue(() => 1)).toBeNull();
    expect(toJsonValue(Symbol('s'))).toBeNull();
  });

  it('truncates structures nested 64 levels deep to null instead of overflowing the stack', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 70; i++) deep = [deep];
    let cur = toJsonValue(deep);
    let levels = 0;
    while (Array.isArray(cur)) {
      cur = cur[0] as ReturnType<typeof toJsonValue>;
      levels++;
    }
    expect(levels).toBe(64);
    expect(cur).toBeNull();
  });

  it('keeps structures nested exactly 63 levels deep intact', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 63; i++) deep = [deep];
    let cur = toJsonValue(deep);
    while (Array.isArray(cur)) cur = cur[0] as ReturnType<typeof toJsonValue>;
    expect(cur).toBe('leaf');
  });
});

describe('parseFrontmatter', () => {
  it('parses a mapping to plain JSON data', () => {
    expect(parseFrontmatter('title: Hello\ntags: [a, b]\nn: 3\n')).toEqual({ ok: true, value: { title: 'Hello', tags: ['a', 'b'], n: 3 } });
  });

  it('parses an empty document to null', () => {
    expect(parseFrontmatter('')).toEqual({ ok: true, value: null });
  });

  it('YAML specials that JSON cannot carry become strings', () => {
    expect(parseFrontmatter('[.nan, -.inf, .inf]')).toEqual({ ok: true, value: ['NaN', '-Infinity', 'Infinity'] });
  });

  it('a quoted __proto__ key is dropped and cannot pollute the result', () => {
    const r = parseFrontmatter('"__proto__": {polluted: true}\nb: 2');
    expect(r).toEqual({ ok: true, value: { b: 2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('an explicit !!timestamp becomes an ISO string', () => {
    expect(parseFrontmatter('!!timestamp 2001-01-01')).toEqual({ ok: true, value: '2001-01-01T00:00:00.000Z' });
  });

  it('a !!set carries no data and becomes an empty object', () => {
    expect(parseFrontmatter('!!set {a, b}')).toEqual({ ok: true, value: {} });
  });

  it('duplicate keys are an error (strict mode) naming the position, never a throw', () => {
    expect(parseFrontmatter('a: 1\na: 2')).toEqual({ ok: false, error: 'Map keys must be unique at line 2, column 1' });
  });

  it('an error message is reduced to its first line without the trailing colon', () => {
    expect(parseFrontmatter('\ta: 1')).toEqual({ ok: false, error: 'Tabs are not allowed as indentation at line 1, column 1' });
  });

  it('an unresolved alias is reported as an error, not resolved', () => {
    expect(parseFrontmatter('a: *x')).toEqual({ ok: false, error: 'Unresolved alias (the anchor must be set before the alias): x' });
  });

  it('a very long error message is capped at 300 characters', () => {
    const r = parseFrontmatter(`a: *${'k'.repeat(400)}`);
    expect(r.ok).toBe(false);
    const error = (r as { ok: false; error: string }).error;
    expect(error).toHaveLength(300);
    expect(error.startsWith('Unresolved alias')).toBe(true);
  });
});
