import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocPlan, ResolvedConfig } from '../../src/contracts/index.ts';
import { parseDocPlan } from '../../src/plan/schema.ts';
import { META, billingDoc, downgradeDraft, firstSectionId, mapOf, result, upgradeDraft } from './fixtures.ts';

/** Directory listings can come back in any order, and a failing read can reject with something that is not an Error. */
const hooks = vi.hoisted(() => ({ order: 'native' as 'native' | 'reverse' | 'scrambled', rejectReadFile: false }));

function reorder<T extends { name?: string } | string>(entries: T[]): T[] {
  const name = (e: T): string => (typeof e === 'string' ? e : (e.name ?? ''));
  const weight = (e: T): number => [...name(e)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_003, 7);
  if (hooks.order === 'reverse') return [...entries].reverse();
  if (hooks.order === 'scrambled') return [...entries].sort((a, b) => weight(a) - weight(b));
  return entries;
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) =>
      reorder((actual.readdirSync as (...a: unknown[]) => unknown[])(...args) as never[])) as unknown as typeof actual.readdirSync,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) =>
      reorder((await (actual.readdir as (...a: unknown[]) => Promise<unknown[]>)(...args)) as never[])) as unknown as typeof actual.readdir,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (hooks.rejectReadFile) throw undefined;
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof actual.readFile,
  };
});

const { createPlanStore, createPlanner, loadPlansSync, planPathFor } = await import('../../src/plan/index.ts');

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
  dir = mkdtempSync(join(tmpdir(), 'ai-bdd-plan-mut-'));
  hooks.order = 'native';
  hooks.rejectReadFile = false;
});
afterEach(() => {
  hooks.order = 'native';
  hooks.rejectReadFile = false;
  rmSync(dir, { recursive: true, force: true });
});

async function catchError(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to fail');
}

describe('planPathFor', () => {
  it('accepts names that merely start or end with dots or blanks, or contain a colon after the first character', () => {
    for (const ok of ['.hidden/notes.md', 'v1./x.md', 'dir/trailing.', ' lead/x.md', 'trail /x.md', 'notes/a:b.md', 'ab:c.md']) {
      expect(planPathFor('/p/plans', ok)).toBe(`/p/plans/${ok}.plan.json`);
    }
  });

  it('rejects an empty segment, dots-and-blanks segments, drive prefixes and absolute paths with a POLICY_DENIED naming the uri', () => {
    for (const bad of ['', '/abs.md', 'a//b.md', 'a/ /b.md', 'a/. ./b.md', 'C:x.md', 'c:/x.md', 'a\\b.md', 'a\0b.md']) {
      expect(() => planPathFor('/p/plans', bad), JSON.stringify(bad)).toThrowError(
        expect.objectContaining({
          name: 'AiBddError',
          code: 'POLICY_DENIED',
          message: `unsafe docUri for plan path: ${JSON.stringify(bad)}`,
          details: { docUri: bad },
        }),
      );
    }
  });

  it('refuses a target that is not strictly below the plan directory', () => {
    // The containment test is prefix based (`root + sep`): the file system root has no strictly-below prefix.
    expect(() => planPathFor('/', 'a.md')).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED', message: 'docUri escapes the plan directory: "a.md"', details: { docUri: 'a.md' } }),
    );
  });
});

describe('read-only store', () => {
  it('names the denied operation in the message', async () => {
    const ro = createPlanStore({ dir, readOnly: true });
    expect(await catchError(() => ro.save(samplePlan()))).toMatchObject({ code: 'POLICY_DENIED', message: 'plan store is read-only; cannot save' });
    expect(await catchError(() => ro.remove('docs/billing.md'))).toMatchObject({ code: 'POLICY_DENIED', message: 'plan store is read-only; cannot remove' });
  });
});

describe('save', () => {
  it('refuses an invalid plan with the schema message and the docUri, and writes nothing', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    const bad = { ...samplePlan(), features: 'nope' } as unknown as DocPlan;
    const parsed = parseDocPlan(bad);
    if (parsed.ok) throw new Error('fixture must be invalid');
    const err = await catchError(() => store.save(bad));
    expect(err).toMatchObject({ code: 'PLAN_CORRUPT', message: `refusing to write ${parsed.message}`, details: { docUri: 'docs/billing.md' } });
    expect(existsSync(join(dir, 'docs'))).toBe(false);
  });
});

describe('corrupt files', () => {
  function write(content: string, docUri = 'docs/billing.md'): string {
    const file = planPathFor(dir, docUri);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  it('invalid JSON: PLAN_CORRUPT naming the file, with the parser error as cause', async () => {
    const file = write('{ not json');
    const store = createPlanStore({ dir, readOnly: false });
    for (const err of [await catchError(() => store.load('docs/billing.md')), await catchError(() => loadPlansSync(dir))]) {
      expect(err).toMatchObject({ code: 'PLAN_CORRUPT', message: `plan file is not valid JSON: ${file}`, details: { file } });
      expect((err as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('unsupported schemaVersion: message shows the version as JSON and the file', async () => {
    const file = write(JSON.stringify({ ...samplePlan(), schemaVersion: 2 }));
    const store = createPlanStore({ dir, readOnly: false });
    expect(await catchError(() => store.load('docs/billing.md'))).toMatchObject({
      code: 'PLAN_SCHEMA_UNSUPPORTED',
      message: `unsupported plan schemaVersion 2 in ${file}`,
      details: { file },
    });
    write(JSON.stringify({ ...samplePlan(), schemaVersion: '1' }));
    expect(await catchError(() => loadPlansSync(dir))).toMatchObject({
      code: 'PLAN_SCHEMA_UNSUPPORTED',
      message: `unsupported plan schemaVersion "1" in ${file}`,
      details: { file },
    });
  });

  it('schema violation: the schema message followed by the file in brackets', async () => {
    const broken = { ...samplePlan(), features: 'nope' };
    const file = write(JSON.stringify(broken));
    const parsed = parseDocPlan(broken);
    if (parsed.ok) throw new Error('fixture must be invalid');
    const store = createPlanStore({ dir, readOnly: false });
    for (const err of [await catchError(() => store.load('docs/billing.md')), await catchError(() => loadPlansSync(dir))]) {
      expect(err).toMatchObject({ code: 'PLAN_CORRUPT', message: `${parsed.message} (${file})`, details: { file } });
    }
  });

  it('docUri that does not match the file path: PLAN_CORRUPT naming both', async () => {
    const file = write(JSON.stringify(samplePlan('docs/else.md')));
    const store = createPlanStore({ dir, readOnly: false });
    for (const err of [await catchError(() => store.load('docs/billing.md')), await catchError(() => loadPlansSync(dir)), await catchError(() => store.loadAll())]) {
      expect(err).toMatchObject({ code: 'PLAN_CORRUPT', message: `plan docUri "docs/else.md" does not match its path (${file})`, details: { file } });
    }
  });
});

describe('read failures', () => {
  it('a rejection that is not an error object is rethrown as it is, not mistaken for a missing file', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    await store.save(samplePlan());
    hooks.rejectReadFile = true;
    await expect(store.load('docs/billing.md')).rejects.toBeUndefined();
  });
});

describe('listing order', () => {
  const uris: string[] = [];
  for (let i = 0; i < 70; i += 1) uris.push(`d${(i * 7) % 5}/f${(i * 37) % 70}${i % 3 === 0 ? '-x' : ''}.md`);
  uris.push('a.md', 'a-b.md', 'a/b.md');
  const expected = [...uris].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  it.each(['native', 'reverse', 'scrambled'] as const)('plans come back in code-unit docUri order when the file system lists entries %s', async (order) => {
    const store = createPlanStore({ dir, readOnly: false });
    const template = samplePlan();
    for (const uri of uris) {
      const file = planPathFor(dir, uri);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...template, docUri: uri }));
    }
    hooks.order = order;
    expect(store.loadAllSync().map((p) => p.docUri)).toEqual(expected);
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(expected);
  });
});
