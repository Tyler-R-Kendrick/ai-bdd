import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lockKey } from '@ai-bdd/contracts';
import { LockStore, kindClassOf } from '../../src/index.js';
import { makeEntry, tempDir } from '../helpers/index.js';

const NOW = (): Date => new Date('2024-01-01T00:00:00.000Z');

function store(path: string): LockStore {
  return LockStore.empty(path, { now: NOW });
}

describe('kindClassOf (R-K7)', () => {
  it('maps kind sources to dialect-independent classes', () => {
    expect(kindClassOf('directive')).toBe('directive');
    expect(kindClassOf('keyword')).toBe('explicit-keyword');
    expect(kindClassOf('binding')).toBe('declared-binding');
    expect(kindClassOf('prefix')).toBe('inferred');
    expect(kindClassOf('default')).toBe('inferred');
  });

  it('produces the same lock key for equal text/kind/kindClass and a different one otherwise', () => {
    const base = { normalizedStepText: 'the user opens the page', kind: 'action', kindClass: 'inferred' };
    expect(lockKey(base)).toBe(lockKey({ ...base }));
    expect(lockKey(base)).not.toBe(lockKey({ ...base, kindClass: 'explicit-keyword' }));
    expect(lockKey(base)).not.toBe(lockKey({ ...base, kind: 'setup' }));
  });
});

describe('LockStore (R-K5f)', () => {
  it('loads an empty store when the file is missing', () => {
    const lock = LockStore.load(join(tempDir('lock-'), 'resolution.lock.json'));
    expect(lock.entries()).toEqual([]);
  });

  it('sorts entries by key and counts summary buckets', () => {
    const lock = store(join(tempDir('lock-'), 'resolution.lock.json'));
    lock.upsert(makeEntry('b'));
    lock.upsert(makeEntry('a'));
    lock.upsert(makeEntry('a'));
    expect(lock.entries().map((entry) => entry.key)).toEqual(['a', 'b']);
    const summary = lock.summary();
    expect(summary.added).toBe(2);
    expect(summary.unchanged).toBe(1);
  });

  it('serializes deterministically (byte-stable across two runs)', async () => {
    const path = join(tempDir('lock-'), 'resolution.lock.json');
    const lock = store(path);
    lock.upsert(makeEntry('b', { status: 'semantic' }));
    lock.upsert(makeEntry('a'));
    await lock.save();
    const first = readFileSync(path, 'utf8');

    const reloaded = LockStore.load(path, { now: NOW });
    await reloaded.save();
    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('normalizes CRLF input to LF output', async () => {
    const path = join(tempDir('lock-'), 'resolution.lock.json');
    const lock = store(path);
    lock.upsert(makeEntry('a'));
    lock.upsert(makeEntry('b'));
    await lock.save();
    const lf = readFileSync(path, 'utf8');

    writeFileSync(path, lf.replace(/\n/gu, '\r\n'));
    const reloaded = LockStore.load(path, { now: NOW });
    await reloaded.save();
    expect(readFileSync(path, 'utf8')).toBe(lf);
  });

  it('does not lose entries when four workers save concurrently', async () => {
    const path = join(tempDir('lock-'), 'resolution.lock.json');
    const keys = ['w1', 'w2', 'w3', 'w4'];
    const stores = keys.map((key) => {
      const worker = store(path);
      worker.upsert(makeEntry(key));
      return worker;
    });
    await Promise.all(stores.map((worker) => worker.save()));
    const merged = LockStore.load(path, { now: NOW });
    expect(merged.entries().map((entry) => entry.key).sort()).toEqual([...keys].sort());
  });

  it('round-trips a semantic entry through JSON', async () => {
    const path = join(tempDir('lock-'), 'resolution.lock.json');
    const lock = store(path);
    lock.upsert(
      makeEntry('a', {
        status: 'semantic',
        resolution: {
          type: 'semantic',
          bindingId: 'ts:local#a',
          bindingHash: 'hash-a',
          params: { count: 3 },
          score: 0.9,
          margin: 0.2,
          candidates: [{ bindingId: 'ts:local#a', bindingHash: 'hash-a', score: 0.9 }],
          extraction: { modelId: 'fake', promptVersion: 'extract-v1', raw: { count: 3 }, validated: true },
        },
      }),
    );
    await lock.save();
    const reloaded = LockStore.load(path, { now: NOW });
    const entry = reloaded.get('a');
    expect(entry?.status).toBe('semantic');
    expect(entry?.resolution).toEqual(lock.get('a')?.resolution);
  });
});
