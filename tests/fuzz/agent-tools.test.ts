import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '@ai-bdd/sdk/contracts';
import { hostileString, jsonValue, params } from './helpers.ts';
import { ALL_VERBS, COMPLETE_STEP, buildTools, isVerb, parseVerbCall, type ParsedCall } from '../../packages/sdk/src/agent/tools.ts';

const MAX_WAIT = 5000;

/** Structural check of the DriverAction contract (contracts/index.ts) for a parsed call; returns the problems found. */
function driverActionProblems(call: ParsedCall, maxWaitMs: number): string[] {
  const problems: string[] = [];
  const nonEmpty = (v: unknown, what: string): void => {
    if (typeof v !== 'string' || v === '') problems.push(`${what} must be a non-empty string`);
  };
  const allowed: Record<string, string[]> = {
    navigate: ['verb', 'url'], click: ['verb', 'ref'], hover: ['verb', 'ref'], fill: ['verb', 'ref', 'value'], press: ['verb', 'key', 'ref'],
    select: ['verb', 'ref', 'option'], check: ['verb', 'ref', 'checked'], scroll: ['verb', 'direction', 'ref'], back: ['verb'], wait: ['verb', 'ms'],
  };
  const keys = Object.keys(call);
  if (!isVerb(call.verb)) return [`unknown verb ${String(call.verb)}`];
  for (const k of keys) if (!(allowed[call.verb] as string[]).includes(k)) problems.push(`unexpected key ${k}`);
  if (Object.values(call).some((v) => v === undefined)) problems.push('undefined-valued key');
  switch (call.verb) {
    case 'navigate': nonEmpty(call.url, 'url'); break;
    case 'click': case 'hover': nonEmpty(call.ref, 'ref'); break;
    case 'fill': {
      nonEmpty(call.ref, 'ref');
      const v = call.value as Record<string, unknown>;
      const vk = Object.keys(v);
      if (vk.length !== 1 || !['literal', 'param', 'secret'].includes(vk[0] as string) || typeof v[vk[0] as string] !== 'string') problems.push('value must be exactly one of {literal}|{param}|{secret} with a string');
      break;
    }
    case 'press': nonEmpty(call.key, 'key'); if ('ref' in call) nonEmpty(call.ref, 'ref'); break;
    case 'select': nonEmpty(call.ref, 'ref'); if (typeof call.option !== 'string') problems.push('option must be a string'); break;
    case 'check': nonEmpty(call.ref, 'ref'); if (typeof call.checked !== 'boolean') problems.push('checked must be boolean'); break;
    case 'scroll': if (call.direction !== 'up' && call.direction !== 'down') problems.push('direction'); if ('ref' in call) nonEmpty(call.ref, 'ref'); break;
    case 'wait': if (!Number.isInteger(call.ms) || call.ms < 0 || call.ms > maxWaitMs) problems.push(`ms ${call.ms} out of range`); break;
    case 'back': break;
  }
  return problems;
}

// ───────────────────────── generators

const verbs = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...ALL_VERBS) }, { weight: 2, arbitrary: fc.constantFrom('constructor', '__proto__', 'toString', 'complete_step', 'Click', 'click ', '', 'navigate\0') }, { weight: 1, arbitrary: hostileString({ maxLength: 12 }) });
const scalar: fc.Arbitrary<JsonValue> = fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('', 'e1', 'r1:e2', 'Enter', 'up', 'down', 'x'), fc.integer({ min: -5, max: 10_000 }), fc.double({ noNaN: true }), fc.boolean(), fc.constant(null), hostileString({ maxLength: 10 }), jsonValue({ maxDepth: 2, maxKeys: 2 }));
const ARG_KEYS = ['ref', 'text', 'param', 'secret', 'key', 'option', 'checked', 'direction', 'url', 'ms', 'extra', '__proto__', 'constructor'];
const argsArb: fc.Arbitrary<JsonObject> = fc
  .array(fc.tuple(fc.constantFrom(...ARG_KEYS), scalar), { maxLength: 6 })
  .map((entries) => Object.fromEntries(entries) as JsonObject);
const randomObject = jsonValue({ maxDepth: 3, maxKeys: 5 }).filter((v): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v));
const maxWaitArb = fc.oneof(fc.constant(MAX_WAIT), fc.integer({ min: 0, max: 100_000 }));

describe('fuzz: parseVerbCall', () => {
  it('never throws: any verb name and any JSON arguments give a verb call or a rejection with a message', () => {
    fc.assert(
      fc.property(verbs, fc.oneof(argsArb, randomObject), maxWaitArb, (verb, args, maxWait) => {
        const r = parseVerbCall(verb, args, maxWait);
        if (r.ok) expect(driverActionProblems(r.call, maxWait), JSON.stringify(r.call)).toEqual([]);
        else {
          expect(typeof r.message).toBe('string');
          expect(r.message.length).toBeGreaterThan(0);
        }
      }),
      params({ scale: 2 }),
    );
  });

  it('only known verbs are accepted, and the parsed verb is the requested one', () => {
    fc.assert(
      fc.property(verbs, argsArb, (verb, args) => {
        const r = parseVerbCall(verb, args, MAX_WAIT);
        if (r.ok) {
          expect(isVerb(verb)).toBe(true);
          expect(r.call.verb).toBe(verb);
        } else if (!isVerb(verb)) expect(r.message).toBe(`unknown tool ${verb}`);
      }),
      params(),
    );
  });

  it('well-formed arguments are always accepted and mapped field by field (null counts as absent, unknown keys are ignored)', () => {
    const extra = fc.record({ extra: scalar, other: scalar }, { requiredKeys: [] });
    const refArb = fc.string({ minLength: 1, maxLength: 10 });
    const valid = fc.oneof(
      fc.record({ verb: fc.constant('navigate'), args: fc.record({ url: refArb }), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constantFrom('click', 'hover'), args: fc.record({ ref: refArb }), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('fill'), args: fc.oneof(fc.record({ ref: refArb, text: fc.string({ maxLength: 8 }) }), fc.record({ ref: refArb, param: refArb }), fc.record({ ref: refArb, secret: refArb })), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('press'), args: fc.oneof(fc.record({ key: refArb }), fc.record({ key: refArb, ref: refArb }), fc.record({ key: refArb, ref: fc.constant(null) })), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('select'), args: fc.record({ ref: refArb, option: fc.string({ maxLength: 8 }) }), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('check'), args: fc.record({ ref: refArb, checked: fc.boolean() }), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('scroll'), args: fc.oneof(fc.record({ direction: fc.constantFrom('up', 'down') }), fc.record({ direction: fc.constantFrom('up', 'down'), ref: refArb })), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('back'), args: fc.constant({}), expected: fc.constant(undefined) }),
      fc.record({ verb: fc.constant('wait'), args: fc.record({ ms: fc.double({ min: 0, max: MAX_WAIT, noNaN: true }) }), expected: fc.constant(undefined) }),
    );
    fc.assert(
      fc.property(valid, extra, ({ verb, args }, more) => {
        const input = { ...(more as JsonObject), ...(args as JsonObject) };
        const r = parseVerbCall(verb, input, MAX_WAIT);
        expect(r.ok, `${verb} ${JSON.stringify(args)}`).toBe(true);
        if (!r.ok) return;
        const call = r.call as Record<string, unknown>;
        for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
          if (v === null) expect(k in call).toBe(false);
          else if (k === 'text') expect(call['value']).toEqual({ literal: v });
          else if (k === 'param') expect(call['value']).toEqual({ param: v });
          else if (k === 'secret') expect(call['value']).toEqual({ secret: v });
          else if (k === 'ms') expect(call['ms']).toBe(Math.round(v as number));
          else expect(call[k]).toBe(v);
        }
        // the same arguments with every optional null removed give the same call
        const stripped = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null)) as JsonObject;
        expect(parseVerbCall(verb, stripped, MAX_WAIT)).toEqual(r);
      }),
      params(),
    );
  });

  it('rejects ambiguous or incomplete fill, empty refs and keys, wrong types, and waits outside [0, max]', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 6 }), fc.subarray(['text', 'param', 'secret'] as const, { minLength: 2 }), (ref, given) => {
        const args: JsonObject = { ref };
        for (const k of given) args[k] = 'v';
        const r = parseVerbCall('fill', args, MAX_WAIT);
        expect(r.ok).toBe(false);
        expect(parseVerbCall('fill', { ref }, MAX_WAIT).ok).toBe(false);
        expect(parseVerbCall('fill', { ref: '', text: 'x' }, MAX_WAIT).ok).toBe(false);
        expect(parseVerbCall('fill', { ref, text: 1 }, MAX_WAIT).ok).toBe(false);
      }),
      params(),
    );
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0, 0, 1e308), fc.string(), fc.constant(null), fc.boolean()), maxWaitArb, (ms, max) => {
        const r = parseVerbCall('wait', { ms: ms as JsonValue }, max);
        const valid = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= max;
        expect(r.ok).toBe(valid);
        if (r.ok) expect(r.call).toEqual({ verb: 'wait', ms: Math.round(ms as number) });
      }),
      params(),
    );
    for (const verb of ['click', 'hover']) for (const ref of ['', 1, null, [], {}, true]) expect(parseVerbCall(verb, { ref: ref as JsonValue }, MAX_WAIT).ok).toBe(false);
    expect(parseVerbCall('press', { key: 'Enter', ref: '' }, MAX_WAIT).ok).toBe(false);
    expect(parseVerbCall('scroll', { direction: 'left' }, MAX_WAIT).ok).toBe(false);
    expect(parseVerbCall('check', { ref: 'e1', checked: 'true' }, MAX_WAIT).ok).toBe(false);
  });
});

describe('fuzz: buildTools', () => {
  it('offers each requested verb once, in order, with a closed object schema, followed by complete_step', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ALL_VERBS), { maxLength: 20 }), fc.integer({ min: 0, max: 60_000 }), (verbsAsked, maxWait) => {
        const tools = buildTools(verbsAsked, maxWait);
        const names = tools.map((t) => t.name);
        expect(names[names.length - 1]).toBe(COMPLETE_STEP);
        expect(names.slice(0, -1)).toEqual([...new Set(verbsAsked)]);
        expect(new Set(names).size).toBe(names.length);
        for (const t of tools) {
          expect(t.inputSchema['type']).toBe('object');
          expect(t.inputSchema['additionalProperties']).toBe(false);
          const required = t.inputSchema['required'] as string[];
          const props = Object.keys(t.inputSchema['properties'] as object);
          for (const k of required) expect(props).toContain(k);
          expect(() => JSON.stringify(t)).not.toThrow();
        }
        const wait = tools.find((t) => t.name === 'wait');
        if (wait !== undefined) expect((wait.inputSchema['properties'] as { ms: { maximum: number } }).ms.maximum).toBe(maxWait);
      }),
      params(),
    );
  });

  it('a call that satisfies a tool spec (required keys present, only listed keys) is accepted by parseVerbCall', () => {
    const value = (schema: JsonObject, max: number): JsonValue => {
      if (schema['type'] === 'integer') return Math.min(3, max);
      if (schema['type'] === 'boolean') return true;
      if (Array.isArray(schema['enum'])) return (schema['enum'] as JsonValue[])[0] as JsonValue;
      return 'e1';
    };
    fc.assert(
      fc.property(fc.constantFrom(...ALL_VERBS), fc.integer({ min: 3, max: 9000 }), (verb, maxWait) => {
        const spec = buildTools([verb], maxWait)[0];
        const props = (spec?.inputSchema['properties'] ?? {}) as Record<string, JsonObject>;
        const required = (spec?.inputSchema['required'] ?? []) as string[];
        // fill needs exactly one value key, which the schema cannot express: give it "text"
        const args = Object.fromEntries((verb === 'fill' ? ['ref', 'text'] : required).map((k) => [k, value(props[k] as JsonObject, maxWait)])) as JsonObject;
        const r = parseVerbCall(verb, args, maxWait);
        expect(r.ok, `${verb} ${JSON.stringify(args)}`).toBe(true);
      }),
      params(),
    );
  });
});
