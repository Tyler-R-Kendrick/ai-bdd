/**
 * Store contract kits for `PlanStore`, `RecordingStore` and `EvidenceStore`, shared by every implementation of
 * those interfaces. Like the driver conformance kit they are vitest-compatible: call `runPlanStoreContract(...)`,
 * `runRecordingStoreContract(...)` or `runEvidenceStoreContract(...)` at module level of a test file; each declares
 * one `describe`. Every kit is parametrized by a factory that builds the store on a directory the kit owns (a fresh
 * temp directory per test), so another implementation (an object store, an in-memory store with a directory facade)
 * can run the same cases. `planStoreContractCases(...)` and friends return the cases as data, which is how the
 * self-test proves the kits fail for broken stores.
 *
 * What is specified, per store:
 *
 *   - round trip: what was saved is what is loaded (deep equality), every load is a fresh object, `save` never
 *     mutates its argument, a missing item loads as `null`, and reading never creates anything;
 *   - overwrite is atomic: while a writer alternates between two versions, no reader (`load`, `loadAll`,
 *     `loadAllSync`, `list`, or reading an artifact) ever sees a torn, empty or mixed state, and nothing but the
 *     items themselves is left in the directory afterwards;
 *   - files are canonical JSON (`stableJson`: sorted keys, two-space indent, LF, trailing newline), byte-identical
 *     when the same item is saved again or built with another key order;
 *   - listing is sorted and independent of the order items were saved in; `remove` is idempotent and removes only
 *     its item;
 *   - read-only stores refuse every write with the documented code and leave every byte as it was;
 *   - hostile ids (`../`, absolute paths, NUL, backslashes, very long names, case collisions), a symlinked
 *     directory inside the store and a symlinked target file never make the store touch anything outside its own
 *     directory;
 *   - damaged files surface as the documented corruption code, never as a half-parsed item;
 *   - evidence: content addressing, redaction before hashing, a stable digest over the artifact list and
 *     tamper evidence through the verifier the caller passes in.
 *
 * Nothing depends on the wall clock: concurrency tests run a fixed number of rounds and interleave through the
 * event loop, they do not sleep.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AiBddError,
  ERROR_CODES,
  type ArtifactKind,
  type DocPlan,
  type ErrorCode,
  type EvidenceStore,
  type JsonValue,
  type PlanStore,
  type Redactor,
  type RecordingStore,
  type RecordingsMode,
  type ResolvedConfig,
  type ScenarioRecording,
  type VerifyRun,
} from '../../src/contracts/index.ts';
import { createPlanner } from '../../src/plan/index.ts';
import { sha256Hex, stableJson } from '../../src/util/index.ts';
import { META, billingDoc, downgradeDraft, firstSectionId, mapOf, result, upgradeDraft } from '../plan/fixtures.ts';

export interface StoreCase {
  name: string;
  run(): Promise<void>;
}

// ───────────────────────── file system helpers

interface Root {
  /** Temp directory that holds everything below. */
  root: string;
  /** The directory handed to the store factory. It exists and is empty. */
  store: string;
  /** A sibling directory the store must never write to, holding `keep.txt`. */
  outside: string;
}

/** Creates `root/store` (empty) and `root/outside` (with a decoy file), runs `fn`, removes everything. */
async function withRoot<T>(fn: (r: Root) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-bdd-contract-')));
  try {
    const store = join(root, 'store');
    const outside = join(root, 'outside');
    await mkdir(store);
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    return await fn({ root, store, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every entry below `dir` as `path|kind|digest`, sorted. Symlinks are listed, not followed. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (e.isSymbolicLink()) out.push(`${rel}|link|${await readlink(p)}`);
      else if (e.isDirectory()) {
        out.push(`${rel}|dir|`);
        await walk(p);
      } else out.push(`${rel}|file|${createHash('sha256').update(await readFile(p)).digest('hex')}`);
    }
  };
  await walk(dir);
  return out.sort();
}

/** Regular files below `dir`, relative, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  return (await snapshot(dir)).filter((e) => e.includes('|file|')).map((e) => e.split('|')[0] as string);
}

/** The one regular file a store holds after a single save: lets the kit damage it without knowing the layout. */
async function soleFile(store: string): Promise<string> {
  const files = await filesUnder(store);
  expect(files, 'after one save the store directory must hold exactly one file').toHaveLength(1);
  return join(store, files[0] as string);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function outcome<T>(p: Promise<T> | (() => Promise<T>)): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await (typeof p === 'function' ? p() : p) };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectCode(out: Outcome<unknown>, code: ErrorCode, what: string): AiBddError {
  if (out.ok) throw new Error(`${what}: expected AiBddError ${code}, but it resolved`);
  expect(out.error, `${what}: expected AiBddError ${code}, got ${String(out.error)}`).toBeInstanceOf(AiBddError);
  const err = out.error as AiBddError;
  expect(ERROR_CODES as readonly string[]).toContain(err.code);
  expect(err.code, `${what}: ${err.message}`).toBe(code);
  expect(err.retryable, `${what}: corruption and policy errors are not retryable`).toBe(false);
  return err;
}

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  return v;
}

const isCanonical = (text: string): boolean => text === stableJson(JSON.parse(text) as JsonValue);

/** Runs `rounds` rounds of two alternating writes while `readers` poll; returns how many reads were checked. */
async function raceWritesAgainstReads(opts: {
  write: (round: number) => Promise<unknown>;
  read: () => Promise<void>;
  rounds: number;
  readers: number;
}): Promise<number> {
  let writing = true;
  let reads = 0;
  let failure: { error: unknown } | undefined;
  const reader = async (): Promise<void> => {
    try {
      while (writing) {
        await opts.read();
        reads += 1;
        await yieldTurn();
      }
      await opts.read();
      reads += 1;
    } catch (error) {
      failure ??= { error };
      writing = false;
    }
  };
  const readers = Array.from({ length: opts.readers }, () => reader());
  try {
    for (let i = 0; i < opts.rounds && writing; i += 1) await opts.write(i);
  } finally {
    writing = false;
  }
  await Promise.all(readers);
  if (failure !== undefined) throw failure.error;
  return reads;
}

// ───────────────────────── plan store

const planner = createPlanner({} as ResolvedConfig);

/** A realistic plan (features, scenarios, steps, sources) for `docUri`. */
export function richPlan(docUri = 'docs/billing.md'): DocPlan {
  const doc = billingDoc();
  const plan = planner.merge(
    doc,
    null,
    mapOf(result(firstSectionId(doc, 0), [upgradeDraft(doc)]), result(firstSectionId(doc, 1), [downgradeDraft(doc)])),
    META,
  ).plan;
  return { ...plan, docUri };
}

/** A schema-valid plan whose size and identity vary: `tag` changes the bytes, `extra` makes the file big. */
export function sizedPlan(docUri: string, tag: string, extra = 0): DocPlan {
  return {
    schemaVersion: 1,
    docUri,
    docSha256: sha256Hex(`doc:${docUri}`),
    extractor: { modelId: `model-${tag}`, promptVersion: 'extract-v1' },
    sections: [],
    chunks: [],
    features: [],
    notTestable: [],
    rejected: [],
    uncovered: Array.from({ length: extra }, (_, i) => `${tag}-uncovered-chunk-${i}`),
  };
}

export type MakePlanStore = (dir: string, opts: { readOnly: boolean }) => PlanStore;

export interface PlanStoreContractOptions {
  /** The code a read-only store refuses writes with. Default `POLICY_DENIED`. */
  readOnlyCode?: ErrorCode;
}

/** Ids that would leave the store directory if they were used as paths. */
function escapingDocUris(outside: string): string[] {
  return [
    '../outside/escape',
    'a/../../outside/escape',
    'docs/../../outside/escape',
    join(outside, 'escape'),
    '/etc/passwd',
    'docs\\..\\..\\outside\\escape',
    '..\\outside\\escape',
    'C:/outside/escape',
    'a\0b',
    'a/..',
    '..',
  ];
}

export function planStoreContractCases(make: MakePlanStore, options: PlanStoreContractOptions = {}): StoreCase[] {
  const readOnlyCode = options.readOnlyCode ?? 'POLICY_DENIED';
  const cases: StoreCase[] = [];
  const add = (name: string, run: (r: Root) => Promise<void>): void => {
    cases.push({ name, run: () => withRoot(run) });
  };
  const rw = (r: Root): PlanStore => make(r.store, { readOnly: false });

  add('round trip: what is saved is what is loaded, as fresh objects, and the argument is not touched', async (r) => {
    const store = rw(r);
    const plan = richPlan();
    const frozen = deepFreeze(structuredClone(plan));
    await store.save(frozen);
    expect(frozen).toEqual(plan);
    const first = await store.load('docs/billing.md');
    expect(first).toEqual(plan);
    (first as DocPlan).extractor.modelId = 'mutated by the caller';
    (first as DocPlan).features.length = 0;
    expect(await store.load('docs/billing.md')).toEqual(plan);
    expect(await store.loadAll()).toEqual([plan]);
    expect(store.loadAllSync()).toEqual([plan]);
  });

  add('a missing plan loads as null, an empty or missing directory lists nothing, and reading creates nothing', async (r) => {
    await rm(r.store, { recursive: true });
    const before = await snapshot(r.root);
    const store = rw(r);
    expect(await store.load('docs/none.md')).toBeNull();
    expect(await store.loadAll()).toEqual([]);
    expect(store.loadAllSync()).toEqual([]);
    expect(await snapshot(r.root)).toEqual(before);
    await mkdir(r.store);
    expect(await store.load('docs/none.md')).toBeNull();
    expect(await store.loadAll()).toEqual([]);
    expect(await snapshot(r.store)).toEqual([]);
  });

  add('overwrite replaces the plan and leaves a single file', async (r) => {
    const store = rw(r);
    await store.save(sizedPlan('docs/a.md', 'one'));
    await store.save(sizedPlan('docs/a.md', 'two'));
    expect(await store.load('docs/a.md')).toEqual(sizedPlan('docs/a.md', 'two'));
    expect(await store.loadAll()).toEqual([sizedPlan('docs/a.md', 'two')]);
    expect(await filesUnder(r.store)).toHaveLength(1);
  });

  add('files are canonical JSON, byte-identical when saved again or built with another key order', async (r) => {
    const store = rw(r);
    const plan = richPlan();
    await store.save(plan);
    const file = await soleFile(r.store);
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(isCanonical(text)).toBe(true);
    expect(text).toBe(stableJson(plan as unknown as JsonValue));
    const bytes = await snapshot(r.store);
    await store.save(plan);
    expect(await snapshot(r.store)).toEqual(bytes);
    await store.save(reverseKeys(plan) as DocPlan);
    expect(await snapshot(r.store)).toEqual(bytes);
  });

  add('loadAll and loadAllSync are sorted by docUri, whatever order the plans were saved in', async (r) => {
    const uris = ['z.md', 'docs/b.md', 'docs/a.md', 'docs/deep/c.md', 'a.md', 'docs/a-b.md', 'docs-old/x.md', 'a', 'a-b', 'Zeta.md'];
    const expected = [...uris].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const store = rw(r);
    for (const uri of uris) await store.save(sizedPlan(uri, 'x'));
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(expected);
    expect(store.loadAllSync().map((p) => p.docUri)).toEqual(expected);
    await writeFile(join(r.store, 'README.txt'), 'not a plan');
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(expected);

    const other = join(r.root, 'store2');
    await mkdir(other);
    const store2 = make(other, { readOnly: false });
    for (const uri of [...uris].reverse()) await store2.save(sizedPlan(uri, 'x'));
    expect(await store2.loadAll()).toEqual(await store.loadAll());
  });

  add('names with spaces, unicode, dots and ampersands round trip and list back exactly', async (r) => {
    const store = rw(r);
    const uris = ['docs/ünï cödé & space.md', 'docs/release..notes.md', 'docs/日本語/ページ.md', "docs/it's.md", 'docs/a b/c d.md'];
    for (const uri of uris) await store.save(sizedPlan(uri, 'u'));
    for (const uri of uris) expect(await store.load(uri), uri).toEqual(sizedPlan(uri, 'u'));
    expect((await store.loadAll()).map((p) => p.docUri).sort()).toEqual([...uris].sort());
  });

  add('remove is idempotent, removes only its plan, and never fails for a plan that was never there', async (r) => {
    const store = rw(r);
    await store.remove('docs/never.md');
    await rm(r.store, { recursive: true });
    await store.remove('docs/never.md');
    await mkdir(r.store);
    await store.save(sizedPlan('docs/a.md', 'a'));
    await store.save(sizedPlan('docs/b.md', 'b'));
    await store.remove('docs/a.md');
    await store.remove('docs/a.md');
    expect(await store.load('docs/a.md')).toBeNull();
    expect(await store.load('docs/b.md')).toEqual(sizedPlan('docs/b.md', 'b'));
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(['docs/b.md']);
  });

  add('a read-only store reads, refuses every write with the documented code, and leaves every byte as it was', async (r) => {
    const writer = rw(r);
    await writer.save(sizedPlan('docs/a.md', 'a'));
    const before = await snapshot(r.root);
    const ro = make(r.store, { readOnly: true });
    expect(await ro.load('docs/a.md')).toEqual(sizedPlan('docs/a.md', 'a'));
    expect((await ro.loadAll()).map((p) => p.docUri)).toEqual(['docs/a.md']);
    expect(ro.loadAllSync().map((p) => p.docUri)).toEqual(['docs/a.md']);
    expectCode(await outcome(ro.save(sizedPlan('docs/b.md', 'b'))), readOnlyCode, 'save of a new plan');
    expectCode(await outcome(ro.save(sizedPlan('docs/a.md', 'changed'))), readOnlyCode, 'overwrite');
    expectCode(await outcome(ro.remove('docs/a.md')), readOnlyCode, 'remove');
    expectCode(await outcome(ro.remove('docs/missing.md')), readOnlyCode, 'remove of a missing plan');
    expect(await snapshot(r.root)).toEqual(before);
    await rm(r.store, { recursive: true });
    const gone = await snapshot(r.root);
    expectCode(await outcome(ro.save(sizedPlan('docs/b.md', 'b'))), readOnlyCode, 'save into a missing directory');
    expect(await snapshot(r.root)).toEqual(gone);
  });

  add('a plan that fails validation is refused with PLAN_CORRUPT and nothing is written', async (r) => {
    const store = rw(r);
    await store.save(sizedPlan('docs/a.md', 'good'));
    const before = await snapshot(r.root);
    const broken = { ...sizedPlan('docs/a.md', 'bad'), schemaVersion: 2 } as unknown as DocPlan;
    expectCode(await outcome(store.save(broken)), 'PLAN_CORRUPT', 'schemaVersion 2');
    const notAPlan = { ...sizedPlan('docs/b.md', 'bad'), features: 'nope' } as unknown as DocPlan;
    expectCode(await outcome(store.save(notAPlan)), 'PLAN_CORRUPT', 'features is a string');
    expect(await snapshot(r.root)).toEqual(before);
    expect(await store.load('docs/a.md')).toEqual(sizedPlan('docs/a.md', 'good'));
  });

  add('ids that would leave the store directory are refused with POLICY_DENIED by load, save and remove', async (r) => {
    await writeFile(join(r.outside, 'escape.plan.json'), stableJson(sizedPlan('escape', 'decoy') as unknown as JsonValue));
    const store = rw(r);
    const before = await snapshot(r.root);
    for (const uri of escapingDocUris(r.outside)) {
      const label = JSON.stringify(uri);
      expectCode(await outcome(store.load(uri)), 'POLICY_DENIED', `load ${label}`);
      expectCode(await outcome(store.save(sizedPlan(uri, 'evil'))), 'POLICY_DENIED', `save ${label}`);
      expectCode(await outcome(store.remove(uri)), 'POLICY_DENIED', `remove ${label}`);
    }
    expect(await snapshot(r.root)).toEqual(before);
    expect(await store.loadAll()).toEqual([]);
  });

  add('unusual but harmless ids are either refused or kept inside the store directory and round trip', async (r) => {
    await writeFile(join(r.outside, 'escape.plan.json'), 'decoy');
    const store = rw(r);
    const outsideBefore = await snapshot(r.outside);
    const uris = ['%2e%2e/x.md', '..%2fx.md', 'docs/..\u2215x.md', 'docs//x.md', './x.md', 'docs/./x.md', '', '.', ' ', 'docs/ /x.md', `${'long'.repeat(80)}.md`, `docs/${'d'.repeat(300)}/x.md`, 'CON', 'x.md.', 'x.md\u202e'];
    for (const uri of uris) {
      const label = JSON.stringify(uri.length > 40 ? `${uri.slice(0, 20)}...(${uri.length})` : uri);
      const saved = await outcome(store.save(sizedPlan(uri, 'odd')));
      if (!saved.ok) {
        const err = saved.error as { code?: unknown };
        expect(typeof err.code, `save ${label} failed with a raw error: ${String(saved.error)}`).toBe('string');
        expect(saved.error, `save ${label}`).toBeInstanceOf(AiBddError);
        expect((saved.error as AiBddError).code, `save ${label}`).toBe('POLICY_DENIED');
        continue;
      }
      expect(await store.load(uri), `load ${label}`).toEqual(sizedPlan(uri, 'odd'));
      await store.remove(uri);
      expect(await store.load(uri), `load after remove ${label}`).toBeNull();
    }
    expect(await snapshot(r.outside)).toEqual(outsideBefore);
    expect(await filesUnder(r.store)).toEqual([]);
  });

  add('ids that differ only by case never alias one another', async (r) => {
    const store = rw(r);
    const a = sizedPlan('Docs/Billing.md', 'upper');
    const b = sizedPlan('docs/billing.md', 'lower');
    await store.save(a);
    await store.save(b);
    expect(await store.load('Docs/Billing.md')).toEqual(a);
    expect(await store.load('docs/billing.md')).toEqual(b);
    expect((await store.loadAll()).map((p) => p.extractor.modelId).sort()).toEqual(['model-lower', 'model-upper']);
    await store.remove('Docs/Billing.md');
    expect(await store.load('docs/billing.md')).toEqual(b);
  });

  add('a directory inside the store that is a symlink leaving it is never written through', async (r) => {
    const victim = join(r.outside, 'x.md.plan.json');
    await writeFile(victim, 'victim');
    await symlink(r.outside, join(r.store, 'docs'));
    const before = await snapshot(r.outside);
    const store = rw(r);
    expectCode(await outcome(store.save(sizedPlan('docs/x.md', 'evil'))), 'POLICY_DENIED', 'save through a symlinked directory');
    const removal = await outcome(store.remove('docs/x.md'));
    if (!removal.ok) expectCode(removal, 'POLICY_DENIED', 'remove through a symlinked directory');
    expect(await readFile(victim, 'utf8'), 'a file outside the store was removed or overwritten').toBe('victim');
    expect(await snapshot(r.outside)).toEqual(before);
    expect(await readFile(join(r.outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  add('a symlink leaving the store is not read through either', async (r) => {
    const secret = sizedPlan('docs/x.md', 'secret');
    await writeFile(join(r.outside, 'x.md.plan.json'), stableJson(secret as unknown as JsonValue));
    await symlink(r.outside, join(r.store, 'docs'));
    const store = rw(r);
    const out = await outcome(store.load('docs/x.md'));
    if (out.ok) expect(out.value, 'a plan outside the store directory was served').toBeNull();
    else expectCode(out, 'POLICY_DENIED', 'load through a symlinked directory');
    expect(await store.loadAll()).toEqual([]);
    expect(store.loadAllSync()).toEqual([]);
  });

  add('a symlink in place of the plan file is replaced, never written through', async (r) => {
    const store = rw(r);
    await store.save(sizedPlan('docs/a.md', 'first'));
    const file = await soleFile(r.store);
    const target = join(r.outside, 'victim.txt');
    await writeFile(target, 'victim');
    await rm(file);
    await symlink(target, file);
    await store.save(sizedPlan('docs/a.md', 'second'));
    expect(await readFile(target, 'utf8')).toBe('victim');
    expect(await store.load('docs/a.md')).toEqual(sizedPlan('docs/a.md', 'second'));
  });

  add('a store directory that is itself a symlink works and keeps its files in the target', async (r) => {
    const real = join(r.root, 'real');
    const link = join(r.root, 'link');
    await mkdir(real);
    await symlink(real, link);
    const store = make(link, { readOnly: false });
    await store.save(sizedPlan('docs/a.md', 'a'));
    expect(await store.load('docs/a.md')).toEqual(sizedPlan('docs/a.md', 'a'));
    expect(await filesUnder(real)).toHaveLength(1);
    expect(await snapshot(r.outside)).toEqual(['keep.txt|file|' + createHash('sha256').update('keep').digest('hex')]);
  });

  add('damaged files surface as PLAN_CORRUPT or PLAN_SCHEMA_UNSUPPORTED, never as a plan', async (r) => {
    const store = rw(r);
    const good = richPlan();
    await store.save(good);
    const file = await soleFile(r.store);
    const goodText = await readFile(file, 'utf8');
    const damage: Array<[string, string, ErrorCode]> = [
      ['garbage', '{ not json', 'PLAN_CORRUPT'],
      ['empty file', '', 'PLAN_CORRUPT'],
      ['JSON null', 'null\n', 'PLAN_CORRUPT'],
      ['half of the bytes', goodText.slice(0, Math.floor(goodText.length / 2)), 'PLAN_CORRUPT'],
      ['all but the last byte', goodText.slice(0, -1).replace(/\}$/, ''), 'PLAN_CORRUPT'],
      ['a different shape', JSON.stringify({ ...good, features: 'nope' }), 'PLAN_CORRUPT'],
      ['an unexpected key', JSON.stringify({ ...good, unexpected: 1 }), 'PLAN_CORRUPT'],
      ['another document uri', JSON.stringify({ ...good, docUri: 'docs/else.md' }), 'PLAN_CORRUPT'],
      ['an unknown schema version', JSON.stringify({ ...good, schemaVersion: 2 }), 'PLAN_SCHEMA_UNSUPPORTED'],
    ];
    for (const [label, content, code] of damage) {
      await writeFile(file, content);
      expectCode(await outcome(store.load('docs/billing.md')), code, `load, ${label}`);
      expectCode(await outcome(store.loadAll()), code, `loadAll, ${label}`);
      expectCode(await outcome(async () => store.loadAllSync()), code, `loadAllSync, ${label}`);
    }
    await writeFile(file, goodText);
    expect(await store.load('docs/billing.md')).toEqual(good);
  });

  add('a plan moved to another path is detected: its docUri must match where it is found', async (r) => {
    const store = rw(r);
    await store.save(sizedPlan('docs/billing.md', 'a'));
    const file = await soleFile(r.store);
    const moved = join(dirname(file), basename(file).replace('billing', 'invoices'));
    await rename(file, moved);
    expectCode(await outcome(store.load('docs/invoices.md')), 'PLAN_CORRUPT', 'load of a moved plan');
    expectCode(await outcome(store.loadAll()), 'PLAN_CORRUPT', 'loadAll with a moved plan');
  });

  add('overwrite is atomic: concurrent readers only ever see a complete old or a complete new plan', async (r) => {
    const store = rw(r);
    const versions = [sizedPlan('docs/big.md', 'alpha', 4000), sizedPlan('docs/big.md', 'omega', 6000)];
    await store.save(versions[0] as DocPlan);
    const accept = (p: DocPlan | null): void => {
      expect(p, 'a plan that was saved vanished').not.toBeNull();
      expect(versions.some((v) => stableJson(v as unknown as JsonValue) === stableJson(p as unknown as JsonValue)), 'a reader saw a plan that is neither version').toBe(true);
    };
    const reads = await raceWritesAgainstReads({
      rounds: 40,
      readers: 3,
      write: (i) => store.save(versions[i % 2] as DocPlan),
      read: async () => {
        accept(await store.load('docs/big.md'));
        const all = await store.loadAll();
        expect(all).toHaveLength(1);
        accept(all[0] ?? null);
        accept(store.loadAllSync()[0] ?? null);
      },
    });
    expect(reads).toBeGreaterThan(0);
    expect(await filesUnder(r.store), 'nothing but the plan may be left in the directory').toHaveLength(1);
  });

  add('concurrent saves of one plan end in exactly one complete version, concurrent saves of many plans all land', async (r) => {
    const store = rw(r);
    const versions = Array.from({ length: 6 }, (_, i) => sizedPlan('docs/same.md', `v${i}`, 500 * (i + 1)));
    await Promise.all(versions.map((v) => store.save(v)));
    const final = await store.load('docs/same.md');
    expect(versions.map((v) => stableJson(v as unknown as JsonValue))).toContain(stableJson(final as unknown as JsonValue));
    expect(await filesUnder(r.store)).toHaveLength(1);
    const uris = Array.from({ length: 24 }, (_, i) => `docs/many/${String(i).padStart(2, '0')}.md`);
    await Promise.all(uris.map((u) => store.save(sizedPlan(u, 'many'))));
    expect((await store.loadAll()).map((p) => p.docUri)).toEqual(['docs/many/00.md', ...uris.slice(1), 'docs/same.md'].sort());
    expect(await filesUnder(r.store)).toHaveLength(25);
  });

  return cases;
}

export function runPlanStoreContract(name: string, make: MakePlanStore, options: PlanStoreContractOptions = {}): void {
  runCases(`PlanStore contract: ${name}`, planStoreContractCases(make, options));
}

// ───────────────────────── recording store

export const SCENARIO_ID = 'billing--upgrade-to-pro/user-upgrades';

/** A schema-valid recording; `over` changes top-level fields. */
export function sampleRecording(over: Partial<ScenarioRecording> = {}): ScenarioRecording {
  return {
    schemaVersion: 1,
    scenarioId: SCENARIO_ID,
    scenarioFingerprint: sha256Hex('fp'),
    driver: { id: 'playwright', major: 1 },
    steps: [
      {
        stepKey: 'when:0123456789ab',
        stepTextHash: sha256Hex('when'),
        kind: 'when',
        determinism: 'deterministic',
        fuzzyReasons: [],
        act: {
          startRoute: '/billing',
          startLandmarks: sha256Hex('landmarks'),
          actions: [
            { verb: 'click', target: { role: 'button', name: 'Upgrade', ancestors: [{ role: 'region', name: 'Plan' }], index: 0, of: 1 } },
            { verb: 'fill', target: { role: 'textbox', name: 'Name', ancestors: [], index: 0, of: 1, testId: 'name' }, value: { param: 'name' } },
          ],
          effect: {
            routeBefore: '/billing',
            routeAfter: '/billing',
            appeared: [{ role: 'status', name: 'Upgraded' }],
            disappeared: [],
            changed: [{ key: { role: 'checkbox', name: 'Agree' }, state: 'checked', from: false, to: true }],
          },
        },
        stats: { healCount: 0 },
      },
      {
        stepKey: 'then:abcdefabcdef',
        stepTextHash: sha256Hex('then'),
        kind: 'then',
        determinism: 'deterministic',
        fuzzyReasons: [],
        check: {
          classification: 'change',
          predicates: [
            { op: 'exists', query: { role: 'status', name: 'Upgraded' } },
            { op: 'text', query: { role: 'heading' }, match: 'contains', value: { param: 'plan' } },
            { op: 'state', query: { role: 'checkbox', name: 'Agree' }, state: 'checked', value: true },
            { op: 'route', match: 'prefix', value: '/billing' },
          ],
          generatedBy: { modelId: 'fake', promptVersion: 'checkgen-v1' },
          verified: { afterTrue: true, probeTrue: true, beforeFalse: true, judgePassed: true },
        },
        stats: { healCount: 1 },
      },
    ],
    promptVersions: { act: 'act-v1', checkgen: 'checkgen-v1', judge: 'judge-v1' },
    ...over,
  };
}

/** A recording that differs from the default in its bytes and, with `waits`, in its size. */
export function sizedRecording(scenarioId: string, tag: string, waits = 0, driverId = 'playwright'): ScenarioRecording {
  const base = sampleRecording({ scenarioId, scenarioFingerprint: sha256Hex(`fp:${tag}`), driver: { id: driverId, major: 1 } });
  const first = base.steps[0];
  if (first?.act === undefined) throw new Error('fixture');
  for (let i = 0; i < waits; i += 1) first.act.actions.push({ verb: 'wait', ms: i });
  return base;
}

export type MakeRecordingStore = (dir: string, opts: { mode: RecordingsMode }) => RecordingStore;

export interface RecordingStoreContractOptions {
  /** The code writes are refused with unless the mode is read-write. Default `RECORDING_READ_ONLY`. */
  readOnlyCode?: ErrorCode;
}

export function recordingStoreContractCases(make: MakeRecordingStore, options: RecordingStoreContractOptions = {}): StoreCase[] {
  const readOnlyCode = options.readOnlyCode ?? 'RECORDING_READ_ONLY';
  const cases: StoreCase[] = [];
  const add = (name: string, run: (r: Root) => Promise<void>): void => {
    cases.push({ name, run: () => withRoot(run) });
  };
  const rw = (r: Root): RecordingStore => make(r.store, { mode: 'read-write' });

  add('the store reports its directory and mode', async (r) => {
    for (const mode of ['read-write', 'read-only', 'off'] as const) {
      const store = make(r.store, { mode });
      expect(store.mode).toBe(mode);
      expect(resolve(store.dir)).toBe(resolve(r.store));
    }
  });

  add('round trip: what is saved is what is loaded, as fresh objects, and the argument is not touched', async (r) => {
    const store = rw(r);
    const rec = sampleRecording();
    const frozen = deepFreeze(structuredClone(rec));
    expect(await store.save(frozen)).toBe('created');
    expect(frozen).toEqual(rec);
    const first = await store.load('playwright', SCENARIO_ID);
    expect(first).toEqual(rec);
    (first as ScenarioRecording).steps.length = 0;
    (first as ScenarioRecording).driver.id = 'mutated';
    expect(await store.load('playwright', SCENARIO_ID)).toEqual(rec);
  });

  add('a heal count and fuzzy reasons survive the round trip exactly', async (r) => {
    const store = rw(r);
    const rec = sampleRecording();
    const first = rec.steps[0];
    if (first === undefined) throw new Error('fixture');
    first.determinism = 'fuzzy';
    first.fuzzyReasons = ['heal-threshold', 'no-observable-effect'];
    first.stats = { healCount: 2 };
    await store.save(rec);
    expect(await store.load('playwright', SCENARIO_ID)).toEqual(rec);
  });

  add('save reports created, unchanged and updated, and an unchanged save does not touch the file', async (r) => {
    const store = rw(r);
    expect(await store.save(sampleRecording())).toBe('created');
    const file = await soleFile(r.store);
    const before = await stat(file, { bigint: true });
    const bytes = await readFile(file);
    expect(await store.save(sampleRecording())).toBe('unchanged');
    expect(await store.save(reverseKeys(sampleRecording()) as ScenarioRecording)).toBe('unchanged');
    const after = await stat(file, { bigint: true });
    expect({ ino: after.ino, mtimeNs: after.mtimeNs, size: after.size }).toEqual({ ino: before.ino, mtimeNs: before.mtimeNs, size: before.size });
    expect((await readFile(file)).equals(bytes)).toBe(true);
    const changed = sampleRecording({ scenarioFingerprint: sha256Hex('other') });
    expect(await store.save(changed)).toBe('updated');
    expect((await store.load('playwright', SCENARIO_ID))?.scenarioFingerprint).toBe(sha256Hex('other'));
    expect(await store.save(changed)).toBe('unchanged');
    expect(await store.save(sampleRecording())).toBe('updated');
    expect(await filesUnder(r.store)).toHaveLength(1);
  });

  add('a missing recording loads as null, nothing is listed, and reading creates nothing', async (r) => {
    await rm(r.store, { recursive: true });
    const before = await snapshot(r.root);
    const store = rw(r);
    expect(await store.load('playwright', 'nope/missing')).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await snapshot(r.root)).toEqual(before);
    await mkdir(r.store);
    expect(await store.load('playwright', 'nope/missing')).toBeNull();
    expect(await store.load('fake', SCENARIO_ID)).toBeNull();
  });

  add('files are canonical JSON, byte-identical when built with another key order', async (r) => {
    const store = rw(r);
    await store.save(sampleRecording());
    const file = await soleFile(r.store);
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(isCanonical(text)).toBe(true);
    expect(text).toBe(stableJson(sampleRecording() as unknown as JsonValue));
    const other = join(r.root, 'store2');
    await mkdir(other);
    await make(other, { mode: 'read-write' }).save(reverseKeys(sampleRecording()) as ScenarioRecording);
    expect(await readFile(await soleFile(other), 'utf8')).toBe(text);
  });

  add('list is sorted by driver then scenario, whatever order the recordings were saved in, and ignores stray files', async (r) => {
    const items: Array<[string, string]> = [
      ['playwright', 'b--x/two'],
      ['playwright', 'a--x/one'],
      ['fake', 'a--x/two'],
      ['playwright', 'a--x/one-more'],
      ['playwright', 'a--x-y/one'],
      ['fake', 'z'],
      ['cua', 'a--x/two'],
    ];
    const expected = [...items]
      .map(([driverId, scenarioId]) => ({ driverId, scenarioId }))
      .sort((a, b) => (a.driverId !== b.driverId ? (a.driverId < b.driverId ? -1 : 1) : a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0));
    const store = rw(r);
    for (const [driverId, scenarioId] of items) await store.save(sizedRecording(scenarioId, scenarioId, 0, driverId));
    await mkdir(join(r.store, 'playwright'), { recursive: true });
    await writeFile(join(r.store, 'playwright', 'README.txt'), 'ignored');
    await writeFile(join(r.store, 'NOTES.md'), 'ignored');
    expect(await store.list()).toEqual(expected);

    const other = join(r.root, 'store2');
    await mkdir(other);
    const store2 = make(other, { mode: 'read-write' });
    for (const [driverId, scenarioId] of [...items].reverse()) await store2.save(sizedRecording(scenarioId, scenarioId, 0, driverId));
    expect(await store2.list()).toEqual(expected);
    for (const { driverId, scenarioId } of expected) expect((await store.load(driverId, scenarioId))?.scenarioId).toBe(scenarioId);
  });

  add('the whole safe id alphabet, including dots, dashes and underscores, round trips', async (r) => {
    const store = rw(r);
    const id = 'docs-billing--plan.v2_x/scenario-1';
    expect(await store.save(sampleRecording({ scenarioId: id }))).toBe('created');
    expect((await store.load('playwright', id))?.scenarioId).toBe(id);
    expect(await store.list()).toEqual([{ driverId: 'playwright', scenarioId: id }]);
  });

  add('remove is idempotent, removes only its recording, and never fails for one that was never there', async (r) => {
    const store = rw(r);
    await store.remove('playwright', 'never/there');
    await store.save(sizedRecording('a--x/one', 'a'));
    await store.save(sizedRecording('a--x/two', 'b'));
    await store.remove('playwright', 'a--x/one');
    await store.remove('playwright', 'a--x/one');
    expect(await store.load('playwright', 'a--x/one')).toBeNull();
    expect(await store.load('playwright', 'a--x/two')).toEqual(sizedRecording('a--x/two', 'b'));
    expect(await store.list()).toEqual([{ driverId: 'playwright', scenarioId: 'a--x/two' }]);
    await rm(r.store, { recursive: true });
    await store.remove('playwright', 'a--x/two');
  });

  add('read-only: reads work, every write is refused with the documented code, every byte stays as it was', async (r) => {
    await rw(r).save(sampleRecording());
    const before = await snapshot(r.root);
    const ro = make(r.store, { mode: 'read-only' });
    expect(await ro.load('playwright', SCENARIO_ID)).toEqual(sampleRecording());
    expect(await ro.list()).toEqual([{ driverId: 'playwright', scenarioId: SCENARIO_ID }]);
    expectCode(await outcome(ro.save(sampleRecording())), readOnlyCode, 'save of identical bytes');
    expectCode(await outcome(ro.save(sampleRecording({ scenarioFingerprint: sha256Hex('x') }))), readOnlyCode, 'overwrite');
    expectCode(await outcome(ro.save(sampleRecording({ scenarioId: 'other/new' }))), readOnlyCode, 'save of a new recording');
    expectCode(await outcome(ro.remove('playwright', SCENARIO_ID)), readOnlyCode, 'remove');
    expectCode(await outcome(ro.remove('playwright', 'never/there')), readOnlyCode, 'remove of a missing recording');
    expect(await snapshot(r.root)).toEqual(before);
    await rm(r.store, { recursive: true });
    const gone = await snapshot(r.root);
    expectCode(await outcome(ro.save(sampleRecording())), readOnlyCode, 'save into a missing directory');
    expect(await snapshot(r.root)).toEqual(gone);
  });

  add("mode 'off' neither serves nor writes recordings", async (r) => {
    await rw(r).save(sampleRecording());
    const before = await snapshot(r.root);
    const off = make(r.store, { mode: 'off' });
    expect(await off.load('playwright', SCENARIO_ID)).toBeNull();
    expect(await off.list()).toEqual([]);
    expectCode(await outcome(off.save(sampleRecording({ scenarioId: 'x/y' }))), readOnlyCode, 'save when off');
    expectCode(await outcome(off.remove('playwright', SCENARIO_ID)), readOnlyCode, 'remove when off');
    expect(await snapshot(r.root)).toEqual(before);
  });

  add('a recording that fails validation is refused with RECORDING_CORRUPT and nothing is written', async (r) => {
    const store = rw(r);
    await store.save(sampleRecording());
    const before = await snapshot(r.root);
    expectCode(await outcome(store.save(sampleRecording({ scenarioFingerprint: 'not-a-sha' }))), 'RECORDING_CORRUPT', 'bad fingerprint');
    expectCode(await outcome(store.save({ ...sampleRecording(), schemaVersion: 2 } as unknown as ScenarioRecording)), 'RECORDING_CORRUPT', 'schemaVersion 2');
    const badVerb = sampleRecording();
    const firstStep = badVerb.steps[0];
    if (firstStep?.act === undefined) throw new Error('fixture');
    (firstStep.act.actions as unknown[]).push({ verb: 'teleport' });
    expectCode(await outcome(store.save(badVerb)), 'RECORDING_CORRUPT', 'unknown verb');
    expect(await snapshot(r.root)).toEqual(before);
    expect(await store.load('playwright', SCENARIO_ID)).toEqual(sampleRecording());
  });

  add('ids that would leave the store directory, or are not safe path segments, are refused with POLICY_DENIED', async (r) => {
    const store = rw(r);
    const before = await snapshot(r.root);
    const scenarios = ['../outside/escape', 'a/../../outside/escape', '../evil', 'a/../b', '/abs', join(r.outside, 'escape'), 'a//b', 'a\\b', 'a\\..\\..\\b', '', '.', '..', 'a/.', 'a/b/', 'a\0b', 'a:b'];
    for (const id of scenarios) {
      const label = JSON.stringify(id);
      expectCode(await outcome(store.load('playwright', id)), 'POLICY_DENIED', `load scenario ${label}`);
      expectCode(await outcome(store.save(sampleRecording({ scenarioId: id }))), 'POLICY_DENIED', `save scenario ${label}`);
      expectCode(await outcome(store.remove('playwright', id)), 'POLICY_DENIED', `remove scenario ${label}`);
    }
    for (const driver of ['..', '../outside', '../x', 'a/b', '/abs', 'a\\b', 'a\0b', '', '.']) {
      const label = JSON.stringify(driver);
      expectCode(await outcome(store.load(driver, SCENARIO_ID)), 'POLICY_DENIED', `load driver ${label}`);
      expectCode(await outcome(store.save(sampleRecording({ driver: { id: driver, major: 1 } }))), 'POLICY_DENIED', `save driver ${label}`);
      expectCode(await outcome(store.remove(driver, SCENARIO_ID)), 'POLICY_DENIED', `remove driver ${label}`);
    }
    expect(await snapshot(r.root)).toEqual(before);
  });

  add('very long or oddly spelled ids are refused or kept inside the store directory, never a raw error', async (r) => {
    const store = rw(r);
    const outsideBefore = await snapshot(r.outside);
    const ids = ['x'.repeat(300), `${'seg/'.repeat(80)}leaf`, `docs/${'d'.repeat(260)}`, 'CON', 'é', 'sp ace', 'a%2fb', 'a\u202eb'];
    for (const id of ids) {
      const label = JSON.stringify(id.length > 40 ? `${id.slice(0, 20)}...(${id.length})` : id);
      const saved = await outcome(store.save(sampleRecording({ scenarioId: id })));
      if (!saved.ok) {
        expect(saved.error, `save ${label} failed with a raw error: ${String(saved.error)}`).toBeInstanceOf(AiBddError);
        expect((saved.error as AiBddError).code, `save ${label}`).toBe('POLICY_DENIED');
        const loaded = await outcome(store.load('playwright', id));
        if (loaded.ok) expect(loaded.value, `load ${label} of an id save refused`).toBeNull();
        else expect(loaded.error, `load ${label} failed with a raw error: ${String(loaded.error)}`).toBeInstanceOf(AiBddError);
        continue;
      }
      expect((await store.load('playwright', id))?.scenarioId, `load ${label}`).toBe(id);
      await store.remove('playwright', id);
      expect(await store.load('playwright', id), `load after remove ${label}`).toBeNull();
    }
    expect(await snapshot(r.outside)).toEqual(outsideBefore);
  });

  add('ids that differ only by case never alias one another', async (r) => {
    const store = rw(r);
    const upper = sizedRecording('Billing--Upgrade/One', 'upper');
    const lower = sizedRecording('billing--upgrade/one', 'lower');
    const stored: Array<[string, ScenarioRecording]> = [];
    for (const rec of [upper, lower]) {
      const out = await outcome(store.save(rec));
      if (out.ok) stored.push([rec.scenarioId, rec]);
      else expectCode(out, 'POLICY_DENIED', `save ${rec.scenarioId}`);
    }
    for (const [id, rec] of stored) expect(await store.load('playwright', id), id).toEqual(rec);
    expect((await store.list()).length).toBe(stored.length);
  });

  add('a driver directory that is a symlink leaving the store is never written through', async (r) => {
    const victim = join(r.outside, 'billing--upgrade-to-pro', 'user-upgrades.json');
    await mkdir(dirname(victim));
    await writeFile(victim, 'victim');
    await symlink(r.outside, join(r.store, 'playwright'));
    const before = await snapshot(r.outside);
    const store = rw(r);
    expectCode(await outcome(store.save(sampleRecording())), 'POLICY_DENIED', 'save through a symlinked directory');
    const removal = await outcome(store.remove('playwright', SCENARIO_ID));
    if (!removal.ok) expectCode(removal, 'POLICY_DENIED', 'remove through a symlinked directory');
    expect(await readFile(victim, 'utf8'), 'a file outside the store was removed or overwritten').toBe('victim');
    expect(await snapshot(r.outside)).toEqual(before);
    expect(await readFile(join(r.outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  add('a symlink leaving the store is not read through either', async (r) => {
    await mkdir(join(r.outside, 'billing--upgrade-to-pro'), { recursive: true });
    await writeFile(join(r.outside, 'billing--upgrade-to-pro', 'user-upgrades.json'), stableJson(sampleRecording() as unknown as JsonValue));
    await symlink(r.outside, join(r.store, 'playwright'));
    const store = rw(r);
    const out = await outcome(store.load('playwright', SCENARIO_ID));
    if (out.ok) expect(out.value, 'a recording outside the store directory was served').toBeNull();
    else expectCode(out, 'POLICY_DENIED', 'load through a symlinked directory');
    expect(await store.list()).toEqual([]);
  });

  add('a symlink in place of the recording file is replaced, never written through', async (r) => {
    const store = rw(r);
    await store.save(sampleRecording());
    const file = await soleFile(r.store);
    const target = join(r.outside, 'victim.txt');
    await writeFile(target, 'victim');
    await rm(file);
    await symlink(target, file);
    await store.save(sampleRecording({ scenarioFingerprint: sha256Hex('second') }));
    expect(await readFile(target, 'utf8')).toBe('victim');
    expect((await store.load('playwright', SCENARIO_ID))?.scenarioFingerprint).toBe(sha256Hex('second'));
  });

  add('a store directory that is itself a symlink works and keeps its files in the target', async (r) => {
    const real = join(r.root, 'real');
    const link = join(r.root, 'link');
    await mkdir(real);
    await symlink(real, link);
    const store = make(link, { mode: 'read-write' });
    await store.save(sampleRecording());
    expect(await store.load('playwright', SCENARIO_ID)).toEqual(sampleRecording());
    expect(await filesUnder(real)).toHaveLength(1);
    expect(await filesUnder(r.outside)).toEqual(['keep.txt']);
  });

  add('damaged files surface as RECORDING_CORRUPT, never as a recording', async (r) => {
    const store = rw(r);
    await store.save(sampleRecording());
    const file = await soleFile(r.store);
    const goodText = await readFile(file, 'utf8');
    const damage: Array<[string, string]> = [
      ['garbage', '{ not json'],
      ['empty file', ''],
      ['JSON null', 'null\n'],
      ['an empty object', '{"schemaVersion":1}'],
      ['half of the bytes', goodText.slice(0, Math.floor(goodText.length / 2))],
      ['an unknown schema version', JSON.stringify({ ...sampleRecording(), schemaVersion: 2 })],
      ['another scenario id', JSON.stringify(sampleRecording({ scenarioId: 'other/id' }))],
      ['another driver', JSON.stringify(sampleRecording({ driver: { id: 'fake', major: 1 } }))],
    ];
    for (const [label, content] of damage) {
      await writeFile(file, content);
      expectCode(await outcome(store.load('playwright', SCENARIO_ID)), 'RECORDING_CORRUPT', `load, ${label}`);
    }
    await writeFile(file, goodText);
    expect(await store.load('playwright', SCENARIO_ID)).toEqual(sampleRecording());
  });

  add('overwrite is atomic: concurrent readers only ever see a complete old or a complete new recording', async (r) => {
    const store = rw(r);
    const versions = [sizedRecording(SCENARIO_ID, 'alpha', 600), sizedRecording(SCENARIO_ID, 'omega', 900)];
    await store.save(versions[0] as ScenarioRecording);
    const accept = (rec: ScenarioRecording | null): void => {
      expect(rec, 'a recording that was saved vanished').not.toBeNull();
      expect(versions.some((v) => stableJson(v as unknown as JsonValue) === stableJson(rec as unknown as JsonValue)), 'a reader saw a recording that is neither version').toBe(true);
    };
    const reads = await raceWritesAgainstReads({
      rounds: 40,
      readers: 3,
      write: (i) => store.save(versions[i % 2] as ScenarioRecording),
      read: async () => {
        accept(await store.load('playwright', SCENARIO_ID));
        expect(await store.list()).toEqual([{ driverId: 'playwright', scenarioId: SCENARIO_ID }]);
      },
    });
    expect(reads).toBeGreaterThan(0);
    expect(await filesUnder(r.store), 'nothing but the recording may be left in the directory').toHaveLength(1);
  });

  add('concurrent saves of one scenario end in exactly one complete version, concurrent saves of many all land', async (r) => {
    const store = rw(r);
    const versions = Array.from({ length: 6 }, (_, i) => sizedRecording(SCENARIO_ID, `v${i}`, 300 * (i + 1)));
    await Promise.all(versions.map((v) => store.save(v)));
    const final = await store.load('playwright', SCENARIO_ID);
    expect(versions.map((v) => stableJson(v as unknown as JsonValue))).toContain(stableJson(final as unknown as JsonValue));
    expect(await filesUnder(r.store)).toHaveLength(1);
    const ids = Array.from({ length: 20 }, (_, i) => `many--s/${String(i).padStart(2, '0')}`);
    await Promise.all(ids.map((id) => store.save(sizedRecording(id, id))));
    expect((await store.list()).map((e) => e.scenarioId)).toEqual([...ids, SCENARIO_ID].sort());
    expect(await filesUnder(r.store)).toHaveLength(21);
  });

  return cases;
}

export function runRecordingStoreContract(name: string, make: MakeRecordingStore, options: RecordingStoreContractOptions = {}): void {
  runCases(`RecordingStore contract: ${name}`, recordingStoreContractCases(make, options));
}

// ───────────────────────── evidence store

export type MakeEvidenceStore = (runsDir: string, runId: string, redactor: Redactor) => Promise<EvidenceStore>;

export interface EvidenceStoreContractOptions {
  /** The verifier that checks a finalized run directory (`verifyRun`). Tamper evidence is a property of store plus verifier. */
  verify: VerifyRun;
}

export const EVIDENCE_SECRET = 'hunter2-Pa55w0rd';

/** A literal-substring redactor: deliberately independent of the SDK's own redactor. */
export const literalRedactor: Redactor = {
  secretNames: ['password'],
  redact: (text) => text.split(EVIDENCE_SECRET).join('<secret:password>'),
  redactJson: <T extends JsonValue>(value: T): T => JSON.parse(JSON.stringify(value).split(EVIDENCE_SECRET).join('<secret:password>')) as T,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
const HEX64 = /^[0-9a-f]{64}$/;

export function evidenceStoreContractCases(make: MakeEvidenceStore, options: EvidenceStoreContractOptions): StoreCase[] {
  const cases: StoreCase[] = [];
  const add = (name: string, run: (r: Root) => Promise<void>): void => {
    cases.push({ name, run: () => withRoot(run) });
  };
  const open = (r: Root, runId = 'run-1', redactor: Redactor = literalRedactor): Promise<EvidenceStore> => make(r.store, runId, redactor);

  /** The manifest is the one file outside `artifacts/` whose JSON carries the digest finalize returned. */
  const findManifest = async (dir: string, digest: string): Promise<string> => {
    for (const rel of await filesUnder(dir)) {
      if (rel.startsWith('artifacts/')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, rel), 'utf8')) as { digest?: unknown };
        if (parsed.digest === digest) return join(dir, rel);
      } catch {
        /* not JSON (an event log) */
      }
    }
    throw new Error('no manifest file carrying the finalize digest was found');
  };

  const textKinds: ArtifactKind[] = ['observation', 'act-transcript', 'judge-request', 'checkgen', 'report'];

  add('the store reports its run id and keeps the run in its own directory below the runs directory', async (r) => {
    const store = await open(r, 'run-1');
    expect(store.runId).toBe('run-1');
    expect(resolve(store.dir)).toBe(resolve(r.store, 'run-1'));
    expect((await stat(store.dir)).isDirectory()).toBe(true);
  });

  add('putArtifact is content addressed: the ref describes exactly the bytes on disk', async (r) => {
    const store = await open(r);
    const json = await store.putArtifact('observation', JSON.stringify({ a: 1 }));
    const txt = await store.putArtifact('act-transcript', 'plain text, not json');
    const png = await store.putArtifact('screenshot', PNG);
    for (const [ref, bytes, kind] of [
      [json, Buffer.from('{"a":1}'), 'observation'],
      [txt, Buffer.from('plain text, not json'), 'act-transcript'],
      [png, Buffer.from(PNG), 'screenshot'],
    ] as const) {
      expect(ref.kind).toBe(kind);
      expect(ref.bytes).toBe(bytes.byteLength);
      expect(ref.sha256).toBe(sha256Hex(bytes));
      expect(ref.sha256).toMatch(HEX64);
      expect(ref.path.startsWith('/') || ref.path.includes('..') || ref.path.includes('\\')).toBe(false);
      expect((await readFile(join(store.dir, ref.path))).equals(bytes), `${kind}: bytes on disk`).toBe(true);
    }
    expect(new Set([json.path, txt.path, png.path]).size).toBe(3);
    expect(new Set([json.sha256, txt.sha256, png.sha256]).size).toBe(3);
  });

  add('the same bytes give the same ref and one file, different bytes a different one, strings and bytes agree', async (r) => {
    const store = await open(r);
    const a = await store.putArtifact('report', 'same content');
    const again = await store.putArtifact('report', 'same content');
    const asBytes = await store.putArtifact('report', Buffer.from('same content'));
    const other = await store.putArtifact('report', 'same content!');
    expect(again).toEqual(a);
    expect(asBytes).toEqual(a);
    expect(other.sha256).not.toBe(a.sha256);
    expect(other.path).not.toBe(a.path);
    expect(await filesUnder(join(store.dir, dirname(a.path)))).toHaveLength(2);
  });

  add('text is redacted before it is hashed and written; screenshots are stored byte for byte', async (r) => {
    const store = await open(r);
    const redacted = 'password=<secret:password>&q=<secret:password>';
    const ref = await store.putArtifact('judge-request', `password=${EVIDENCE_SECRET}&q=${EVIDENCE_SECRET}`);
    expect(ref.sha256).toBe(sha256Hex(redacted));
    expect(ref.bytes).toBe(Buffer.byteLength(redacted));
    expect(await readFile(join(store.dir, ref.path), 'utf8')).toBe(redacted);
    expect((await store.putArtifact('judge-request', redacted)).sha256, 'redacted and pre-redacted content must collapse').toBe(ref.sha256);
    const asBytes = await store.putArtifact('checkgen', Buffer.from(JSON.stringify({ v: EVIDENCE_SECRET })));
    expect(await readFile(join(store.dir, asBytes.path), 'utf8')).toBe('{"v":"<secret:password>"}');
    const shot = await store.putArtifact('screenshot', PNG);
    expect(shot.sha256).toBe(sha256Hex(PNG));
  });

  add('a secret never reaches disk, in artifacts, events or the manifest', async (r) => {
    const store = await open(r);
    for (const kind of textKinds) await store.putArtifact(kind, JSON.stringify({ field: EVIDENCE_SECRET, nested: [EVIDENCE_SECRET] }));
    await store.putArtifact('report', `typed ${EVIDENCE_SECRET} into the form`);
    await store.record({ type: 'log', message: `filled ${EVIDENCE_SECRET}`, nested: [{ v: EVIDENCE_SECRET }] });
    await store.finalize();
    let dump = '';
    for (const rel of await filesUnder(store.dir)) dump += `${rel}\n${(await readFile(join(store.dir, rel))).toString('latin1')}\n`;
    expect(dump).not.toContain(EVIDENCE_SECRET);
    expect(dump).toContain('<secret:password>');
  });

  add('record keeps every event, redacted, in call order even when calls overlap', async (r) => {
    const store = await open(r);
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.record({ marker: `evt-${String(i).padStart(2, '0')}`, secret: EVIDENCE_SECRET })));
    await store.finalize();
    let dump = '';
    for (const rel of await filesUnder(store.dir)) dump += (await readFile(join(store.dir, rel))).toString('utf8');
    let last = -1;
    for (let i = 0; i < 30; i += 1) {
      const marker = `evt-${String(i).padStart(2, '0')}`;
      expect(dump.split(marker).length - 1, marker).toBe(1);
      const at = dump.indexOf(marker);
      expect(at, `${marker} out of order`).toBeGreaterThan(last);
      last = at;
    }
    expect(dump).not.toContain(EVIDENCE_SECRET);
  });

  add('finalize lists every artifact once, sorted by path then kind, with a 64 hex digest, and is repeatable', async (r) => {
    const store = await open(r);
    for (const t of ['zulu', 'alpha', 'mike', 'bravo', 'alpha']) await store.putArtifact('report', t);
    await store.putArtifact('checkgen', 'alpha');
    const fin = await store.finalize();
    expect(fin.runId).toBe('run-1');
    expect(fin.digest).toMatch(HEX64);
    expect(fin.artifacts).toHaveLength(5);
    const keys = fin.artifacts.map((a) => `${a.path}\0${a.kind}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(fin.artifacts.filter((a) => a.path === fin.artifacts.find((x) => x.sha256 === sha256Hex('alpha'))?.path).map((a) => a.kind)).toEqual(['checkgen', 'report']);
    expect(await store.finalize()).toEqual(fin);
  });

  add('the digest depends on the artifacts only: stable across runs and put order, sensitive to content and kind', async (r) => {
    const digestOf = async (runId: string, puts: Array<[ArtifactKind, string]>): Promise<string> => {
      const store = await open(r, runId);
      for (const [kind, data] of puts) await store.putArtifact(kind, data);
      return (await store.finalize()).digest;
    };
    const base: Array<[ArtifactKind, string]> = [['report', 'one'], ['observation', '{"two":2}'], ['judge-request', 'three']];
    const d1 = await digestOf('run-a', base);
    expect(await digestOf('run-b', [...base].reverse())).toBe(d1);
    expect(await digestOf('run-c', [...base, base[0] as [ArtifactKind, string]])).toBe(d1);
    expect(await digestOf('run-d', [['report', 'one'], ['observation', '{"two":2}'], ['judge-request', 'thre3']])).not.toBe(d1);
    expect(await digestOf('run-e', [['report', 'one'], ['observation', '{"two":2}'], ['checkgen', 'three']])).not.toBe(d1);
    expect(await digestOf('run-f', base.slice(0, 2))).not.toBe(d1);
    const empty1 = await digestOf('run-g', []);
    expect(await digestOf('run-h', [])).toBe(empty1);
    expect(empty1).toMatch(HEX64);
    expect(empty1).not.toBe(d1);
  });

  add('a finalized run verifies; an unfinalized one does not', async (r) => {
    const store = await open(r);
    await store.putArtifact('report', 'content');
    const unfinished = await options.verify(store.dir);
    expect(unfinished.ok, 'a run that was not finalized must not verify').toBe(false);
    expect(unfinished.problems.length).toBeGreaterThan(0);
    const fin = await store.finalize();
    expect(await options.verify(store.dir)).toEqual({ ok: true, problems: [] });
    expect(await findManifest(store.dir, fin.digest), 'finalize must write a manifest carrying the digest it returns').toContain(store.dir);
    const empty = await open(r, 'empty');
    await empty.finalize();
    expect(await options.verify(empty.dir)).toEqual({ ok: true, problems: [] });
  });

  const tamper: Array<[string, (dir: string, art: string[], fin: { digest: string }) => Promise<void>, RegExp?]> = [
    [
      'flipping one byte of an artifact',
      async (dir, art) => {
        const file = join(dir, art[0] as string);
        const bytes = await readFile(file);
        bytes[0] = (bytes[0] as number) ^ 0x01;
        await writeFile(file, bytes);
      },
      /modified/,
    ],
    [
      'replacing an artifact with different content of the same length',
      async (dir, art) => {
        const file = join(dir, art[1] as string);
        await writeFile(file, 'X'.repeat((await readFile(file)).byteLength));
      },
      /modified/,
    ],
    [
      'truncating an artifact',
      async (dir, art) => {
        const file = join(dir, art[0] as string);
        await writeFile(file, (await readFile(file)).subarray(0, 2));
      },
      /modified/,
    ],
    [
      'swapping the contents of two artifacts',
      async (dir, art) => {
        const a = join(dir, art[0] as string);
        const b = join(dir, art[1] as string);
        const [ba, bb] = [await readFile(a), await readFile(b)];
        await writeFile(a, bb);
        await writeFile(b, ba);
      },
      /modified/,
    ],
    [
      'deleting an artifact',
      async (dir, art) => {
        await rm(join(dir, art[2] as string));
      },
      /missing/,
    ],
    [
      'adding a file to the artifacts directory',
      async (dir, art) => {
        await writeFile(join(dir, dirname(art[0] as string), 'planted.txt'), 'planted');
      },
      /extra/,
    ],
    [
      'editing the digest in the manifest',
      async (dir, _art, fin) => {
        const file = await findManifest(dir, fin.digest);
        const text = await readFile(file, 'utf8');
        await writeFile(file, text.replace(fin.digest, 'f'.repeat(64)));
      },
      /digest/,
    ],
    [
      'removing the manifest',
      async (dir, _art, fin) => {
        await rm(await findManifest(dir, fin.digest));
      },
    ],
    [
      'corrupting the manifest',
      async (dir, _art, fin) => {
        await writeFile(await findManifest(dir, fin.digest), '{ not json');
      },
    ],
  ];
  for (const [label, damage, expected] of tamper) {
    add(`tamper evidence: ${label} is reported by the verifier`, async (r) => {
      const store = await open(r);
      const refs = [await store.putArtifact('report', 'first artifact content'), await store.putArtifact('observation', '{"second":"artifact"}'), await store.putArtifact('checkgen', 'third artifact content')];
      const fin = await store.finalize();
      const paths = [...new Set(fin.artifacts.map((a) => a.path))];
      expect(paths).toHaveLength(refs.length);
      expect(await options.verify(store.dir)).toEqual({ ok: true, problems: [] });
      await damage(store.dir, paths, fin);
      const verdict = await options.verify(store.dir);
      expect(verdict.ok, `${label} went unnoticed`).toBe(false);
      expect(verdict.problems.length).toBeGreaterThan(0);
      if (expected !== undefined) expect(verdict.problems.some((p) => expected.test(p)), `no problem matching ${String(expected)} in ${JSON.stringify(verdict.problems)}`).toBe(true);
    });
  }

  add('run ids that could escape the runs directory are refused with POLICY_DENIED and create nothing', async (r) => {
    const before = await snapshot(r.root);
    for (const runId of ['', '.', '..', '../outside', '../x', 'a/b', 'a\\b', 'a\0b', '/abs', join(r.outside, 'run')]) {
      expectCode(await outcome(open(r, runId)), 'POLICY_DENIED', `run id ${JSON.stringify(runId)}`);
    }
    expect(await snapshot(r.root)).toEqual(before);
  });

  add('a very long run id is refused with POLICY_DENIED or works, never a raw error', async (r) => {
    for (const runId of ['r'.repeat(300), 'r'.repeat(5000)]) {
      const out = await outcome(open(r, runId));
      if (!out.ok) expectCode(out, 'POLICY_DENIED', `run id of ${runId.length} characters`);
      else {
        await out.value.putArtifact('report', 'content');
        await out.value.finalize();
        expect(await options.verify(out.value.dir)).toEqual({ ok: true, problems: [] });
      }
    }
    expect(await filesUnder(r.outside)).toEqual(['keep.txt']);
  });

  add('a run directory that is a symlink leaving the runs directory is never written through', async (r) => {
    await symlink(r.outside, join(r.store, 'run-1'));
    const before = await snapshot(r.outside);
    expectCode(await outcome(open(r, 'run-1')), 'POLICY_DENIED', 'run directory symlinked outside');
    expect(await snapshot(r.outside)).toEqual(before);
  });

  add('a runs directory that is itself a symlink works and keeps the run in the target', async (r) => {
    const real = join(r.root, 'real');
    const link = join(r.root, 'link');
    await mkdir(real);
    await symlink(real, link);
    const store = await make(link, 'run-1', literalRedactor);
    await store.putArtifact('report', 'content');
    await store.finalize();
    expect(await options.verify(store.dir)).toEqual({ ok: true, problems: [] });
    expect((await filesUnder(real)).some((f) => f.startsWith('run-1/artifacts/'))).toBe(true);
    expect(await filesUnder(r.outside)).toEqual(['keep.txt']);
  });

  add('a symlink in place of an artifact file is replaced, never written through', async (r) => {
    const store = await open(r);
    const ref = await store.putArtifact('report', 'first');
    const victim = join(r.outside, 'victim.txt');
    await writeFile(victim, 'victim');
    await rm(join(store.dir, ref.path));
    await symlink(victim, join(store.dir, ref.path));
    await store.putArtifact('report', 'first');
    expect(await readFile(victim, 'utf8')).toBe('victim');
    expect(await readFile(join(store.dir, ref.path), 'utf8')).toBe('first');
  });

  add('writing an artifact is atomic: re-putting the same content never exposes a torn file', async (r) => {
    const store = await open(r);
    const big = JSON.stringify({ rows: Array.from({ length: 30_000 }, (_, i) => `row-${i}`) });
    const ref = await store.putArtifact('observation', big);
    expect(ref.bytes).toBeGreaterThan(200_000);
    const file = join(store.dir, ref.path);
    let n = 0;
    const reads = await raceWritesAgainstReads({
      rounds: 25,
      readers: 3,
      write: () => store.putArtifact('observation', big),
      read: async () => {
        const bytes = await readFile(file);
        n += 1;
        expect(bytes.byteLength, `read ${n} saw a partial artifact`).toBe(ref.bytes);
        expect(sha256Hex(bytes)).toBe(ref.sha256);
      },
    });
    expect(reads).toBeGreaterThan(0);
    expect(await filesUnder(dirname(file)), 'nothing but the artifact may be left behind').toHaveLength(1);
  });

  return cases;
}

export function runEvidenceStoreContract(name: string, make: MakeEvidenceStore, options: EvidenceStoreContractOptions): void {
  runCases(`EvidenceStore contract: ${name}`, evidenceStoreContractCases(make, options));
}

// ───────────────────────── plumbing

function runCases(title: string, cases: StoreCase[]): void {
  describe(title, () => {
    // The timeout only bounds a hang; no case asserts on elapsed time.
    for (const c of cases) it(c.name, c.run, 60_000);
  });
}
