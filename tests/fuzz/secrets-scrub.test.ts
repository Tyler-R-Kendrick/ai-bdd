import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRedactor } from '@ai-bdd/sdk';
import type { ActProgram, JsonValue, NodeKey, RecordedAction, Redactor, Selector, ValueSource } from '@ai-bdd/sdk/contracts';
import { hostileString, jsonEqual, params } from './helpers.ts';
import { jsonHasSecret, scrubActProgram as scrubRecording } from '../../packages/sdk/src/recording/secrets.ts';
import { scrubActProgram as scrubRunner } from '../../packages/sdk/src/runner/secrets.ts';

/**
 * Both modules scrub an act program before it is stored (recording/secrets.ts) or returned from a run (runner/secrets.ts); the runner
 * keeps its own copy because modules may not import siblings. The properties run against both and require them to agree.
 * Secrets use an alphabet that cannot occur in the `<secret:name>` placeholder (see redaction.test.ts for why that matters).
 */

const SAFE = [...'ABDFGHIJKLMNOPQSUVWXYZ0123456789 &=/+?#%"\\\'@$*-_.,;!()[]{}|~^é中ñ😀'];
const secretValue = fc.string({ minLength: 4, maxLength: 14, unit: fc.constantFrom(...SAFE) });
const SECRETS = fc.uniqueArray(fc.record({ name: fc.constantFrom('pw', 'token', 'apiKey', 'p.w-1', 'ünï'), value: secretValue }), { minLength: 1, maxLength: 3, selector: (s) => s.name });

type Secret = { name: string; value: string };

function spellings(secret: string): string[] {
  const uri = encodeURIComponent(secret);
  const b64 = Buffer.from(secret).toString('base64');
  return [secret, uri, uri.replace(/%20/g, '+'), b64, b64.replace(/=+$/, ''), JSON.stringify(secret).slice(1, -1)];
}

function wellFormed(secrets: readonly Secret[]): boolean {
  return secrets.every((s) => spellings(s.value).every((f) => ![...f].some((c) => '<>:secret'.includes(c)) && !`<secret:${s.name}>`.includes(f)));
}

const plain = fc.oneof(fc.stringMatching(/^[a-z ]{0,10}$/), hostileString({ maxLength: 20 }).map((s) => s.replace(/[<>:]/g, '')));

/** Text that sometimes embeds one of the secrets (in some spelling). */
function text(secrets: readonly Secret[]): fc.Arbitrary<string> {
  const embed = fc.tuple(plain, fc.constantFrom(...secrets), fc.nat(), plain).map(([a, s, w, b]) => `${a}${spellings(s.value)[w % 6]}${b}`);
  return fc.oneof({ weight: 3, arbitrary: plain }, { weight: 2, arbitrary: embed });
}

function programArb(secrets: readonly Secret[]): fc.Arbitrary<ActProgram> {
  const t = text(secrets);
  const selector: fc.Arbitrary<Selector> = fc.record(
    { role: fc.constantFrom('button', 'textbox', 'link'), name: t, ancestors: fc.array(fc.record({ role: fc.constantFrom('form', 'dialog'), name: t }), { maxLength: 2 }), index: fc.constant(0), of: fc.constant(1), testId: t },
    { requiredKeys: ['role', 'name', 'ancestors', 'index', 'of'] },
  ) as fc.Arbitrary<Selector>;
  const value: fc.Arbitrary<ValueSource> = fc.oneof(
    t.map((literal) => ({ literal })),
    fc.constantFrom(...secrets).map((s) => ({ literal: s.value })),
    fc.constantFrom(...secrets).map((s) => ({ secret: s.name })),
    fc.constant({ param: 'user' }),
  );
  const action: fc.Arbitrary<RecordedAction> = fc.oneof(
    t.map((url) => ({ verb: 'navigate' as const, url })),
    selector.map((target) => ({ verb: 'click' as const, target })),
    selector.map((target) => ({ verb: 'hover' as const, target })),
    fc.tuple(selector, value).map(([target, v]) => ({ verb: 'fill' as const, target, value: v })),
    fc.tuple(selector, value).map(([target, option]) => ({ verb: 'select' as const, target, option })),
    fc.tuple(selector, fc.boolean()).map(([target, checked]) => ({ verb: 'check' as const, target, checked })),
    t.map((key) => ({ verb: 'press' as const, key })),
    fc.tuple(t, selector).map(([key, target]) => ({ verb: 'press' as const, key, target })),
    fc.constantFrom<RecordedAction>({ verb: 'back' }, { verb: 'wait', ms: 10 }, { verb: 'scroll', direction: 'down' }),
  );
  const key: fc.Arbitrary<NodeKey> = fc.record({ role: fc.constantFrom('status', 'alert', 'cell'), name: t });
  const jsonLeaf: fc.Arbitrary<JsonValue> = fc.oneof(t, fc.boolean(), fc.integer(), fc.constant(null), fc.array(t, { maxLength: 2 }), t.map((x) => ({ k: x })));
  return fc.record({
    startRoute: t,
    startLandmarks: fc.constant('0'.repeat(64)),
    actions: fc.array(action, { maxLength: 5 }),
    effect: fc.record({
      routeBefore: t,
      routeAfter: t,
      appeared: fc.array(key, { maxLength: 3 }),
      disappeared: fc.array(key, { maxLength: 3 }),
      changed: fc.array(fc.record({ key, state: fc.oneof(fc.constantFrom('checked', 'value'), t), from: jsonLeaf, to: jsonLeaf }), { maxLength: 3 }),
    }),
  });
}

/** Every string (values and keys) anywhere in the program. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsOf(v, out);
    }
  }
  return out;
}

const secretsAndProgram = SECRETS.filter(wellFormed).chain((secrets) => fc.record({ secrets: fc.constant(secrets), act: programArb(secrets) }));

function redactorOf(secrets: readonly Secret[]): Redactor {
  return createRedactor(Object.fromEntries(secrets.map((s) => [s.name, s.value])));
}

const scrubbers = [
  ['recording', scrubRecording],
  ['runner', scrubRunner],
] as const;

describe.each(scrubbers)('fuzz: %s secret scrubber', (_label, scrub) => {
  it('leaves no spelling of any secret anywhere in the scrubbed program, effect and selectors included', () => {
    fc.assert(
      fc.property(secretsAndProgram, ({ secrets, act }) => {
        const redactor = redactorOf(secrets);
        const { act: clean } = scrub(act, { redactor, secretValue: (n) => secrets.find((s) => s.name === n)?.value });
        const serialized = JSON.stringify(clean);
        expect(jsonHasSecret(redactor, clean)).toBe(false);
        for (const s of secrets) for (const f of spellings(s.value)) expect(serialized.includes(f), `${JSON.stringify(f)} survived`).toBe(false);
        // the program keeps its shape: same number of actions, same verbs in the same order
        expect(clean.actions.map((a) => a.verb)).toEqual(act.actions.map((a) => a.verb));
        expect(clean.startLandmarks).toBe(act.startLandmarks);
      }),
      params(),
    );
  });

  it('is idempotent and reports no further changes on its own output', () => {
    fc.assert(
      fc.property(secretsAndProgram, ({ secrets, act }) => {
        const redactor = redactorOf(secrets);
        const ctx = { redactor, secretValue: (n: string) => secrets.find((s) => s.name === n)?.value };
        const first = scrub(act, ctx);
        const second = scrub(first.act, ctx);
        expect(jsonEqual(second.act, first.act)).toBe(true);
        expect(second.fuzzyReasons).toEqual([]);
      }),
      params(),
    );
  });

  it('does not touch a program that holds no secret, and never mutates its input', () => {
    fc.assert(
      fc.property(secretsAndProgram, ({ secrets, act }) => {
        const redactor = redactorOf(secrets);
        const before = JSON.stringify(act);
        scrub(act, { redactor });
        expect(JSON.stringify(act)).toBe(before);
        // String level, not serialized level: a string that spells a secret the way JSON would escape it is a secret here, but its
        // serialization is double-escaped and no longer matches.
        if (stringsOf(act).every((str) => redactor.redact(str) === str)) {
          const r = scrub(act, { redactor });
          expect(r.fuzzyReasons).toEqual([]);
          expect(jsonEqual(r.act, act)).toBe(true);
        }
      }),
      params(),
    );
  });

  it('a literal equal to a secret value is recorded as a {secret} reference; other embeddings turn the step fuzzy', () => {
    fc.assert(
      fc.property(SECRETS.filter(wellFormed), fc.nat(), (secrets, pick) => {
        const redactor = redactorOf(secrets);
        const s = secrets[pick % secrets.length] as Secret;
        const target: Selector = { role: 'textbox', name: 'Password', ancestors: [], index: 0, of: 1 };
        const effect = { routeBefore: '/a', routeAfter: '/b', appeared: [], disappeared: [], changed: [] };
        const exact: ActProgram = { startRoute: '/a', startLandmarks: '0'.repeat(64), actions: [{ verb: 'fill', target, value: { literal: s.value } }], effect };
        const r = scrub(exact, { redactor, secretValue: (n) => secrets.find((x) => x.name === n)?.value });
        expect((r.act.actions[0] as { value: ValueSource }).value).toEqual({ secret: s.name });
        expect(r.fuzzyReasons).toEqual([]);
        // without a way to look the value up, the literal is redacted and the step can no longer be replayed exactly
        const hidden = scrub(exact, { redactor });
        expect((hidden.act.actions[0] as { value: ValueSource }).value).toEqual({ literal: `<secret:${s.name}>` });
        expect(hidden.fuzzyReasons).toEqual(['secret-in-recording']);
        // a secret in a URL does the same
        const nav: ActProgram = { ...exact, actions: [{ verb: 'navigate', url: `http://localhost/?q=${encodeURIComponent(s.value)}` }] };
        const n = scrub(nav, { redactor });
        expect(n.fuzzyReasons).toContain('secret-in-recording');
        expect((n.act.actions[0] as { url: string }).url).not.toContain(encodeURIComponent(s.value));
      }),
      params(),
    );
  });

  it('effect entries that reflect a secret are dropped, and an emptied effect is reported', () => {
    fc.assert(
      fc.property(SECRETS.filter(wellFormed), fc.nat(), fc.constantFrom(0, 1, 2), (secrets, pick, where) => {
        const redactor = redactorOf(secrets);
        const s = secrets[pick % secrets.length] as Secret;
        const reflected: NodeKey = { role: 'status', name: `Welcome ${s.value}` };
        const effect = { routeBefore: '/a', routeAfter: '/a', appeared: where === 0 ? [reflected] : [], disappeared: where === 1 ? [reflected] : [], changed: where === 2 ? [{ key: { role: 'textbox', name: 'x' }, state: 'value', from: '', to: s.value }] : [] };
        const r = scrub({ startRoute: '/a', startLandmarks: '0'.repeat(64), actions: [], effect }, { redactor });
        expect(r.act.effect.appeared).toEqual([]);
        expect(r.act.effect.disappeared).toEqual([]);
        expect(r.act.effect.changed).toEqual([]);
        expect(r.fuzzyReasons).toEqual(['no-observable-effect']);
      }),
      params(),
    );
  });
});

describe('fuzz: the recording and runner scrubbers are the same function', () => {
  it('agree on every program', () => {
    fc.assert(
      fc.property(secretsAndProgram, ({ secrets, act }) => {
        const ctx = { redactor: redactorOf(secrets), secretValue: (n: string) => secrets.find((s) => s.name === n)?.value };
        expect(scrubRunner(act, ctx)).toEqual(scrubRecording(act, ctx));
      }),
      params(),
    );
  });
});
