import { describe, expect, it } from 'vitest';
import type { ActProgram, EffectSignature, RecordedAction, Redactor, Selector } from '../../src/contracts/index.ts';
import { createRedactor } from '../../src/evidence/redactor.ts';
import * as recordingSecrets from '../../src/recording/secrets.ts';
import * as runnerSecrets from '../../src/runner/secrets.ts';

/**
 * recording/secrets.ts and runner/secrets.ts are two copies of the same code (modules may not import each other), so every
 * behavior is checked against both, and a differential test pins them to each other.
 */
const KEY = 'sk-live-ABC123xyz';
const PASS = 'pa ss/wörd"1\\';
const redactor: Redactor = createRedactor({ API_KEY: KEY, PASS });

const variantsOfPass = [
  ['raw', PASS],
  ['url-encoded', encodeURIComponent(PASS)],
  ['url-encoded with lowercase hex', encodeURIComponent(PASS).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
  ['url-encoded with + for space', encodeURIComponent(PASS).replace(/%20/g, '+')],
  ['base64', Buffer.from(PASS).toString('base64')],
  ['base64 without padding', Buffer.from(PASS).toString('base64').replace(/=+$/, '')],
  ['base64url', Buffer.from(PASS).toString('base64url')],
  ['JSON-escaped', JSON.stringify(PASS).slice(1, -1)],
] as const;

const sel = (over: Partial<Selector> = {}): Selector => ({ role: 'button', name: 'Save', ancestors: [], index: 0, of: 1, ...over });
const effect = (over: Partial<EffectSignature> = {}): EffectSignature => ({ routeBefore: '/a', routeAfter: '/a', appeared: [], disappeared: [], changed: [], ...over });
const program = (actions: RecordedAction[], over: Partial<ActProgram> = {}): ActProgram => ({
  startRoute: '/start',
  startLandmarks: 'a'.repeat(64),
  actions,
  effect: effect({ appeared: [{ role: 'status', name: 'Saved' }] }),
  ...over,
});

describe.each([
  ['recording/secrets', recordingSecrets],
  ['runner/secrets', runnerSecrets],
])('%s', (_label, mod) => {
  const { hasSecret, jsonHasSecret, scrubActProgram } = mod;
  const ctx = { redactor };
  const ctxWithValues = { redactor, secretValue: (name: string): string | undefined => ({ API_KEY: KEY, PASS }[name]) };

  describe('hasSecret', () => {
    it('is false for the empty string and for text without any secret variant', () => {
      expect(hasSecret(redactor, '')).toBe(false);
      expect(hasSecret(redactor, 'hello world, nothing to see')).toBe(false);
    });

    it.each(variantsOfPass)('R-SE1: detects the %s form of a secret, alone or embedded in text', (_name, form) => {
      expect(hasSecret(redactor, form)).toBe(true);
      expect(hasSecret(redactor, `https://x.test/?q=${form}&z=1`)).toBe(true);
    });

    it('is exactly "redact(text) !== text" (the redactor is the source of truth)', () => {
      const lax: Redactor = { redact: (t) => t.replace('MAGIC', '<x>'), redactJson: (v) => v, secretNames: [] };
      expect(hasSecret(lax, 'a MAGIC b')).toBe(true);
      expect(hasSecret(lax, 'a magic b')).toBe(false);
    });
  });

  describe('jsonHasSecret', () => {
    it('finds a secret in a nested string value, an array item or an object key', () => {
      expect(jsonHasSecret(redactor, { a: { b: [1, `x ${KEY}`] } })).toBe(true);
      expect(jsonHasSecret(redactor, { [KEY]: 1 })).toBe(true);
      expect(jsonHasSecret(redactor, [[KEY]])).toBe(true);
    });

    it('finds the JSON-escaped form of a secret that JSON.stringify produced', () => {
      expect(JSON.stringify({ v: PASS })).not.toContain(PASS);
      expect(jsonHasSecret(redactor, { v: PASS })).toBe(true);
    });

    it('is false for clean data and for primitives', () => {
      expect(jsonHasSecret(redactor, { a: [1, 'two', null, true] })).toBe(false);
      expect(jsonHasSecret(redactor, 'plain')).toBe(false);
      expect(jsonHasSecret(redactor, 42)).toBe(false);
      expect(jsonHasSecret(redactor, null)).toBe(false);
    });

    it('is false for values JSON cannot serialize to text (undefined, functions)', () => {
      expect(jsonHasSecret(redactor, undefined)).toBe(false);
      expect(jsonHasSecret(redactor, () => KEY)).toBe(false);
    });

    it('fails closed on a value it cannot serialize: the error propagates instead of reporting "clean"', () => {
      const circular: Record<string, unknown> = { token: KEY };
      circular.self = circular;
      expect(() => jsonHasSecret(redactor, circular)).toThrow(TypeError);
    });
  });

  describe('scrubActProgram', () => {
    it('leaves a clean program equal in content and reports no extra fuzzy reasons', () => {
      const clean = program([
        { verb: 'navigate', url: 'https://x.test/a' },
        { verb: 'click', target: sel({ testId: 'save', ancestors: [{ role: 'form', name: 'Profile' }], index: 1, of: 3 }) },
        { verb: 'fill', target: sel({ role: 'textbox', name: 'Name' }), value: { literal: 'Ada' } },
        { verb: 'back' },
        { verb: 'wait', ms: 10 },
      ]);
      const out = scrubActProgram(clean, ctx);
      expect(out.fuzzyReasons).toEqual([]);
      expect(out.act).toEqual(clean);
    });

    it('keeps startLandmarks and does not mutate its input', () => {
      const input = program([{ verb: 'navigate', url: `https://x.test/?k=${KEY}` }], { startRoute: `/s?k=${KEY}` });
      const snapshot = structuredClone(input);
      const out = scrubActProgram(input, ctx);
      expect(input).toEqual(snapshot);
      expect(out.act.startLandmarks).toBe('a'.repeat(64));
    });

    it('is idempotent', () => {
      const dirty = program(
        [
          { verb: 'navigate', url: `https://x.test/?k=${KEY}` },
          { verb: 'fill', target: sel({ name: `field ${KEY}` }), value: { literal: `${PASS}!` } },
        ],
        { effect: effect({ appeared: [{ role: 'text', name: KEY }], routeAfter: `/r?${KEY}` }) },
      );
      const once = scrubActProgram(dirty, ctx);
      const twice = scrubActProgram(once.act, ctx);
      expect(twice.act).toEqual(once.act);
      expect(twice.fuzzyReasons).toEqual([]);
    });

    describe('navigate and press keys', () => {
      it('R-SE1: redacts a secret in a navigate URL and marks the step secret-in-recording', () => {
        const out = scrubActProgram(program([{ verb: 'navigate', url: `https://x.test/cb?token=${KEY}&x=1` }]), ctx);
        expect(out.act.actions).toEqual([{ verb: 'navigate', url: 'https://x.test/cb?token=<secret:API_KEY>&x=1' }]);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it.each(variantsOfPass)('R-SE1: a navigate URL holding the %s form of a secret is redacted', (_n, form) => {
        const out = scrubActProgram(program([{ verb: 'navigate', url: `https://x.test/cb?v=${form}` }]), ctx);
        expect(out.act.actions).toEqual([{ verb: 'navigate', url: 'https://x.test/cb?v=<secret:PASS>' }]);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('redacts the key of a press, with or without a target', () => {
        const out = scrubActProgram(
          program([
            { verb: 'press', key: KEY },
            { verb: 'press', key: `${KEY}+x`, target: sel({ name: 'Box' }) },
          ]),
          ctx,
        );
        expect(out.act.actions).toEqual([
          { verb: 'press', key: '<secret:API_KEY>' },
          { verb: 'press', key: '<secret:API_KEY>+x', target: sel({ name: 'Box' }) },
        ]);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('a press without a target does not gain a target property, a clean press stays clean', () => {
        const out = scrubActProgram(program([{ verb: 'press', key: 'Enter' }, { verb: 'press', key: 'Tab', target: sel() }]), ctx);
        expect(out.act.actions[0]).toEqual({ verb: 'press', key: 'Enter' });
        expect('target' in (out.act.actions[0] as object)).toBe(false);
        expect(out.act.actions[1]).toEqual({ verb: 'press', key: 'Tab', target: sel() });
        expect(out.fuzzyReasons).toEqual([]);
      });
    });

    describe('selectors', () => {
      it('R-SE1: redacts role, name, every ancestor and the testId, keeping index and of', () => {
        const dirty = sel({
          role: 'button',
          name: `Pay ${KEY}`,
          testId: `t-${KEY}`,
          ancestors: [
            { role: 'dialog', name: `Hi ${KEY}` },
            { role: 'form', name: 'ok' },
          ],
          index: 2,
          of: 5,
        });
        const out = scrubActProgram(program([{ verb: 'click', target: dirty }, { verb: 'hover', target: dirty }]), ctx);
        const clean: Selector = {
          role: 'button',
          name: 'Pay <secret:API_KEY>',
          testId: 't-<secret:API_KEY>',
          ancestors: [
            { role: 'dialog', name: 'Hi <secret:API_KEY>' },
            { role: 'form', name: 'ok' },
          ],
          index: 2,
          of: 5,
        };
        expect(out.act.actions).toEqual([{ verb: 'click', target: clean }, { verb: 'hover', target: clean }]);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it.each([
        ['role', sel({ role: KEY })],
        ['ancestor role', sel({ ancestors: [{ role: KEY, name: 'x' }] })],
        ['ancestor name', sel({ ancestors: [{ role: 'x', name: KEY }] })],
        ['testId', sel({ testId: KEY })],
      ])('R-SE1: a secret only in the selector %s still turns the step secret-in-recording', (_n, target) => {
        const out = scrubActProgram(program([{ verb: 'click', target }]), ctx);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
        expect(jsonHasSecret(redactor, out.act)).toBe(false);
      });

      it('a selector without testId stays without a testId key', () => {
        const out = scrubActProgram(program([{ verb: 'click', target: sel() }]), ctx);
        expect('testId' in (out.act.actions[0] as { target: Selector }).target).toBe(false);
      });

      it('check keeps its checked flag, and redacts its target', () => {
        const out = scrubActProgram(program([{ verb: 'check', target: sel({ name: KEY }), checked: false }, { verb: 'check', target: sel(), checked: true }]), ctx);
        expect(out.act.actions).toEqual([
          { verb: 'check', target: sel({ name: '<secret:API_KEY>' }), checked: false },
          { verb: 'check', target: sel(), checked: true },
        ]);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('scroll keeps its direction; a scroll with a target is redacted, one without stays as it was', () => {
        const bare: RecordedAction = { verb: 'scroll', direction: 'down' };
        const out = scrubActProgram(program([bare, { verb: 'scroll', direction: 'up', target: sel({ name: KEY }) }]), ctx);
        expect(out.act.actions[0]).toBe(bare);
        expect(out.act.actions[1]).toEqual({ verb: 'scroll', direction: 'up', target: sel({ name: '<secret:API_KEY>' }) });
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('back and wait pass through untouched (same object)', () => {
        const back: RecordedAction = { verb: 'back' };
        const wait: RecordedAction = { verb: 'wait', ms: 10 };
        const out = scrubActProgram(program([back, wait]), ctx);
        expect(out.act.actions[0]).toBe(back);
        expect(out.act.actions[1]).toBe(wait);
      });
    });

    describe('typed values', () => {
      const fill = (value: { literal: string } | { param: string } | { secret: string }): RecordedAction => ({ verb: 'fill', target: sel({ role: 'textbox', name: 'Key' }), value });

      it('R-SE1: a literal equal to a secret value is recorded as {secret: name}, and the step stays replayable', () => {
        const out = scrubActProgram(program([fill({ literal: KEY })]), ctxWithValues);
        expect(out.act.actions).toEqual([{ verb: 'fill', target: sel({ role: 'textbox', name: 'Key' }), value: { secret: 'API_KEY' } }]);
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('a literal equal to a secret up to surrounding whitespace is also recorded as {secret: name}', () => {
        const out = scrubActProgram(program([fill({ literal: `${KEY}\n ` })]), ctxWithValues);
        expect((out.act.actions[0] as { value: unknown }).value).toEqual({ secret: 'API_KEY' });
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('R-SE1: a literal that merely contains a secret is redacted and the step turns secret-in-recording', () => {
        const out = scrubActProgram(program([fill({ literal: `prefix-${KEY}-suffix` })]), ctxWithValues);
        expect((out.act.actions[0] as { value: unknown }).value).toEqual({ literal: 'prefix-<secret:API_KEY>-suffix' });
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('R-SE1: without a secretValue lookup even an exact secret literal is redacted, never kept raw', () => {
        const out = scrubActProgram(program([fill({ literal: KEY })]), ctx);
        expect((out.act.actions[0] as { value: unknown }).value).toEqual({ literal: '<secret:API_KEY>' });
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('R-SE1: an encoded form of a secret in a literal is redacted even when the lookup knows the raw value', () => {
        const out = scrubActProgram(program([fill({ literal: Buffer.from(KEY).toString('base64') })]), ctxWithValues);
        expect((out.act.actions[0] as { value: unknown }).value).toEqual({ literal: '<secret:API_KEY>' });
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('names whose value the lookup does not know are skipped; a later name can still match', () => {
        const partial = { redactor, secretValue: (name: string): string | undefined => (name === 'PASS' ? PASS : undefined) };
        const asPass = scrubActProgram(program([fill({ literal: PASS })]), partial);
        expect((asPass.act.actions[0] as { value: unknown }).value).toEqual({ secret: 'PASS' });
        const asKey = scrubActProgram(program([fill({ literal: KEY })]), partial);
        expect((asKey.act.actions[0] as { value: unknown }).value).toEqual({ literal: '<secret:API_KEY>' });
        expect(asKey.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it('a literal that is not a secret, and param or secret sources, are untouched', () => {
        const out = scrubActProgram(program([fill({ literal: 'Ada' }), fill({ param: 'name' }), fill({ secret: 'API_KEY' })]), ctxWithValues);
        expect(out.act.actions.map((a) => (a as { value: unknown }).value)).toEqual([{ literal: 'Ada' }, { param: 'name' }, { secret: 'API_KEY' }]);
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('select treats its option like a fill value and redacts its target', () => {
        const target = sel({ role: 'combobox', name: 'Plan' });
        const out = scrubActProgram(
          program([
            { verb: 'select', target, option: { literal: KEY } },
            { verb: 'select', target, option: { literal: `x${PASS}` } },
            { verb: 'select', target, option: { param: 'plan' } },
          ]),
          ctxWithValues,
        );
        expect(out.act.actions).toEqual([
          { verb: 'select', target, option: { secret: 'API_KEY' } },
          { verb: 'select', target, option: { literal: 'x<secret:PASS>' } },
          { verb: 'select', target, option: { param: 'plan' } },
        ]);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });
    });

    describe('routes', () => {
      it('R-SE1: a secret in startRoute is redacted and marks the step secret-in-recording', () => {
        const out = scrubActProgram(program([{ verb: 'back' }], { startRoute: `/login?t=${KEY}` }), ctx);
        expect(out.act.startRoute).toBe('/login?t=<secret:API_KEY>');
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });

      it.each([
        ['routeBefore', { routeBefore: `/b?${KEY}`, routeAfter: '/after' }, { routeBefore: '/b?<secret:API_KEY>', routeAfter: '/after' }],
        ['routeAfter', { routeBefore: '/before', routeAfter: `/a?${KEY}` }, { routeBefore: '/before', routeAfter: '/a?<secret:API_KEY>' }],
      ])('R-SE1: a secret in the effect %s is redacted and marks the step secret-in-recording', (_n, routes, expected) => {
        const out = scrubActProgram(program([{ verb: 'back' }], { effect: effect({ ...routes, appeared: [{ role: 'x', name: 'y' }] }) }), ctx);
        expect(out.act.effect.routeBefore).toBe(expected.routeBefore);
        expect(out.act.effect.routeAfter).toBe(expected.routeAfter);
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
      });
    });

    describe('effect signature', () => {
      const clean = { role: 'status', name: 'Saved' };

      it('R-SE1: drops appeared and disappeared nodes whose role or name carries a secret, keeping the others', () => {
        const out = scrubActProgram(
          program([{ verb: 'back' }], {
            effect: effect({
              appeared: [clean, { role: 'text', name: `Key ${KEY}` }, { role: KEY, name: 'n' }],
              disappeared: [{ role: 'text', name: `Old ${PASS}` }, { role: 'link', name: 'Gone' }],
            }),
          }),
          ctx,
        );
        expect(out.act.effect.appeared).toEqual([clean]);
        expect(out.act.effect.disappeared).toEqual([{ role: 'link', name: 'Gone' }]);
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('R-SE1: drops changed entries whose key, state, old value or new value carries a secret', () => {
        const ok = { key: { role: 'textbox', name: 'Name' }, state: 'value', from: 'a', to: 'b' };
        const out = scrubActProgram(
          program([{ verb: 'back' }], {
            effect: effect({
              changed: [
                ok,
                { ...ok, key: { role: 'textbox', name: KEY } },
                { ...ok, key: { role: KEY, name: 'Name' } },
                { ...ok, state: `v-${KEY}` },
                { ...ok, from: `old ${KEY}` },
                { ...ok, to: `new ${KEY}` },
                { ...ok, from: { nested: [KEY] } },
                { ...ok, to: [{ [PASS]: 1 }] },
              ],
            }),
          }),
          ctx,
        );
        expect(out.act.effect.changed).toEqual([ok]);
        expect(jsonHasSecret(redactor, out.act.effect)).toBe(false);
      });

      it('keeps changed entries whose values are clean strings, numbers, booleans, null, arrays or objects', () => {
        const key = { role: 'x', name: 'y' };
        const changed = [
          { key, state: 's', from: 1, to: 2 },
          { key, state: 's', from: true, to: null },
          { key, state: 's', from: ['a', { b: 1 }], to: { c: ['d'] } },
          { key, state: '', from: '', to: 'z' },
        ];
        const out = scrubActProgram(program([{ verb: 'back' }], { effect: effect({ changed }) }), ctx);
        expect(out.act.effect.changed).toEqual(changed);
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('an effect emptied by dropping secret-bearing entries yields no-observable-effect', () => {
        const out = scrubActProgram(program([{ verb: 'back' }], { effect: effect({ appeared: [{ role: 't', name: KEY }] }) }), ctx);
        expect(out.act.effect).toEqual(effect());
        expect(out.fuzzyReasons).toEqual(['no-observable-effect']);
      });

      it('emptied through every list at once also yields no-observable-effect, once', () => {
        const key = { role: 't', name: KEY };
        const out = scrubActProgram(
          program([{ verb: 'back' }], { effect: effect({ appeared: [key], disappeared: [key], changed: [{ key, state: 's', from: 1, to: 2 }] }) }),
          ctx,
        );
        expect(out.fuzzyReasons).toEqual(['no-observable-effect']);
      });

      it('dropping from only one list does not count as emptied while another list still has entries', () => {
        const out = scrubActProgram(
          program([{ verb: 'back' }], { effect: effect({ appeared: [{ role: 't', name: KEY }], disappeared: [clean] }) }),
          ctx,
        );
        expect(out.act.effect.disappeared).toEqual([clean]);
        expect(out.fuzzyReasons).toEqual([]);
      });

      const dropped = { role: 't', name: KEY };
      it.each([
        ['appeared', { appeared: [dropped, clean] }],
        ['disappeared', { appeared: [dropped], disappeared: [clean] }],
        ['changed', { appeared: [dropped], changed: [{ key: clean, state: 's', from: 1, to: 2 }] }],
      ])('a remaining %s entry keeps the effect from counting as emptied', (_n, shape) => {
        const out = scrubActProgram(program([{ verb: 'back' }], { effect: effect(shape) }), ctx);
        expect(out.act.effect.appeared).not.toContainEqual(dropped);
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('an effect that was already empty before scrubbing is not reported as emptied by the scrub', () => {
        const out = scrubActProgram(program([{ verb: 'back' }], { effect: effect() }), ctx);
        expect(out.fuzzyReasons).toEqual([]);
      });

      it('an emptied effect with a changed route still has an observable effect', () => {
        const out = scrubActProgram(
          program([{ verb: 'back' }], { effect: effect({ routeBefore: '/a', routeAfter: '/b', appeared: [{ role: 't', name: KEY }] }) }),
          ctx,
        );
        expect(out.fuzzyReasons).toEqual([]);
        expect(out.act.effect.routeAfter).toBe('/b');
      });

      it('routes that only become equal after redaction count as unchanged, in addition to secret-in-recording', () => {
        const out = scrubActProgram(
          program([{ verb: 'back' }], {
            effect: effect({ routeBefore: `/p?k=${KEY}`, routeAfter: `/p?k=${PASS}`, appeared: [{ role: 't', name: KEY }] }),
          }),
          { redactor: createRedactor({ K: KEY, P: PASS }) },
        );
        // different secrets stay distinguishable ("<secret:K>" vs "<secret:P>"), so the routes still differ
        expect(out.act.effect.routeBefore).toBe('/p?k=<secret:K>');
        expect(out.act.effect.routeAfter).toBe('/p?k=<secret:P>');
        expect(out.fuzzyReasons).toEqual(['secret-in-recording']);

        const same = scrubActProgram(
          program([{ verb: 'back' }], {
            effect: effect({ routeBefore: `/p?k=${KEY}`, routeAfter: `/p?k=${Buffer.from(KEY).toString('base64')}`, appeared: [{ role: 't', name: KEY }] }),
          }),
          ctx,
        );
        expect(same.act.effect.routeBefore).toBe(same.act.effect.routeAfter);
        expect(same.fuzzyReasons).toEqual(['no-observable-effect', 'secret-in-recording']);
      });
    });

    it('R-SE1: nothing that remains in the scrubbed program holds any variant of any secret', () => {
      const dirtyStrings = variantsOfPass.map(([, form]) => form).concat([KEY, Buffer.from(KEY).toString('base64url'), encodeURIComponent(KEY)]);
      const actions: RecordedAction[] = dirtyStrings.flatMap((s): RecordedAction[] => [
        { verb: 'navigate', url: `https://x.test/?v=${s}` },
        { verb: 'click', target: sel({ name: s, testId: s, ancestors: [{ role: s, name: s }] }) },
        { verb: 'fill', target: sel({ role: s }), value: { literal: `a ${s} b` } },
        { verb: 'select', target: sel(), option: { literal: s } },
        { verb: 'press', key: s },
        { verb: 'scroll', direction: 'down', target: sel({ name: s }) },
      ]);
      const node = (s: string): { role: string; name: string } => ({ role: 'text', name: s });
      const dirty = program(actions, {
        startRoute: `/s?${dirtyStrings.join('&')}`,
        effect: effect({
          routeBefore: `/b?${dirtyStrings[0]}`,
          routeAfter: `/a?${dirtyStrings[1]}`,
          appeared: dirtyStrings.map(node),
          disappeared: dirtyStrings.map(node),
          changed: dirtyStrings.map((s) => ({ key: node('k'), state: 's', from: s, to: [{ [s]: s }] })),
        }),
      });
      expect(jsonHasSecret(redactor, dirty)).toBe(true);
      const out = scrubActProgram(dirty, ctxWithValues);
      expect(jsonHasSecret(redactor, out.act)).toBe(false);
      expect(out.fuzzyReasons).toContain('secret-in-recording');
    });
  });
});

describe('recording/secrets and runner/secrets stay in sync', () => {
  it('produce identical results for the same dirty program and context', () => {
    const dirty = program(
      [
        { verb: 'navigate', url: `https://x.test/?k=${KEY}` },
        { verb: 'click', target: sel({ name: PASS, testId: KEY }) },
        { verb: 'fill', target: sel(), value: { literal: KEY } },
        { verb: 'fill', target: sel(), value: { literal: `x${KEY}` } },
        { verb: 'press', key: KEY, target: sel() },
        { verb: 'scroll', direction: 'up', target: sel({ name: KEY }) },
        { verb: 'back' },
      ],
      {
        startRoute: `/s?${KEY}`,
        effect: effect({ appeared: [{ role: 'a', name: KEY }, { role: 'b', name: 'ok' }], changed: [{ key: { role: 'k', name: 'n' }, state: 's', from: KEY, to: 1 }] }),
      },
    );
    const context = { redactor, secretValue: (name: string): string | undefined => ({ API_KEY: KEY, PASS }[name]) };
    expect(runnerSecrets.scrubActProgram(dirty, context)).toEqual(recordingSecrets.scrubActProgram(dirty, context));
    for (const text of ['', 'clean', KEY, `a${PASS}b`]) {
      expect(runnerSecrets.hasSecret(redactor, text)).toBe(recordingSecrets.hasSecret(redactor, text));
    }
    for (const value of [undefined, { a: KEY }, [1, 2], 'x']) {
      expect(runnerSecrets.jsonHasSecret(redactor, value)).toBe(recordingSecrets.jsonHasSecret(redactor, value));
    }
  });
});
