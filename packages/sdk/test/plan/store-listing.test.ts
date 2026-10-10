import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocPlan, ResolvedConfig } from '../../src/contracts/index.ts';
import { META, billingDoc, downgradeDraft, firstSectionId, mapOf, result, upgradeDraft } from './fixtures.ts';

/** Directory entries come back in whatever order the file system likes; the store must not depend on it. */
const fsOrder = vi.hoisted(() => ({ reverse: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const entries = (actual.readdirSync as (...a: unknown[]) => unknown[])(...args);
      return fsOrder.reverse ? [...entries].reverse() : entries;
    }) as typeof actual.readdirSync,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const entries = (await (actual.readdir as (...a: unknown[]) => Promise<unknown[]>)(...args));
      return fsOrder.reverse ? [...entries].reverse() : entries;
    }) as typeof actual.readdir,
  };
});

const { createPlanStore, createPlanner, loadPlansSync } = await import('../../src/plan/index.ts');

const planner = createPlanner({} as ResolvedConfig);
function samplePlan(docUri: string): DocPlan {
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
  dir = mkdtempSync(join(tmpdir(), 'ai-bdd-plan-list-'));
  fsOrder.reverse = false;
});
afterEach(() => {
  fsOrder.reverse = false;
  rmSync(dir, { recursive: true, force: true });
});

describe('plan store listing', () => {
  const URIS = ['docs/a.md', 'docs/a/b.md', 'docs/a.md.bak/c.md', 'docs/B.md', 'z.md', 'docs/deep/d.md', 'a.md'];
  // plain code-unit order of the full posix file path: "B" < "a", "a.md.bak/..." < "a.md.plan.json" (b < p) < "a/b.md..." ("." < "/")
  const EXPECTED = ['a.md', 'docs/B.md', 'docs/a.md.bak/c.md', 'docs/a.md', 'docs/a/b.md', 'docs/deep/d.md', 'z.md'];

  it.each([
    ['in file system order', false],
    ['when the file system lists entries in reverse order', true],
  ])('R-PL4: plans are returned in code-unit path order %s, sync and async alike', async (_name, reverse) => {
    const store = createPlanStore({ dir, readOnly: false });
    for (const uri of URIS) await store.save(samplePlan(uri));
    fsOrder.reverse = reverse;
    expect(store.loadAllSync().map((p) => p.docUri)).toEqual(EXPECTED);
    expect(loadPlansSync(dir).map((p) => p.docUri)).toEqual(EXPECTED);
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(EXPECTED);
  });

  it('R-PL4: only *.plan.json regular files are plans; other files and directories named like plans are ignored', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    await store.save(samplePlan('docs/a.md'));
    writeFileSync(join(dir, 'docs', 'notes.json'), '{}');
    writeFileSync(join(dir, 'docs', 'a.md.plan.json.bak'), 'not a plan');
    mkdirSync(join(dir, 'docs', 'looks-like.plan.json'));
    expect(store.loadAllSync().map((p) => p.docUri)).toEqual(['docs/a.md']);
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(['docs/a.md']);
  });

  it('R-PL4: a missing plan directory yields no plans, sync and async', async () => {
    const store = createPlanStore({ dir: join(dir, 'never-created'), readOnly: false });
    expect(store.loadAllSync()).toEqual([]);
    expect(await store.loadAll()).toEqual([]);
    expect(await store.load('docs/a.md')).toBeNull();
  });

  it('R-PL4: a plan directory that is really a file is an error, not an empty list', async () => {
    const asFile = join(dir, 'plans');
    writeFileSync(asFile, 'i am a file');
    const store = createPlanStore({ dir: asFile, readOnly: false });
    expect(() => store.loadAllSync()).toThrow(/ENOTDIR/);
    await expect(store.loadAll()).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('R-PL4: an unreadable plan location other than "missing" is rethrown by load', async () => {
    const store = createPlanStore({ dir, readOnly: false });
    mkdirSync(join(dir, 'docs', 'a.md.plan.json'), { recursive: true });
    await expect(store.load('docs/a.md')).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
