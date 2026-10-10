import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '@ai-bdd/sdk';
import type { JsonValue } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { assertPrototypeClean, cpuMs, hostileString, jsonEqual, jsonValue, params } from './helpers.ts';

/**
 * Contract (R-SE1, evidence/redactor.ts): every secret value of at least 4 characters, in its raw, URL-encoded (upper and lower case
 * hex, and `+` for spaces), base64 (padded, unpadded, url-safe) and JSON-escaped spellings, is replaced by `<secret:name>` in a single
 * pass. The output is therefore free of those spellings *unless the placeholder itself, or the join between the placeholder and its
 * neighbours, spells one*. The properties below draw secrets from an alphabet that cannot occur in a placeholder (no `<`, `>`, `:`, and no
 * letters of `secret`), which is the domain on which "never contains the secret" and "idempotent" are well defined.
 */

const PLACEHOLDER_CHARS = new Set([...'<>:secret']);
const SAFE_ALPHABET = [...'ABDFGHIJKLMNOPQSUVWXYZ0123456789 &=/+?#%"\\\'@$*-_.,;!()[]{}|~^é中ñ😀 \t‮​́'];
const secretValue = fc.string({ minLength: 4, maxLength: 24, unit: fc.constantFrom(...SAFE_ALPHABET) });
const noise = fc.oneof(
  fc.string({ maxLength: 30, unit: fc.constantFrom(...SAFE_ALPHABET, 'a', 'b', 'x', ' ', '\n') }),
  hostileString({ maxLength: 40 }),
);
const name = fc.oneof(fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]{0,10}$/), fc.constantFrom('pw', 'adminPassword', 'a$&b', '$1', '<x>', "it's", 'ünï', '😀', 'constructor', '__proto__'));

/** All spellings the redactor must catch, computed independently of the implementation. */
function forms(secret: string): string[] {
  const uri = encodeURIComponent(secret);
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  return [
    ...new Set([
      secret,
      uri,
      uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
      uri.replace(/%20/g, '+'),
      b64,
      b64.replace(/=+$/, ''),
      Buffer.from(secret, 'utf8').toString('base64url'),
      JSON.stringify(secret).slice(1, -1),
    ]),
  ].filter((f) => f.length > 0);
}

/** Skip secrets whose spellings can appear inside `<secret:NAME>` or that contain placeholder characters. */
function wellFormed(secret: string, secretName: string): boolean {
  const placeholder = `<secret:${secretName}>`;
  return forms(secret).every((f) => !placeholder.includes(f) && ![...f].some((c) => PLACEHOLDER_CHARS.has(c)));
}

const secretCase = fc.record({ secret: secretValue, secretName: name, pre: noise, post: noise, which: fc.nat(), copies: fc.integer({ min: 1, max: 3 }) }).filter((c) => wellFormed(c.secret, c.secretName));

describe('fuzz: redactor', () => {
  it('removes every spelling of a secret embedded anywhere in hostile text', () => {
    fc.assert(
      fc.property(secretCase, ({ secret, secretName, pre, post, which, copies }) => {
        const r = createRedactor({ [secretName]: secret });
        const spellings = forms(secret);
        const text = Array.from({ length: copies }, (_, i) => `${pre}${spellings[(which + i) % spellings.length]}${post}`).join('|');
        const out = r.redact(text);
        for (const f of spellings) expect(out.includes(f), `form ${JSON.stringify(f)} survived in ${JSON.stringify(out)}`).toBe(false);
        expect(out).toContain(`<secret:${secretName}>`);
        expect(r.secretNames).toEqual([secretName]);
      }),
      params(),
    );
  });

  it('is idempotent: redacting redacted text changes nothing', () => {
    fc.assert(
      fc.property(secretCase, ({ secret, secretName, pre, post, which }) => {
        const r = createRedactor({ [secretName]: secret });
        const spellings = forms(secret);
        const once = r.redact(`${pre}${spellings[which % spellings.length]}${post}`);
        expect(r.redact(once)).toBe(once);
      }),
      params(),
    );
  });

  it('leaves text without any spelling of the secret exactly as it was, and changes text that has one', () => {
    fc.assert(
      fc.property(secretCase, hostileString(), ({ secret, secretName, pre }, hostile) => {
        const r = createRedactor({ [secretName]: secret });
        const spellings = forms(secret);
        for (const text of [pre, `${pre}${pre}`, hostile]) {
          const has = spellings.some((f) => text.includes(f));
          if (has) expect(r.redact(text)).not.toBe(text);
          else expect(r.redact(text)).toBe(text);
        }
        expect(r.redact('')).toBe('');
      }),
      params(),
    );
  });

  it('with several secrets, no complete spelling of any of them survives (overlapping secrets included)', () => {
    const several = fc.uniqueArray(fc.record({ secret: secretValue, secretName: name }), { minLength: 2, maxLength: 4, selector: (x) => x.secretName }).filter((l) => l.every((s) => wellFormed(s.secret, s.secretName)));
    fc.assert(
      fc.property(several, noise, fc.integer(), (list, joiner, seed) => {
        const r = createRedactor(Object.fromEntries(list.map((s) => [s.secretName, s.secret])));
        const pieces = list.flatMap((s) => forms(s.secret));
        // a deterministic shuffle and a few concatenations so that secrets abut and overlap
        const mixed = pieces.map((p, i) => (i % 2 === 0 ? p : `${joiner}${p}`)).sort((a, b) => ((a.length * 31 + seed) % 7) - ((b.length * 17 + seed) % 7));
        const text = `${mixed.join('')}${joiner}${mixed.join(joiner)}`;
        const out = r.redact(text);
        for (const s of list) for (const f of forms(s.secret)) expect(out.includes(f), `form ${JSON.stringify(f)} of ${s.secretName} survived`).toBe(false);
        expect(r.secretNames).toEqual(list.map((s) => s.secretName).sort());
      }),
      params(),
    );
  });

  it('redactJson removes spellings from strings, nested arrays and object keys, keeps the shape, and does not mutate its input', () => {
    const withSecret = fc.record({ c: secretCase, json: jsonValue({ maxDepth: 3, maxKeys: 3 }), key: noise });
    fc.assert(
      fc.property(withSecret, ({ c, json, key }) => {
        const r = createRedactor({ [c.secretName]: c.secret });
        const form = forms(c.secret)[c.which % forms(c.secret).length] as string;
        const s = `${c.pre}${form}${c.post}`;
        const input = { [`${key}${form}`]: s, list: [s, { deep: [s, 1, true, null, json] }], n: 5, nothing: null } as unknown as JsonValue;
        const snapshot = JSON.stringify(input);
        const out = r.redactJson(input);
        expect(JSON.stringify(input)).toBe(snapshot);
        const text = JSON.stringify(out);
        for (const f of forms(c.secret)) expect(text.includes(f)).toBe(false);
        for (const f of forms(c.secret).map((x) => JSON.stringify(x).slice(1, -1))) expect(text.includes(f)).toBe(false);
        const o = out as unknown as { list: [string, { deep: JsonValue[] }]; n: number; nothing: null };
        expect(o.list[0]).toBe(r.redact(s));
        expect(o.n).toBe(5);
        expect(o.nothing).toBeNull();
        expect(o.list[1].deep.slice(1, 4)).toEqual([1, true, null]);
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('redactJson of secret-free JSON (hostile keys included) is a deep-equal copy', () => {
    fc.assert(
      fc.property(jsonValue({ maxDepth: 4, maxKeys: 5 }), (json) => {
        const r = createRedactor({ pw: 'ZZZZ-never-in-generated-data-ZZZZ' });
        const out = r.redactJson(json as JsonValue);
        expect(jsonEqual(out, json)).toBe(true);
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('rejects secrets shorter than 4 characters (and non-strings) with SECRET_TOO_SHORT, never echoing the value', () => {
    // values use characters that do not occur in the error text, so "does not contain the value" is meaningful
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 3, unit: fc.constantFrom('7', '8', '9', 'Ü', '中', '😀', 'Q', '\u0000') }), (short) => {
        fc.pre(short.length < 4);
        try {
          createRedactor({ pw: short });
          expect.unreachable();
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'SECRET_TOO_SHORT', String(e)).toBe(true);
          if (short.length > 0) expect(JSON.stringify((e as AiBddError).toPayload())).not.toContain(JSON.stringify(short).slice(1, -1));
        }
      }),
      params(),
    );
    for (const bad of [undefined, null, 12345678, {}, []]) expect(() => createRedactor({ pw: bad as unknown as string })).toThrow(AiBddError);
  });

  it('accepts any string of 4 or more characters, including lone surrogates, NUL and astral text, and still scrubs the raw value', () => {
    fc.assert(
      fc.property(hostileString({ maxLength: 40 }).filter((s) => s.length >= 4), name, (secret, secretName) => {
        const r = createRedactor({ [secretName]: secret });
        const out = r.redact(`before ${secret} after`);
        // The raw spelling is always replaced (unless the placeholder itself contains it, which hostile data can arrange only for tiny values).
        if (!`<secret:${secretName}>`.includes(secret)) expect(out.includes(secret)).toBe(false);
      }),
      params(),
    );
  });

  it('stays linear enough: many long secrets sharing a prefix against a long text finish within a CPU budget', () => {
    const secrets = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, `${'a'.repeat(150)}${i}b`]));
    const r = createRedactor(secrets);
    const text = 'a'.repeat(60_000);
    const used = cpuMs(() => {
      r.redact(text);
    });
    expect(used).toBeLessThan(5000);
  });
});
