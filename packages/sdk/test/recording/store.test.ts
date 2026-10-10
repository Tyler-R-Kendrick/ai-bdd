import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioRecording } from '../../src/contracts/index.ts';
import { createRecordingStore } from '../../src/recording/index.ts';
import { sha256Hex, stableJson } from '../../src/util/index.ts';

const fsCalls = vi.hoisted(() => ({ mutating: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const spy = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...args: A): R => {
    fsCalls.mutating.push(name);
    return fn(...args);
  };
  return {
    ...actual,
    default: actual,
    mkdir: spy('mkdir', actual.mkdir),
    open: spy('open', actual.open),
    rename: spy('rename', actual.rename),
    rm: spy('rm', actual.rm),
    rmdir: spy('rmdir', actual.rmdir),
    writeFile: spy('writeFile', actual.writeFile),
    appendFile: spy('appendFile', actual.appendFile),
    copyFile: spy('copyFile', actual.copyFile),
  };
});

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  return v;
}

const SCENARIO = 'billing--upgrade-to-pro/user-upgrades';

function recording(over: Partial<ScenarioRecording> = {}): ScenarioRecording {
  return {
    schemaVersion: 1,
    scenarioId: SCENARIO,
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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aibdd-rec-'));
  fsCalls.mutating.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('recording store', () => {
  it('R-PL4: writes to <dir>/<driverId>/<scenarioId>.json with the scenario "/" as a directory separator', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    expect(await store.save(recording())).toBe('created');
    const file = join(dir, 'playwright', 'billing--upgrade-to-pro', 'user-upgrades.json');
    expect(existsSync(file)).toBe(true);
    expect(await store.load('playwright', SCENARIO)).toEqual(recording());
  });

  it('R-PL4: files are deterministic: stableJson bytes, LF, trailing newline, no timestamps, independent of key order', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    await store.save(recording());
    const file = join(dir, 'playwright', 'billing--upgrade-to-pro', 'user-upgrades.json');
    const bytes = await readFile(file, 'utf8');
    expect(bytes).toBe(stableJson(recording() as never));
    expect(bytes.endsWith('}\n')).toBe(true);
    expect(bytes).not.toContain('\r');
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Same logical content built with a different key insertion order serializes identically.
    const r = recording();
    const shuffled = reverseKeys(r) as ScenarioRecording;
    expect(Object.keys(shuffled)).toEqual(Object.keys(r).reverse());
    const dir2 = await mkdtemp(join(tmpdir(), 'aibdd-rec2-'));
    try {
      await createRecordingStore({ dir: dir2, mode: 'read-write' }).save(shuffled);
      expect(await readFile(join(dir2, 'playwright', 'billing--upgrade-to-pro', 'user-upgrades.json'), 'utf8')).toBe(bytes);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('R-PL4: byte-identical save returns unchanged and does not rewrite the file; a change returns updated', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    expect(await store.save(recording())).toBe('created');
    fsCalls.mutating.length = 0;
    expect(await store.save(recording())).toBe('unchanged');
    expect(fsCalls.mutating).toEqual([]);
    const changed = recording({ scenarioFingerprint: sha256Hex('other') });
    expect(await store.save(changed)).toBe('updated');
    expect((await store.load('playwright', SCENARIO))?.scenarioFingerprint).toBe(sha256Hex('other'));
  });

  it('R-CH6: read-only mode never writes: save throws RECORDING_READ_ONLY, no fs mutation, no directory created', async () => {
    const root = join(dir, 'recs');
    const store = createRecordingStore({ dir: root, mode: 'read-only' });
    await expect(store.save(recording())).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    await expect(store.remove('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    expect(fsCalls.mutating).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('R-CH6: read-only mode still reads existing recordings and never touches them', async () => {
    await createRecordingStore({ dir, mode: 'read-write' }).save(recording());
    const file = join(dir, 'playwright', 'billing--upgrade-to-pro', 'user-upgrades.json');
    const before = await readFile(file, 'utf8');
    fsCalls.mutating.length = 0;
    const ro = createRecordingStore({ dir, mode: 'read-only' });
    expect(await ro.load('playwright', SCENARIO)).toEqual(recording());
    await expect(ro.save(recording({ scenarioFingerprint: sha256Hex('x') }))).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    expect(await ro.list()).toEqual([{ driverId: 'playwright', scenarioId: SCENARIO }]);
    expect(fsCalls.mutating).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('R-CH6: off mode load returns null even when a file exists; save never writes', async () => {
    await createRecordingStore({ dir, mode: 'read-write' }).save(recording());
    fsCalls.mutating.length = 0;
    const off = createRecordingStore({ dir, mode: 'off' });
    expect(await off.load('playwright', SCENARIO)).toBeNull();
    expect(await off.list()).toEqual([]);
    await expect(off.save(recording())).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    expect(fsCalls.mutating).toEqual([]);
  });

  it('R-PL4: load returns null for a missing recording', async () => {
    expect(await createRecordingStore({ dir, mode: 'read-write' }).load('playwright', 'nope/missing')).toBeNull();
  });

  it('R-PL4: rejects unsafe driver ids and scenario ids (traversal, absolute, backslash, uppercase, empty segments)', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    const bad = ['../evil', 'a/../b', '/abs', 'a//b', 'a\\b', 'Upper', 'sp ace', '', '.', '..', 'a/.', 'a/b/', 'é', 'a\0b', 'a:b'];
    for (const id of bad) {
      await expect(store.load('playwright', id), `scenario ${JSON.stringify(id)}`).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.save(recording({ scenarioId: id })), `save ${JSON.stringify(id)}`).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    for (const driver of ['..', '../x', 'a/b', 'Play', '']) {
      await expect(store.load(driver, SCENARIO), `driver ${JSON.stringify(driver)}`).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(store.save(recording({ driver: { id: driver, major: 1 } }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('R-PL4: allows the full safe alphabet [a-z0-9._-] including the "--" feature separator', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    const id = 'docs-billing--plan.v2_x/scenario-1';
    expect(await store.save(recording({ scenarioId: id }))).toBe('created');
    expect((await store.load('playwright', id))?.scenarioId).toBe(id);
  });

  it('R-CH4: RECORDING_CORRUPT for invalid JSON, schema violations, wrong schemaVersion and identity mismatch', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    const file = join(dir, 'playwright', 'billing--upgrade-to-pro', 'user-upgrades.json');
    await mkdir(join(dir, 'playwright', 'billing--upgrade-to-pro'), { recursive: true });

    await writeFile(file, '{ not json');
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });

    await writeFile(file, '{"schemaVersion":1}');
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });

    await writeFile(file, JSON.stringify({ ...recording(), schemaVersion: 2 }));
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });

    const badAction = recording();
    (badAction.steps[0]?.act?.actions as unknown[]).push({ verb: 'teleport' });
    await writeFile(file, JSON.stringify(badAction));
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });

    await writeFile(file, JSON.stringify(recording({ scenarioId: 'other/id' })));
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });

    await writeFile(file, JSON.stringify(recording({ driver: { id: 'fake', major: 1 } })));
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });

    await writeFile(file, '');
    await expect(store.load('playwright', SCENARIO)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });
  });

  it('R-PL4: refuses to save a schema-invalid recording', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    const broken = recording({ scenarioFingerprint: 'not-a-sha' });
    await expect(store.save(broken)).rejects.toMatchObject({ code: 'RECORDING_CORRUPT' });
    expect(fsCalls.mutating).toEqual([]);
  });

  it('R-PL4: list is sorted and maps nested directories back to scenario ids; remove deletes and prunes empty directories', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    await store.save(recording({ scenarioId: 'b--x/two' }));
    await store.save(recording({ scenarioId: 'a--x/one' }));
    await store.save(recording({ scenarioId: 'a--x/two', driver: { id: 'fake', major: 1 } }));
    await writeFile(join(dir, 'playwright', 'README.txt'), 'ignored');
    expect(await store.list()).toEqual([
      { driverId: 'fake', scenarioId: 'a--x/two' },
      { driverId: 'playwright', scenarioId: 'a--x/one' },
      { driverId: 'playwright', scenarioId: 'b--x/two' },
    ]);
    await store.remove('fake', 'a--x/two');
    expect(existsSync(join(dir, 'fake'))).toBe(false);
    await store.remove('fake', 'a--x/two'); // idempotent
    expect((await store.list()).length).toBe(2);
    expect(await store.load('playwright', 'a--x/one')).not.toBeNull();
  });

  it('R-PL4: list on a missing directory is empty', async () => {
    expect(await createRecordingStore({ dir: join(dir, 'nothing'), mode: 'read-write' }).list()).toEqual([]);
  });

  it('R-CH2: round-trips a heal-count and fuzzy reasons exactly', async () => {
    const store = createRecordingStore({ dir, mode: 'read-write' });
    const r = recording();
    const first = r.steps[0];
    if (first === undefined) throw new Error('fixture');
    first.determinism = 'fuzzy';
    first.fuzzyReasons = ['heal-threshold', 'no-observable-effect'];
    first.stats = { healCount: 2 };
    await store.save(r);
    expect(await store.load('playwright', SCENARIO)).toEqual(r);
  });
});
