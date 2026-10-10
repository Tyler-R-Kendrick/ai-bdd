import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/index.ts';
import { createRedactor } from '../../src/evidence/index.ts';
import { FC_RUNS } from './helpers.ts';

const ALPHABET = [...'abcXYZ019 &=/+?#%"\\é中'];
const secretArb = fc.string({ minLength: 4, maxLength: 24, unit: fc.constantFrom(...ALPHABET) });
const noiseArb = fc.string({ maxLength: 30, unit: fc.constantFrom(...ALPHABET) });

/** Every form the redactor is required to scrub (SPEC 10.6) plus the JSON-escaped form of each. */
function forms(secret: string): string[] {
  const raw = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
  return [...raw, ...raw.map((f) => JSON.stringify(f).slice(1, -1))];
}

function leaks(output: string, secret: string): string[] {
  return forms(secret).filter((f) => output.includes(f));
}

describe('redactor (R-SE1)', () => {
  it('R-SE1 replaces the raw, URL-encoded and base64 forms with <secret:name>', () => {
    const r = createRedactor({ adminPassword: 'p@ss w0rd/1' });
    const v = 'p@ss w0rd/1';
    const text = `raw=${v} url=${encodeURIComponent(v)} b64=${Buffer.from(v).toString('base64')}`;
    expect(r.redact(text)).toBe('raw=<secret:adminPassword> url=<secret:adminPassword> b64=<secret:adminPassword>');
  });

  it('R-SE1 property: a secret embedded at random offsets never survives redact', () => {
    fc.assert(
      fc.property(secretArb, noiseArb, noiseArb, fc.constantFrom(0, 1, 2, 3, 4, 5), (secret, pre, post, which) => {
        const r = createRedactor({ pw: secret });
        const form = forms(secret)[which] as string;
        const out = r.redact(`${pre}${form}${post}`);
        expect(leaks(out, secret)).toEqual([]);
        expect(out).toContain('<secret:pw>');
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('R-SE1 property: repeated and adjacent occurrences in mixed encodings are all removed', () => {
    fc.assert(
      fc.property(secretArb, fc.array(fc.tuple(noiseArb, fc.constantFrom(0, 1, 2)), { minLength: 1, maxLength: 6 }), (secret, parts) => {
        const r = createRedactor({ pw: secret });
        const text = parts.map(([noise, w]) => noise + (forms(secret)[w] as string)).join('');
        expect(leaks(r.redact(text), secret)).toEqual([]);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('R-SE1 property: redactJson removes secrets from string values, nested arrays and keys', () => {
    fc.assert(
      fc.property(secretArb, noiseArb, noiseArb, fc.constantFrom(0, 1, 2), (secret, pre, post, which) => {
        const r = createRedactor({ pw: secret });
        const form = forms(secret)[which] as string;
        const s = `${pre}${form}${post}`;
        const input: JsonValue = { [s]: s, list: [s, { deep: [s, 1, true, null] }], n: 5, ok: false, nothing: null };
        const out = r.redactJson(input);
        expect(leaks(JSON.stringify(out), secret)).toEqual([]);
        expect(out).not.toBe(input);
        expect((out as { n: number }).n).toBe(5);
        expect((out as { nothing: null }).nothing).toBeNull();
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('R-SE1 redactJson does not mutate its input and keeps structure', () => {
    const r = createRedactor({ pw: 'hunter2!' });
    const input: JsonValue = { a: ['hunter2!', { b: 'x hunter2! y' }], c: 3 };
    const copy = structuredClone(input);
    expect(r.redactJson(input)).toEqual({ a: ['<secret:pw>', { b: 'x <secret:pw> y' }], c: 3 });
    expect(input).toEqual(copy);
  });

  it('R-SE1 longer values are replaced first and placeholders are never re-scanned', () => {
    const r = createRedactor({ short: 'abcd', long: 'abcd1234', inner: 'cret' });
    expect(r.redact('x abcd1234 y')).toBe('x <secret:long> y');
    expect(r.redact('abcd')).toBe('<secret:short>');
    // 'cret' occurs inside the placeholder "<secret:long>": single-pass replacement must leave it alone
    expect(r.redact('abcd1234 and cret')).toBe('<secret:long> and <secret:inner>');
  });

  it('R-SE1 exposes secret names (sorted) and never the values', () => {
    const r = createRedactor({ zeta: 'zzzz-zzzz', alpha: 'aaaa-aaaa' });
    expect(r.secretNames).toEqual(['alpha', 'zeta']);
    expect(JSON.stringify(r)).not.toContain('zzzz');
  });

  it('R-SE1 no secrets: identity', () => {
    const r = createRedactor({});
    expect(r.redact('anything <secret:x>')).toBe('anything <secret:x>');
    expect(r.secretNames).toEqual([]);
  });

  it('R-SE1 SECRET_TOO_SHORT: values shorter than 4 chars are rejected without echoing the value', () => {
    for (const v of ['', 'a', 'ab', 'abc']) {
      let caught: unknown;
      try {
        createRedactor({ tiny: v });
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({ code: 'SECRET_TOO_SHORT' });
      expect(JSON.stringify((caught as Error).message)).not.toContain(`"${v}"`);
      expect(JSON.stringify((caught as { details: unknown }).details)).toBe('{"name":"tiny"}');
    }
    expect(() => createRedactor({ ok: 'abcd' })).not.toThrow();
  });

  it('R-SE1 SECRET_TOO_SHORT: property over all short strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3 }), (v) => {
        expect(() => createRedactor({ s: v })).toThrowError(expect.objectContaining({ code: 'SECRET_TOO_SHORT' }));
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('R-SE1 regex metacharacters in secrets are matched literally', () => {
    const r = createRedactor({ re: '(a+)+$.*' });
    expect(r.redact('x (a+)+$.* y aaa')).toBe('x <secret:re> y aaa');
  });

  it('R-SE1 a __proto__ key in JSON does not pollute and is preserved as data', () => {
    const r = createRedactor({ pw: 'hunter2!' });
    const input = JSON.parse('{"__proto__": {"x": "hunter2!"}}') as JsonValue;
    const out = r.redactJson(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });
});
