import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.ts';
describe('Storage release boundaries', () => {
  it('rejects a newer schema without downgrading its version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-schema-')),
      file = join(dir, 'future.sqlite');
    try {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA user_version=2');
      db.close();
      expect(() => new Store(file)).toThrow(/newer Studio version/);
      const check = new DatabaseSync(file);
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      check.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects a second writer and releases its lock on close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-lock-')),
      file = join(dir, 'studio.sqlite');
    const first = new Store(file);
    try {
      expect(() => new Store(file)).toThrow(/lock|busy/i);
    } finally {
      first.close();
    }
    try {
      const next = new Store(file);
      expect(next.one('PRAGMA integrity_check').integrity_check).toBe('ok');
      next.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
