import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '@ai-bdd/driver-cua';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { assertPrototypeClean, hostileKey, hostileString, jsonEqual, jsonValue, params } from './helpers.ts';

const OPTION_KEYS = ['kind', 'launch', 'window', 'scope', 'delivery', 'cuaDriver', 'titleSuffix', 'startTimeoutMs', 'treeTimeoutMs', 'actionTimeoutMs', 'settleMs', 'maxSessions'];

const regexSource = fc.oneof(fc.constantFrom('Firefox', '.*', '^Calc', '\\d+', '(a|b)', '[a-z]+$'), fc.constantFrom('(', '[', '*', '\\', '(?<x', '{1,', '+'), hostileString({ maxLength: 12 }));
const strings = fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 });
const stringMap = fc.dictionary(fc.stringMatching(/^[A-Z_]{1,6}$/), fc.string({ maxLength: 6 }), { maxKeys: 3 });

/** Options that satisfy the schema (at least `launch` or `window`). */
const validOptions = fc
  .record(
    {
      kind: fc.constantFrom('browser', 'app'),
      scope: fc.constantFrom('content', 'window'),
      delivery: fc.constantFrom('auto', 'background', 'foreground'),
      launch: fc.record({ command: fc.string({ minLength: 1, maxLength: 8 }), args: strings, env: stringMap, cwd: fc.string({ maxLength: 8 }) }, { requiredKeys: ['command'] }),
      window: fc.oneof(fc.record({ title: fc.constantFrom('Firefox', '^Calc', '.*') }), fc.record({ app: fc.constantFrom('firefox', 'calc') }), fc.record({ title: fc.constant('x'), app: fc.constant('y') })),
      cuaDriver: fc.record({ command: fc.string({ minLength: 1, maxLength: 8 }), args: strings, env: stringMap }, { requiredKeys: [] }),
      titleSuffix: fc.constantFrom('\\s+-\\s+Mozilla Firefox$', ' - App$'),
      startTimeoutMs: fc.integer({ min: 1, max: 1_000_000 }),
      treeTimeoutMs: fc.double({ min: 0.001, max: 100_000, noNaN: true }),
      actionTimeoutMs: fc.integer({ min: 1, max: 1_000_000 }),
      settleMs: fc.integer({ min: 0, max: 10_000 }),
      maxSessions: fc.integer({ min: 1, max: 16 }),
    },
    { requiredKeys: [] },
  )
  .filter((o) => o.launch !== undefined || o.window !== undefined);

/** A valid option set with some members replaced by arbitrary JSON, plus unknown keys. */
const nearMiss = fc.tuple(validOptions, fc.array(fc.tuple(fc.oneof(fc.constantFrom(...OPTION_KEYS), hostileKey), jsonValue({ maxDepth: 3, maxKeys: 4 })), { minLength: 1, maxLength: 3 })).map(([base, muts]) => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of muts) Object.defineProperty(out, k, { value: v, enumerable: true, configurable: true, writable: true });
  return out;
});

const badRegex = fc.record({ window: fc.record({ title: fc.constantFrom('(', '[a-', '*', '\\') }) });

describe('fuzz: createDriverFactory options', () => {
  it('valid options give a factory with the cua id and are not modified', () => {
    fc.assert(
      fc.property(validOptions, (options) => {
        const before = JSON.stringify(options);
        const factory = createDriverFactory(options as Record<string, unknown>);
        expect(factory.id).toBe('cua');
        expect(typeof factory.create).toBe('function');
        expect(JSON.stringify(options)).toBe(before);
      }),
      params(),
    );
  });

  it('anything else is rejected with AiBddError(CONFIG_INVALID) naming the driver, never another error type', () => {
    const anyOptions = fc.oneof(
      { weight: 3, arbitrary: nearMiss },
      { weight: 2, arbitrary: jsonValue({ maxDepth: 3, maxKeys: 6 }) },
      { weight: 1, arbitrary: fc.constantFrom(null, undefined, 0, 1, '', 'launch', true, [], ['launch'], {}) },
      { weight: 1, arbitrary: badRegex },
      { weight: 1, arbitrary: fc.record({ window: fc.record({ title: regexSource }), titleSuffix: regexSource }, { requiredKeys: [] }) },
    );
    fc.assert(
      fc.property(anyOptions, (options) => {
        const snapshot = JSON.stringify(options);
        try {
          const factory = createDriverFactory(options as Record<string, unknown>);
          expect(factory.id).toBe('cua');
        } catch (e) {
          expect(e instanceof AiBddError, `threw ${String(e)}`).toBe(true);
          expect((e as AiBddError).code).toBe('CONFIG_INVALID');
          expect((e as AiBddError).message.startsWith('driver-cua: ')).toBe(true);
        }
        expect(JSON.stringify(options)).toBe(snapshot);
        assertPrototypeClean();
      }),
      params({ scale: 2 }),
    );
  });

  it('every unknown key is rejected by name, including prototype names', () => {
    fc.assert(
      fc.property(validOptions, hostileKey, (options, key) => {
        fc.pre(!OPTION_KEYS.includes(key));
        const polluted = Object.defineProperty({ ...options }, key, { value: 1, enumerable: true, configurable: true, writable: true });
        expect(() => createDriverFactory(polluted as Record<string, unknown>)).toThrow(AiBddError);
        try {
          createDriverFactory(polluted as Record<string, unknown>);
        } catch (e) {
          expect((e as AiBddError).message).toContain(`unknown option "${key}"`);
        }
      }),
      params(),
    );
  });

  it('mutating a valid value to the wrong type is rejected, never coerced', () => {
    const wrong: unknown[] = [null, true, false, '', 'x', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, [], {}, [1], { a: 1 }];
    const bounds: Record<string, (v: unknown) => boolean> = {
      kind: (v) => v === 'browser' || v === 'app',
      scope: (v) => v === 'content' || v === 'window',
      delivery: (v) => v === 'auto' || v === 'background' || v === 'foreground',
      titleSuffix: (v) => typeof v === 'string' && v.length > 0,
      startTimeoutMs: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      treeTimeoutMs: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      actionTimeoutMs: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      settleMs: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
      maxSessions: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
    };
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(bounds)), fc.constantFrom(...wrong), (key, value) => {
        const options = { launch: { command: 'app' }, [key]: value };
        const expectedOk = (bounds[key] as (v: unknown) => boolean)(value);
        let ok = true;
        try {
          createDriverFactory(options);
        } catch (e) {
          ok = false;
          expect(e instanceof AiBddError && e.code === 'CONFIG_INVALID', String(e)).toBe(true);
        }
        expect(ok, `${key}=${JSON.stringify(value)}`).toBe(expectedOk);
      }),
      params(),
    );
  });

  it('a regular expression option must compile', () => {
    const compiles = (s: string): boolean => {
      try {
        new RegExp(s);
        return true;
      } catch {
        return false;
      }
    };
    fc.assert(
      fc.property(regexSource, fc.constantFrom('title', 'app'), (source, field) => {
        let ok = true;
        try {
          createDriverFactory({ window: { [field]: source } });
        } catch (e) {
          ok = false;
          expect(e instanceof AiBddError && e.code === 'CONFIG_INVALID', String(e)).toBe(true);
        }
        expect(ok).toBe(source.length > 0 && compiles(source));
        expect(jsonEqual(source, source)).toBe(true);
      }),
      params(),
    );
  });
});
