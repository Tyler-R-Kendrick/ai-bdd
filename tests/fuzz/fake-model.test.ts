import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFakeModels, validateFakeRuleFile } from '@ai-bdd/testing';
import type { FakeMatcher, FakeRespond, FakeRule } from '@ai-bdd/testing';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { JsonObject, JsonValue, ModelPurpose, ModelRequest } from '@ai-bdd/sdk/contracts';
import { PROTO_KEYS, assertPrototypeClean, hostileKey, hostileString, jsonEqual, jsonValue, params } from './helpers.ts';
import { matchValue, resolvePath, ruleMatches } from '../../packages/testing/src/fake-model/match.ts';
import { produce } from '../../packages/testing/src/fake-model/respond.ts';

const PURPOSES: ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];
const purpose = fc.constantFrom(...PURPOSES);

// ───────────────────────── generators

const pathSeg = fc.oneof(fc.constantFrom('a', 'b', 'nodes', '0', '1', 'turn', 'attempt', 'sample', 'step', ...PROTO_KEYS, 'length', '', '01', '-1', '1e0'), hostileKey);
const dottedPath = fc.array(pathSeg, { minLength: 1, maxLength: 4 }).map((s) => s.join('.'));
const matcher: fc.Arbitrary<FakeMatcher> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom('1', 'true', 'x', ''),
  fc.string({ maxLength: 6 }).map((contains) => ({ contains })),
  fc.string({ maxLength: 6 }).map((notContains) => ({ notContains })),
  fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }).map((list) => ({ in: list })),
);
const whenArb = fc.array(fc.tuple(dottedPath, matcher), { maxLength: 3 }).map((e) => Object.fromEntries(e) as { [p: string]: FakeMatcher });
const context = jsonValue({ maxDepth: 3, maxKeys: 4 }).map((v): JsonObject => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : { a: v }));

/** A context that sometimes contains the paths and values the rules ask for. */
const contextArb = fc.oneof(context, fc.record({ a: fc.oneof(fc.string({ maxLength: 4 }), fc.constantFrom('x', 'abc', '1', true as unknown as string, 1 as unknown as string)), turn: fc.integer({ min: -2, max: 6 }), attempt: fc.integer({ min: 0, max: 4 }), sample: fc.integer({ min: -3, max: 6 }), nodes: fc.constant([{ ref: 'e1', role: 'button', name: 'Save', ancestors: ['Form'] }]) }, { requiredKeys: ['a'] }).map((c) => c as unknown as JsonObject));

const respondArb: fc.Arbitrary<FakeRespond> = fc.oneof(
  jsonValue({ maxDepth: 2 }).map((object) => ({ object })),
  fc.string({ maxLength: 10 }).map((text) => ({ text })),
  fc.array(fc.record({ tool: fc.constantFrom('click', 'fill', 'complete_step'), args: fc.oneof(fc.record({ target: fc.record({ role: fc.constantFrom('button', 'link'), name: fc.constantFrom('Save', 'save '), within: fc.constantFrom('Form', 'Other') }, { requiredKeys: ['role'] }) }), fc.record({ status: fc.constant('done'), summary: fc.string({ maxLength: 5 }) })) }, { requiredKeys: ['tool'] }), { maxLength: 3 }).map((script) => ({ script: script as FakeRespond extends { script: infer S } ? S : never })),
  fc.array(jsonValue({ maxDepth: 1 }), { minLength: 1, maxLength: 3 }).map((samples) => ({ samples })),
  fc.array(fc.oneof(jsonValue({ maxDepth: 1 }).map((object) => ({ object })), fc.string({ maxLength: 4 }).map((text) => ({ text }))), { minLength: 1, maxLength: 3 }).map((byAttempt) => ({ byAttempt })),
);

const ruleArb = (id: string): fc.Arbitrary<FakeRule> => fc.record({ id: fc.constant(id), purpose, when: whenArb, respond: respondArb }, { requiredKeys: ['id', 'purpose', 'respond'] }) as fc.Arbitrary<FakeRule>;
const rulesArb = fc.integer({ min: 1, max: 6 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => ruleArb(`r${i}`))));

function request(p: ModelPurpose, ctx: JsonObject): ModelRequest {
  return { purpose: p, system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], context: ctx };
}

// ───────────────────────── matching

describe('fuzz: fake model rule matching', () => {
  it('resolvePath only follows own properties and array indexes, and agrees with a reference walk', () => {
    const reference = (root: JsonValue, path: string): JsonValue | undefined => {
      let cur: unknown = root;
      for (const seg of path.split('.')) {
        if (Array.isArray(cur)) {
          if (!/^(0|[1-9]\d*)$/.test(seg) || Number(seg) >= cur.length) return undefined;
          cur = cur[Number(seg)];
        } else if (cur !== null && typeof cur === 'object' && Object.keys(cur).includes(seg)) cur = (cur as Record<string, unknown>)[seg];
        else return undefined;
        if (cur === undefined) return undefined;
      }
      return cur as JsonValue;
    };
    fc.assert(
      fc.property(context, dottedPath, (ctx, path) => {
        expect(jsonEqual(resolvePath(ctx, path), reference(ctx, path))).toBe(true);
      }),
      params(),
    );
    // inherited members are never resolved
    fc.assert(
      fc.property(fc.constantFrom(...PROTO_KEYS), fc.constantFrom('', '.name', '.length', '.prototype'), (key, rest) => {
        expect(resolvePath({ a: 1 }, `${key}${rest}`)).toBeUndefined();
        expect(resolvePath({ list: [1, 2] }, `list.${key}`)).toBeUndefined();
        expect(resolvePath({ s: 'str' }, `s.${key}`)).toBeUndefined();
      }),
      params(),
    );
  });

  it('matchValue / ruleMatches never throw, on any value shape; `in` and equals only look at scalars', () => {
    fc.assert(
      fc.property(jsonValue({ maxDepth: 3 }), matcher, purpose, whenArb, context, (value, m, p, when, ctx) => {
        const r = matchValue(value, m);
        expect(typeof r).toBe('boolean');
        if (typeof m === 'string' && (value === null || typeof value === 'object')) expect(r).toBe(false);
        const rule: FakeRule = { id: 'x', purpose: p, when, respond: { text: 't' } };
        expect(typeof ruleMatches(rule, p, ctx)).toBe('boolean');
        expect(ruleMatches(rule, PURPOSES.find((q) => q !== p) as string, ctx)).toBe(false);
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('a path that does not resolve never matches, whatever the matcher (including notContains)', () => {
    fc.assert(
      fc.property(matcher, purpose, (m, p) => {
        const rule: FakeRule = { id: 'x', purpose: p, when: { 'missing.path': m }, respond: { text: 't' } };
        expect(ruleMatches(rule, p, { other: 1 })).toBe(false);
      }),
      params(),
    );
  });

  it('first match wins: the answer comes from the first matching rule, is deterministic, and ignores rules after it', async () => {
    await fc.assert(
      fc.asyncProperty(rulesArb, purpose, contextArb, async (rules, p, ctx) => {
        const first = rules.findIndex((r) => ruleMatches(r, p, ctx));
        const models = createFakeModels({ rules: [{ rules }] });
        const before = JSON.stringify(ctx);
        let outcome: { id?: string | undefined; error?: string | undefined };
        try {
          await models[p].generate(request(p, ctx));
          outcome = { id: models.calls[0]?.ruleId };
        } catch (e) {
          expect(e instanceof AiBddError, String(e)).toBe(true);
          outcome = { error: (e as AiBddError).code };
        }
        expect(JSON.stringify(ctx)).toBe(before);
        if (first < 0) expect(outcome).toEqual({ error: 'MODEL_NO_RULE' });
        else if (outcome.error === undefined) expect(outcome.id).toBe(`r${first}`);
        else expect(outcome.error).toBe('MODEL_NO_RULE'); // the winning script could not resolve its target in context.nodes

        // appending rules never changes the winner; prepending a rule that cannot match does not either
        const extra = createFakeModels({ rules: [{ rules: [{ id: 'never', purpose: 'act', when: { 'no.such': 'x' }, respond: { text: 'n' } }, ...rules, { id: 'tail', purpose: p, respond: { text: 'tail' } }] }] });
        let tail: string | undefined;
        try {
          await extra[p].generate(request(p, ctx));
          tail = extra.calls[0]?.ruleId;
        } catch {
          tail = undefined;
        }
        if (first >= 0 && outcome.error === undefined) expect(tail).toBe(`r${first}`);
        if (first < 0) expect(tail === 'tail' || tail === undefined).toBe(true);
      }),
      params({ scale: 0.7 }),
    );
  });

  it('swapping two rules that both match swaps the winner (order is the only tie-breaker)', async () => {
    await fc.assert(
      fc.asyncProperty(respondArb, respondArb, async (a, b) => {
        const ra: FakeRule = { id: 'a', purpose: 'judge', respond: a };
        const rb: FakeRule = { id: 'b', purpose: 'judge', respond: b };
        const winner = async (rules: FakeRule[]): Promise<string | undefined> => {
          const m = createFakeModels({ rules: [{ rules }] });
          try {
            await m.judge.generate(request('judge', { turn: 0, nodes: [] }));
          } catch {
            return m.calls[0]?.ruleId ?? 'error';
          }
          return m.calls[0]?.ruleId;
        };
        const w1 = await winner([ra, rb]);
        const w2 = await winner([rb, ra]);
        // a script that cannot resolve its target throws before it is logged; skip those
        if (w1 !== 'error' && w2 !== 'error' && w1 !== undefined && w2 !== undefined) {
          expect(w1).toBe('a');
          expect(w2).toBe('b');
        }
      }),
      params(),
    );
  });

  it('produce() never fails with anything but MODEL_NO_RULE, whatever turn, attempt, sample and node data it is given', () => {
    const odd = fc.oneof(fc.integer({ min: -5, max: 10 }), fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 1.5, -0.5), fc.string({ maxLength: 3 }), fc.constant(null), fc.boolean(), jsonValue({ maxDepth: 1 }));
    fc.assert(
      fc.property(respondArb, fc.record({ turn: odd, attempt: odd, sample: odd, nodes: jsonValue({ maxDepth: 3 }) }, { requiredKeys: [] }), (respond, ctx) => {
        const rule: FakeRule = { id: 'r', purpose: 'act', respond };
        try {
          const out = produce(respond, { purpose: 'act', context: ctx as unknown as JsonObject, rule });
          expect(Array.isArray(out.toolCalls)).toBe(true);
          for (const call of out.toolCalls) {
            expect(call.id).toMatch(/^call_[0-9a-f]{12}$/);
            expect(typeof call.name).toBe('string');
          }
          const again = produce(respond, { purpose: 'act', context: ctx as unknown as JsonObject, rule });
          expect(again).toEqual(out);
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'MODEL_NO_RULE', String(e)).toBe(true);
        }
      }),
      params({ scale: 2 }),
    );
  });
});

describe('fuzz: fake model rule files', () => {
  it('validateFakeRuleFile accepts or throws CONFIG_INVALID, for arbitrary JSON and for rule files with one field mutated', () => {
    const valid = rulesArb.map((rules) => ({ rules }));
    const mutated = fc.tuple(valid, fc.constantFrom('id', 'purpose', 'when', 'respond', 'extra'), jsonValue({ maxDepth: 2, maxKeys: 3 })).map(([file, key, value]) => ({ rules: file.rules.map((r, i) => (i === 0 ? { ...r, [key]: value } : r)) }));
    fc.assert(
      fc.property(fc.oneof(jsonValue({ maxDepth: 4, maxKeys: 5 }), mutated, valid, hostileString().map((s) => s as JsonValue)), (input) => {
        try {
          const file = validateFakeRuleFile(input);
          expect(Array.isArray(file.rules)).toBe(true);
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'CONFIG_INVALID', String(e)).toBe(true);
        }
        assertPrototypeClean();
      }),
      params(),
    );
  });

  it('a generated valid rule file is accepted unchanged', () => {
    fc.assert(
      fc.property(rulesArb, (rules) => {
        expect(validateFakeRuleFile({ rules }).rules).toEqual(rules);
      }),
      params(),
    );
  });
});
