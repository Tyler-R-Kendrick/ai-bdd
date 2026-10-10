import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocPlan, JsonValue, ResolvedConfig } from '../../src/contracts/index.ts';
import { DocPlanSchema, createPlanStore, createPlanner, loadPlansSync, planPathFor } from '../../src/plan/index.ts';
import { stableJson } from '../../src/util/index.ts';
import { META, billingDoc, downgradeDraft, firstSectionId, mapOf, result, upgradeDraft } from './fixtures.ts';

const RUNS = Number(process.env['FC_RUNS'] ?? 200);
const planner = createPlanner({} as ResolvedConfig);

function samplePlan(docUri = 'docs/billing.md'): DocPlan {
  const doc = billingDoc();
  const plan = planner.merge(
    doc,
    null,
    mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)]), result(firstSectionId(doc, 1), [downgradeDraft(doc)])),
    META,
  ).plan;
  return { ...plan, docUri };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-bdd-plan-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const asJson = (p: DocPlan): JsonValue => p as unknown as JsonValue;

describe('R-PL4: plan files are deterministic and path-safe', () => {
  it('R-PL4: save writes ${dir}/${docUri}.plan.json as stableJson (sorted keys, LF, trailing newline, no timestamps)', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    const plan = samplePlan();
    await store.save(plan);
    const text = readFileSync(join(dir, 'docs/billing.md.plan.json'), 'utf8');
    expect(text).toBe(stableJson(asJson(plan)));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys).toEqual([...keys].sort());
  });

  it('R-PL4: load round-trips, returns null for a missing plan, and leaves no temp files behind', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    expect(await store.load('docs/none.md')).toBeNull();
    const plan = samplePlan();
    await store.save(plan);
    expect(await store.load('docs/billing.md')).toEqual(plan);
    expect(readdirSync(join(dir, 'docs'))).toEqual(['billing.md.plan.json']);
    await store.save(plan);
    expect(readFileSync(join(dir, 'docs/billing.md.plan.json'), 'utf8')).toBe(stableJson(asJson(plan)));
  });

  it('R-PL4: loadAllSync and loadAll walk recursively and return plans sorted by path', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    for (const uri of ['z.md', 'docs/b.md', 'docs/a.md', 'docs/deep/c.md', 'a.md']) await store.save(samplePlan(uri));
    writeFileSync(join(dir, 'README.txt'), 'ignored');
    const sync = store.loadAllSync().map((p) => p.docUri);
    expect(sync).toEqual(['a.md', 'docs/a.md', 'docs/b.md', 'docs/deep/c.md', 'z.md']);
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(sync);
    expect(loadPlansSync(dir).map((p) => p.docUri)).toEqual(sync);
  });

  it('R-PL4: loading a missing plan directory yields no plans', () => {
    expect(loadPlansSync(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('R-PL4: docUri that is absolute, contains .., or contains a backslash is rejected with POLICY_DENIED (load, save, remove)', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    for (const bad of ['/etc/passwd', '../x.md', 'a/../../x.md', 'a\\b.md', 'C:/x.md', 'a/..', '', 'a\0b.md']) {
      await expect(store.load(bad)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.save({ ...samplePlan(), docUri: bad })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.remove(bad)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('R-PL4: readOnly store never writes or removes', async () => {
    const rw = createPlanStore({ dir, readOnly: false });
    await rw.save(samplePlan());
    const ro = createPlanStore({ dir, readOnly: true });
    await expect(ro.save(samplePlan('docs/other.md'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(ro.remove('docs/billing.md')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(readdirSync(join(dir, 'docs'))).toEqual(['billing.md.plan.json']);
    expect((await ro.load('docs/billing.md'))?.docUri).toBe('docs/billing.md');
  });

  it('R-PL4: remove deletes the plan file and tolerates a missing one', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    await store.save(samplePlan());
    await store.remove('docs/billing.md');
    await store.remove('docs/billing.md');
    expect(await store.load('docs/billing.md')).toBeNull();
  });

  it('R-PL4: corrupt files raise PLAN_CORRUPT (bad JSON, schema violation, mismatched docUri) and unknown versions PLAN_SCHEMA_UNSUPPORTED', async () => {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const file = join(dir, 'docs/billing.md.plan.json');
    const good = samplePlan();
    writeFileSync(file, '{ not json');
    expect(() => loadPlansSync(dir)).toThrowError(expect.objectContaining({ code: 'PLAN_CORRUPT' }));
    writeFileSync(file, JSON.stringify({ ...good, features: 'nope' }));
    expect(() => loadPlansSync(dir)).toThrowError(expect.objectContaining({ code: 'PLAN_CORRUPT' }));
    writeFileSync(file, JSON.stringify({ ...good, docUri: 'docs/else.md' }));
    expect(() => loadPlansSync(dir)).toThrowError(expect.objectContaining({ code: 'PLAN_CORRUPT' }));
    writeFileSync(file, JSON.stringify({ ...good, unexpected: 1 }));
    expect(() => loadPlansSync(dir)).toThrowError(expect.objectContaining({ code: 'PLAN_CORRUPT' }));
    writeFileSync(file, JSON.stringify({ ...good, schemaVersion: 2 }));
    expect(() => loadPlansSync(dir)).toThrowError(expect.objectContaining({ code: 'PLAN_SCHEMA_UNSUPPORTED' }));
    const store = createPlanStore({ dir, readOnly: false });
    await expect(store.load('docs/billing.md')).rejects.toMatchObject({ code: 'PLAN_SCHEMA_UNSUPPORTED' });
    writeFileSync(file, 'null');
    await expect(store.load('docs/billing.md')).rejects.toMatchObject({ code: 'PLAN_CORRUPT' });
  });

  it('R-PL4: save refuses to write a plan that fails schema validation', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    const bad = { ...samplePlan(), schemaVersion: 2 } as unknown as DocPlan;
    await expect(store.save(bad)).rejects.toMatchObject({ code: 'PLAN_CORRUPT' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('R-PL4: the zod schema accepts every optional field of the contract type (story, fixture, nature, driver, pinned, failed ...)', () => {
    const plan = samplePlan();
    const f = plan.features[0];
    const s = f?.scenarios[0];
    const st = s?.steps[2];
    if (f === undefined || s === undefined || st === undefined) throw new Error('fixture');
    f.story = { asA: 'customer', iWant: 'to upgrade', soThat: 'I get Pro' };
    f.description = 'desc';
    f.pinned = true;
    s.driver = 'fake';
    s.startUrl = '/billing';
    st.nature = 'subjective';
    const given = s.steps[0];
    if (given === undefined) throw new Error('fixture');
    given.requiresState = true;
    given.fixture = { name: 'seedAccount', args: { plan: 'pro', unpaid: 2, nested: { a: [1, null, true] } } };
    given.params = { plan: 'Pro' };
    const sec = plan.sections[0];
    if (sec === undefined) throw new Error('fixture');
    sec.failed = true;
    expect(DocPlanSchema.parse(plan)).toEqual(plan);
  });

  it('R-PL4: a file name that merely contains two dots is a safe docUri (F-10)', () => {
    expect(planPathFor('/p/plans', 'docs/release..notes.md')).toBe('/p/plans/docs/release..notes.md.plan.json');
    expect(planPathFor('/p/plans', 'a..b.md')).toBe('/p/plans/a..b.md.plan.json');
    for (const bad of ['a/../b.md', '../b.md', 'a/..', 'a//b.md', './b.md', '..../b.md']) {
      expect(() => planPathFor('/p/plans', bad)).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    }
  });

  it('R-PL4: planPathFor stays inside the plan dir', () => {
    expect(planPathFor('/p/plans', 'docs/a.md')).toBe('/p/plans/docs/a.md.plan.json');
  });

  it('R-PL4: property: arbitrary unsafe docUris are rejected; safe ones resolve inside the directory', () => {
    const seg = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), (parts) => {
        const uri = `${parts.join('/')}.md`;
        expect(planPathFor('/p/plans', uri).startsWith('/p/plans/')).toBe(true);
      }),
      { numRuns: RUNS },
    );
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('..', '../', '/..', '\\', '/'), fc.string(), (a, evil, b) => {
        const uri = evil === '/' ? `/${a}${b}` : `${a}${evil}${b}`;
        const dotSegment = uri.split('/').some((seg) => seg === '' || /^[.\s]+$/.test(seg));
        if (!(uri.startsWith('/') || dotSegment || uri.includes('\\'))) return;
        expect(() => planPathFor('/p/plans', uri)).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
      }),
      { numRuns: RUNS },
    );
  });

  it('R-PL4: property: stableJson output is byte-identical across runs and independent of key insertion order', () => {
    const plan = samplePlan();
    const reverse = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverse);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, reverse(x)]));
      }
      return v;
    };
    const base = stableJson(asJson(plan));
    fc.assert(
      fc.property(fc.boolean(), () => {
        expect(stableJson(asJson(plan))).toBe(base);
        expect(stableJson(reverse(plan) as JsonValue)).toBe(base);
      }),
      { numRuns: RUNS },
    );
  });
});
