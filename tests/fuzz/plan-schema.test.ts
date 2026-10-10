import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { createPlanStore, createPlanner, loadPlansSync, stableJson } from '@ai-bdd/sdk';
import type { DocPlan, JsonValue, ResolvedConfig } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { assertPrototypeClean, hostileKey, hostileString, jsonEqual, jsonValue, params } from './helpers.ts';
import { META, buildDoc, feature, ref, result, scenario, step } from '../../packages/sdk/test/plan/fixtures.ts';
import { parseDocPlan } from '../../packages/sdk/src/plan/schema.ts';
import { planPathFor } from '../../packages/sdk/src/plan/store.ts';

const planner = createPlanner({} as ResolvedConfig);

/** A plan that exercises every optional field of the schema. */
function richPlan(): DocPlan {
  const doc = buildDoc('docs/rich.md', [
    { title: 'Alpha', paras: ['Alpha paragraph one is here.', 'Alpha paragraph two is here.'] },
    { title: 'Beta', paras: ['Beta paragraph one is here.'] },
  ]);
  const r1 = ref(doc, 'Alpha paragraph one is here.', 'source', 'Alpha paragraph one');
  const r2 = ref(doc, 'Alpha paragraph two is here.');
  const withFixture = { ...step('given', 'a seeded account', [r2]), fixture: { name: 'seed', args: { plan: 'pro', n: 3 as unknown as string } }, requiresState: true };
  const withNature = { ...step('then', 'it looks right', [r1]), nature: 'subjective' as const, params: { who: 'me' } };
  const f = { ...feature('Alpha feature', [r1], [scenario('Alpha scenario', [withFixture, step('when', 'click it', [r1]), withNature], [r1], ['@fuzzy', 'web'])]), story: { asA: 'user', iWant: 'it', soThat: 'works' }, description: 'desc' };
  const merged = planner.merge(doc, null, new Map([[doc.sections[0]?.id ?? '', result(doc.sections[0]?.id ?? '', [f], [{ chunkId: r2.chunkId, reason: 'n/a' }])]]), META).plan;
  const pinned = planner.review(planner.review(merged, merged.features[0]?.id ?? '', 'pin'), merged.features[0]?.scenarios[0]?.id ?? '', 'reject');
  // sections[0].failed and scenario driver / startUrl are optional fields too
  return {
    ...pinned,
    sections: pinned.sections.map((s, i) => (i === 1 ? { ...s, failed: true } : s)),
    features: pinned.features.map((x) => ({ ...x, scenarios: x.scenarios.map((s) => ({ ...s, driver: 'web', startUrl: '/start' })) })),
  };
}

const PLAN = richPlan();
const PLAN_JSON = JSON.parse(stableJson(PLAN as unknown as JsonValue)) as JsonValue;

/** Every location in the plan, with whether the key is optional in the schema. */
const OPTIONAL = new Set(['quote', 'failed', 'nature', 'requiresState', 'fixture', 'driver', 'startUrl', 'story', 'description', 'pinned', 'soThat']);
interface Loc { path: (string | number)[]; value: JsonValue; optional: boolean }
function locations(value: JsonValue, path: (string | number)[] = [], out: Loc[] = []): Loc[] {
  out.push({ path, value, optional: typeof path[path.length - 1] === 'string' && OPTIONAL.has(path[path.length - 1] as string) });
  if (Array.isArray(value)) value.forEach((v, i) => locations(v, [...path, i], out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) locations(v, [...path, k], out);
  return out;
}
const LOCS = locations(PLAN_JSON);

function clone(v: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(v)) as JsonValue;
}
function at(root: JsonValue, path: (string | number)[]): { parent: JsonValue; key: string | number } {
  let cur = root;
  for (const k of path.slice(0, -1)) cur = (cur as Record<string | number, JsonValue>)[k] as JsonValue;
  return { parent: cur, key: path[path.length - 1] as string | number };
}

/** Free-form data that may legitimately take any JSON shape (fixture args). Mutating inside them is not a schema violation. */
const inFreeForm = (path: (string | number)[]): boolean => path.includes('args') || (path.includes('params') && path.length > path.indexOf('params') + 1);

function expectRejected(candidate: JsonValue): void {
  const r = parseDocPlan(candidate);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toMatch(/^invalid plan/);
    expect(r.message.length).toBeLessThan(400);
  }
}

describe('fuzz: plan schema', () => {
  it('the generated rich plan is valid and covers the optional fields (guard for the mutation properties below)', () => {
    expect(parseDocPlan(PLAN_JSON).ok).toBe(true);
    const keys = new Set(LOCS.map((l) => String(l.path[l.path.length - 1])));
    for (const k of OPTIONAL) expect(keys.has(k), k).toBe(true);
  });

  it('a valid plan round-trips through stableJson and parse unchanged', () => {
    const r = parseDocPlan(PLAN_JSON);
    expect(r.ok && stableJson(r.plan as unknown as JsonValue)).toBe(stableJson(PLAN_JSON));
  });

  it('deleting a required field is rejected with a located error; deleting an optional one is accepted', () => {
    const candidates = LOCS.filter((l) => l.path.length > 0 && typeof l.path[l.path.length - 1] === 'string' && !inFreeForm(l.path));
    fc.assert(
      fc.property(fc.constantFrom(...candidates), (loc) => {
        const doc = clone(PLAN_JSON);
        const { parent, key } = at(doc, loc.path);
        delete (parent as Record<string, JsonValue>)[key as string];
        if (loc.optional) expect(parseDocPlan(doc).ok, loc.path.join('.')).toBe(true);
        else {
          expectRejected(doc);
          const r = parseDocPlan(doc);
          expect(!r.ok && r.message.includes(' at ')).toBe(true);
        }
      }),
      params(),
    );
  });

  it('flipping a value to another JSON type is rejected', () => {
    const typeOf = (v: JsonValue): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const replacements: JsonValue[] = [null, true, 0, -1, 1.5, '', 'x', [], {}, [1], { a: 1 }];
    const candidates = LOCS.filter((l) => l.path.length > 0 && !inFreeForm(l.path));
    fc.assert(
      fc.property(fc.constantFrom(...candidates), fc.constantFrom(...replacements), (loc, replacement) => {
        // string -> another string, or number -> another number are value (not type) changes and may stay valid
        fc.pre(typeOf(loc.value) !== typeOf(replacement));
        // a schema field typed as a string enum / literal never accepts another type; a free JsonValue does
        const doc = clone(PLAN_JSON);
        const { parent, key } = at(doc, loc.path);
        (parent as Record<string | number, JsonValue>)[key] = replacement;
        expectRejected(doc);
      }),
      params(),
    );
  });

  it('adding an unknown key anywhere (including duplicated copies of existing fields under a new name) is rejected', () => {
    // `params` (record of strings) and `args` (record of JSON) are open maps: any key is legal there
    const objects = LOCS.filter((l) => l.value !== null && typeof l.value === 'object' && !Array.isArray(l.value) && !inFreeForm(l.path) && !['params', 'args'].includes(String(l.path[l.path.length - 1])));
    fc.assert(
      fc.property(fc.constantFrom(...objects), hostileKey, fc.constantFrom<JsonValue>(1, 'x', null, {}, []), (loc, key, value) => {
        fc.pre(!Object.hasOwn(loc.value as object, key));
        const doc = clone(PLAN_JSON);
        let target = doc;
        for (const k of loc.path) target = (target as Record<string | number, JsonValue>)[k] as JsonValue;
        Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
        expectRejected(doc);
      }),
      params(),
    );
  });

  it('duplicating or dropping array elements keeps a valid plan valid (the schema checks shape, planner checks identity)', () => {
    const arrays = LOCS.filter((l) => Array.isArray(l.value) && (l.value as JsonValue[]).length > 0 && !inFreeForm(l.path));
    fc.assert(
      fc.property(fc.constantFrom(...arrays), fc.boolean(), (loc, drop) => {
        const doc = clone(PLAN_JSON);
        let target = doc as JsonValue[];
        for (const k of loc.path) target = (target as unknown as Record<string | number, JsonValue[]>)[k] as JsonValue[];
        if (drop) target.pop();
        else target.push(clone(target[0] as JsonValue));
        expect(parseDocPlan(doc).ok).toBe(true);
      }),
      params(),
    );
  });

  it('arbitrary JSON, deep and hostile, is rejected with a message and never throws or pollutes', () => {
    fc.assert(
      fc.property(fc.oneof(jsonValue({ maxDepth: 5 }), hostileString().map((s) => s as JsonValue), fc.constant(null as JsonValue)), (value) => {
        const r = parseDocPlan(value);
        if (r.ok) throw new Error('random JSON must not be a valid plan');
        expect(r.message).toMatch(/^invalid plan/);
        assertPrototypeClean();
      }),
      params(),
    );
    // an object that is a valid plan plus hostile extras, via JSON.parse so that own __proto__ keys survive
    const evil = JSON.parse(JSON.stringify({ ...(PLAN_JSON as object), extra: 1 }).replace('"extra"', '"__proto__"')) as JsonValue;
    expectRejected(evil);
    assertPrototypeClean();
  });

  it('fixture arguments of any JSON shape survive a save/load round trip', () => {
    // zod's record parsing drops an own "__proto__" key on purpose (anti-pollution), so argument names other than that are generated.
    fc.assert(
      fc.property(fc.array(fc.tuple(hostileKey.filter((k) => k !== '__proto__'), jsonValue({ maxDepth: 3, maxKeys: 3, protoKeys: false })), { maxLength: 4 }), (entries) => {
        const args = Object.fromEntries(entries) as { [k: string]: JsonValue };
        const plan = structuredClone(PLAN);
        const first = plan.features[0];
        const firstStep = first?.scenarios[0]?.steps[0];
        if (firstStep?.fixture === undefined) throw new Error('fixture missing from the rich plan');
        firstStep.fixture = { name: 'seed', args };
        const parsed = parseDocPlan(JSON.parse(stableJson(plan as unknown as JsonValue)));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(jsonEqual(parsed.plan.features[0]?.scenarios[0]?.steps[0]?.fixture?.args, args)).toBe(true);
        assertPrototypeClean();
      }),
      params(),
    );
  });
});

describe('fuzz: plan store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bdd-fuzz-plans-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const planFile = join(dir, 'docs', 'rich.md.plan.json');

  it('corrupt plan files fail with PLAN_CORRUPT or PLAN_SCHEMA_UNSUPPORTED, never another error, from both loaders', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    mkdirSync(dirname(planFile), { recursive: true });
    const mutated = fc.oneof(
      hostileString({ maxLength: 200 }),
      jsonValue({ maxDepth: 4 }).map((v) => JSON.stringify(v)),
      fc.constantFrom(...LOCS.filter((l) => l.path.length > 0 && !inFreeForm(l.path))).map((loc) => {
        const doc = clone(PLAN_JSON);
        const { parent, key } = at(doc, loc.path);
        if (loc.optional) (parent as Record<string | number, JsonValue>)[key] = 12;
        else delete (parent as Record<string, JsonValue>)[key as string];
        return JSON.stringify(doc);
      }),
      fc.constantFrom('', '{', 'null', '[]', '{"schemaVersion":2}', '{"schemaVersion":"1"}', JSON.stringify({ ...(PLAN_JSON as object), docUri: 'docs/other.md' })),
    );
    await fc.assert(
      fc.asyncProperty(mutated, async (text) => {
        writeFileSync(planFile, text);
        for (const load of [() => store.load('docs/rich.md'), () => store.loadAll(), () => Promise.resolve(loadPlansSync(dir))]) {
          try {
            await load();
          } catch (e) {
            expect(e instanceof AiBddError, String(e)).toBe(true);
            expect(['PLAN_CORRUPT', 'PLAN_SCHEMA_UNSUPPORTED']).toContain((e as AiBddError).code);
          }
        }
      }),
      params({ scale: 0.4 }),
    );
  });

  it('planPathFor never resolves outside the plan directory for hostile document uris', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 60 }), fc.array(fc.constantFrom('..', '.', 'a', '', '...', ' .. ', 'b/c', '%2e%2e', '..\\', 'C:', '~'), { maxLength: 6 }).map((p) => p.join('/'))), (uri) => {
        try {
          const file = planPathFor(dir, uri);
          expect(file.startsWith(`${dir}/`) || file.startsWith(`${dir}\\`)).toBe(true);
          expect(file.slice(dir.length)).not.toMatch(/(^|[\\/])\.\.([\\/]|$)/);
        } catch (e) {
          expect(e instanceof AiBddError && e.code === 'POLICY_DENIED', String(e)).toBe(true);
        }
      }),
      params(),
    );
  });
});
