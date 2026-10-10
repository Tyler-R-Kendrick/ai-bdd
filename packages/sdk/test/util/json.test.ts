import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/index.ts';
import { canonicalJson, sha256Hex, stableJson } from '../../src/util/index.ts';

describe('sha256Hex', () => {
  it('is the lowercase hex SHA-256 of the UTF-8 bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('héllo ✓')).toBe(createHash('sha256').update(Buffer.from('héllo ✓', 'utf8')).digest('hex'));
  });

  it('hashes bytes exactly as the string they encode', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new Uint8Array([0, 255, 1]))).toBe(createHash('sha256').update(Buffer.from([0, 255, 1])).digest('hex'));
  });
});

describe('canonicalJson', () => {
  it('renders scalars like JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1.5)).toBe('-1.5');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson('a"b\\c\n ')).toBe('"a\\"b\\\\c\\n "');
  });

  it('sorts object keys by UTF-16 code unit at every depth and emits no whitespace', () => {
    const v = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: null }, B: 'x', '': 0, 10: 'ten', 9: 'nine', 'é': 1, '😀': 2, '～': 3 };
    expect(canonicalJson(v)).toBe('{"":0,"10":"ten","9":"nine","B":"x","a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1,"é":1,"😀":2,"～":3}');
  });

  it('keeps array order and renders empty containers', () => {
    expect(canonicalJson([3, 1, [2], {}])).toBe('[3,1,[2],{}]');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('omits keys whose value is undefined, but keeps null', () => {
    const v = { a: undefined, b: null, c: { d: undefined } } as unknown as JsonValue;
    expect(canonicalJson(v)).toBe('{"b":null,"c":{}}');
  });

  it('refuses a non-finite number with a TypeError naming the function, also when nested', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, [1, { x: [Number.NaN] }] as JsonValue]) {
      let thrown: unknown;
      try {
        canonicalJson(bad as JsonValue);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as TypeError).message).toBe('canonicalJson: non-finite number');
    }
  });
});

describe('stableJson', () => {
  it('sorts keys deeply, indents with two spaces and ends with exactly one newline', () => {
    expect(stableJson({ b: [1, { z: 1, a: 2 }], a: { y: true, x: null } })).toBe(
      ['{', '  "a": {', '    "x": null,', '    "y": true', '  },', '  "b": [', '    1,', '    {', '      "a": 2,', '      "z": 1', '    }', '  ]', '}', ''].join('\n'),
    );
  });

  it('renders empty containers and scalars with the trailing newline', () => {
    expect(stableJson({})).toBe('{}\n');
    expect(stableJson([])).toBe('[]\n');
    expect(stableJson('s')).toBe('"s"\n');
    expect(stableJson(null)).toBe('null\n');
    expect(stableJson(7)).toBe('7\n');
  });

  it('drops undefined values (also in nested objects) but keeps null', () => {
    const v = { a: undefined, b: { c: undefined, d: 1 }, e: null, f: [{ g: undefined }] } as unknown as JsonValue;
    expect(stableJson(v)).toBe('{\n  "b": {\n    "d": 1\n  },\n  "e": null,\n  "f": [\n    {}\n  ]\n}\n');
  });

  it('keeps an own __proto__ key instead of swallowing it', () => {
    const v = JSON.parse('{"b":1,"__proto__":{"x":1},"a":2}') as JsonValue;
    expect(stableJson(v)).toBe('{\n  "__proto__": {\n    "x": 1\n  },\n  "a": 2,\n  "b": 1\n}\n');
  });

  it('does not mutate its input', () => {
    const v = { b: 1, a: [{ d: 1, c: 2 }] };
    stableJson(v);
    expect(Object.keys(v)).toEqual(['b', 'a']);
    expect(Object.keys(v.a[0] ?? {})).toEqual(['d', 'c']);
  });
});
