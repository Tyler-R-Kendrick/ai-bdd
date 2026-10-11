import { describe, expect, it } from 'vitest';
import type { ActProgram, EffectSignature, RecordedAction, Redactor } from '../../src/contracts/index.ts';
import { hasSecret, scrubActProgram } from '../../src/recording/secrets.ts';

/**
 * Redactors here are stubs on purpose: the real redactor can never reach some of these branches (it maps the empty
 * string to itself, and a text that contains a secret variant can only equal the secret up to edge whitespace), so the
 * decisions of secrets.ts are pinned against redactors whose answers are fully known.
 */
const stub = (flags: (text: string) => boolean, secretNames: string[] = []): Redactor => ({
  redact: (text) => (flags(text) ? '<redacted>' : text),
  redactJson: (v) => v,
  secretNames,
});

const effect = (over: Partial<EffectSignature> = {}): EffectSignature => ({ routeBefore: '/a', routeAfter: '/a', appeared: [], disappeared: [], changed: [], ...over });
const program = (actions: RecordedAction[], over: Partial<EffectSignature> = {}): ActProgram => ({
  startRoute: '/start',
  startLandmarks: 'a'.repeat(64),
  actions,
  effect: effect({ appeared: [{ role: 'status', name: 'Saved' }], ...over }),
});
const target = { role: 'textbox', name: 'Field', ancestors: [], index: 0, of: 1 };
const fill = (literal: string): RecordedAction => ({ verb: 'fill', target, value: { literal } });
const valueOf = (a: RecordedAction): unknown => (a as { value: unknown }).value;

describe('hasSecret', () => {
  it('is false for the empty string even when the redactor would change it', () => {
    const appends: Redactor = { redact: (t) => `${t}!`, redactJson: (v) => v, secretNames: [] };
    expect(hasSecret(appends, '')).toBe(false);
    expect(hasSecret(appends, 'x')).toBe(true);
  });
});

describe('scrubActProgram effect values', () => {
  const key = { role: 'textbox', name: 'Name' };
  const entry = (from: unknown, to: unknown): EffectSignature['changed'][number] =>
    ({ key, state: 'value', from, to }) as EffectSignature['changed'][number];

  // The redactor flags only a text that is exactly MAGIC: it sees the string itself, never its JSON-quoted form.
  const exact = stub((t) => t === 'MAGIC');

  it('a string value is judged as the bare string, not as its JSON text', () => {
    const out = scrubActProgram(program([{ verb: 'back' }], { changed: [entry('MAGIC', 'b'), entry('a', 'MAGIC'), entry('a', 'b')] }), { redactor: exact });
    expect(out.act.effect.changed).toEqual([entry('a', 'b')]);
  });

  it('an object or array value is judged by its JSON text', () => {
    const json = stub((t) => t.includes('"MAGIC"'));
    const out = scrubActProgram(
      program([{ verb: 'back' }], { changed: [entry({ k: 'MAGIC' }, 'b'), entry('a', ['MAGIC']), entry({ k: 'fine' }, ['fine'])] }),
      { redactor: json },
    );
    expect(out.act.effect.changed).toEqual([entry({ k: 'fine' }, ['fine'])]);
  });

  it('null and booleans are kept as they are, even if their JSON text would be flagged', () => {
    const literal = stub((t) => t === 'null' || t === 'true' || t === 'false');
    const changed = [entry(null, 'b'), entry('a', null), entry(true, false)];
    const out = scrubActProgram(program([{ verb: 'back' }], { changed }), { redactor: literal });
    expect(out.act.effect.changed).toEqual(changed);
    expect(out.fuzzyReasons).toEqual([]);
  });
});

describe('scrubActProgram literal equal to a secret up to whitespace', () => {
  const lookup = (value: string) => (name: string): string | undefined => (name === 'S' ? value : undefined);
  // Flags any text that mentions "k", so `hasSecret` is true for the literals below and only the comparison decides.
  const redactor = stub((t) => t.includes('k'), ['S']);

  it('runs of whitespace collapse to one space before the comparison', () => {
    const out = scrubActProgram(program([fill('k  b')]), { redactor, secretValue: lookup('k b') });
    expect(valueOf(out.act.actions[0] as RecordedAction)).toEqual({ secret: 'S' });
    expect(out.fuzzyReasons).toEqual([]);
    const other = scrubActProgram(program([fill('k b')]), { redactor, secretValue: lookup('k \t\n b') });
    expect(valueOf(other.act.actions[0] as RecordedAction)).toEqual({ secret: 'S' });
    expect(other.fuzzyReasons).toEqual([]);
  });

  it('whitespace is collapsed to a single space, not removed: "k b" is not the secret "kb"', () => {
    const out = scrubActProgram(program([fill('k b')]), { redactor, secretValue: lookup('kb') });
    expect(valueOf(out.act.actions[0] as RecordedAction)).toEqual({ literal: '<redacted>' });
    expect(out.fuzzyReasons).toEqual(['secret-in-recording']);
    const reverse = scrubActProgram(program([fill('kb')]), { redactor, secretValue: lookup('k b') });
    expect(valueOf(reverse.act.actions[0] as RecordedAction)).toEqual({ literal: '<redacted>' });
  });

  it('leading and trailing whitespace is ignored by the comparison', () => {
    const out = scrubActProgram(program([fill('  k b \n')]), { redactor, secretValue: lookup('k b') });
    expect(valueOf(out.act.actions[0] as RecordedAction)).toEqual({ secret: 'S' });
  });
});
