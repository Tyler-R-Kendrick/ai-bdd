import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  devFullUnavailableReason,
  diffSnapshots,
  findTempLeftovers,
  linkToDevFull,
  lockDirectory,
  makeOutsideDir,
  mountTinyTmpfs,
  raceStart,
  removePath,
  replaceWithFile,
  replaceWithSymlink,
  snapshotTree,
  symlinkEscape,
  symlinkLoop,
} from '@ai-bdd/testing';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chaos-fs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('replacing paths', () => {
  it('replaceWithFile turns a populated directory into a regular file and creates missing parents', () => {
    mkdirSync(join(root, 'plans', 'deep'), { recursive: true });
    writeFileSync(join(root, 'plans', 'deep', 'a.json'), '{}');
    replaceWithFile(join(root, 'plans'));
    expect(lstatSync(join(root, 'plans')).isFile()).toBe(true);
    expect(readFileSync(join(root, 'plans'), 'utf8')).toBe('not a directory\n');
    replaceWithFile(join(root, 'new', 'nested', 'x'), 'custom');
    expect(readFileSync(join(root, 'new', 'nested', 'x'), 'utf8')).toBe('custom');
  });

  it('replaceWithSymlink and symlinkEscape leave a link, not a directory, pointing where asked', () => {
    mkdirSync(join(root, 'runs'));
    const outside = makeOutsideDir();
    try {
      expect(symlinkEscape(join(root, 'runs'), outside)).toBe(outside);
      expect(lstatSync(join(root, 'runs')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(root, 'runs'))).toBe(outside);
      replaceWithSymlink(join(root, 'dangling'), 'does-not-exist');
      expect(readlinkSync(join(root, 'dangling'))).toBe('does-not-exist');
      expect(existsSync(join(root, 'dangling'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('symlinkLoop makes every access fail with ELOOP', () => {
    symlinkLoop(join(root, 'loop'));
    expect(lstatSync(join(root, 'loop')).isSymbolicLink()).toBe(true);
    expect(() => readdirSync(join(root, 'loop'))).toThrow(/ELOOP/);
    expect(() => writeFileSync(join(root, 'loop', 'x'), '')).toThrow(/ELOOP/);
    symlinkLoop(join(root, 'loop')); // idempotent: rebuilding an existing loop works
    removePath(join(root, 'loop'));
    removePath(join(root, 'loop.loop'));
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('lockDirectory', () => {
  it('reports honestly whether the mode change binds this process, and restores the mode', () => {
    const dir = join(root, 'locked');
    mkdirSync(dir, { mode: 0o755 });
    const lock = lockDirectory(dir);
    try {
      if (lock.effective) {
        expect(() => writeFileSync(join(dir, 'x'), '')).toThrow(/EACCES|EPERM/);
        expect(lock.reason).toBeUndefined();
      } else {
        expect(lock.reason).toMatch(/root|ignores/);
        writeFileSync(join(dir, 'x'), ''); // not enforced: tests must not pretend it was
      }
    } finally {
      lock.restore();
    }
    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
    writeFileSync(join(dir, 'y'), '');
  });

  it('is never effective for root', () => {
    if (process.getuid?.() !== 0) return;
    const dir = join(root, 'locked-root');
    mkdirSync(dir);
    const lock = lockDirectory(dir);
    lock.restore();
    expect(lock.effective).toBe(false);
    expect(lock.reason).toContain('root');
  });
});

describe('disk-full emulation', () => {
  it('mountTinyTmpfs either gives a real ENOSPC or says exactly why it cannot', () => {
    const dir = join(root, 'tiny');
    const mount = mountTinyTmpfs(dir, 16);
    if (!mount.ok) {
      expect(mount.reason.length).toBeGreaterThan(5);
      return;
    }
    try {
      expect(() => writeFileSync(join(dir, 'big.bin'), Buffer.alloc(256 * 1024))).toThrow(/ENOSPC/);
      rmSync(join(dir, 'big.bin')); // the failed write left a partial file that filled the device
      writeFileSync(join(dir, 'small.txt'), 'fits'); // the file system is still usable once there is room
    } finally {
      mount.unmount();
    }
    expect(existsSync(join(dir, 'small.txt'))).toBe(false);
  });

  it('remountReadOnly turns the same mount into a read-only file system (EROFS, even for root)', () => {
    const dir = join(root, 'ro');
    const mount = mountTinyTmpfs(dir, 16);
    if (!mount.ok) {
      expect(mount.reason.length).toBeGreaterThan(5);
      return;
    }
    try {
      writeFileSync(join(dir, 'before.txt'), 'writable at first');
      mount.remountReadOnly();
      expect(() => writeFileSync(join(dir, 'after.txt'), 'x')).toThrow(/EROFS/);
      expect(readFileSync(join(dir, 'before.txt'), 'utf8')).toBe('writable at first');
    } finally {
      mount.unmount();
    }
  });

  it('mountTinyTmpfs refuses with a reason when not root', () => {
    if (process.getuid?.() === 0 && process.platform === 'linux') return;
    const r = mountTinyTmpfs(join(root, 'nope'));
    expect(r.ok).toBe(false);
  });

  it('linkToDevFull makes appends fail with ENOSPC (when /dev/full exists)', () => {
    const reason = devFullUnavailableReason();
    if (reason !== null) {
      expect(() => linkToDevFull(join(root, 'events.jsonl'))).toThrow(reason);
      return;
    }
    const file = join(root, 'out', 'events.jsonl');
    linkToDevFull(file);
    expect(() => appendFileSync(file, 'x'.repeat(10))).toThrow(/ENOSPC/);
  });
});

describe('raceStart', () => {
  it('starts all tasks together and reports each outcome', async () => {
    const order: string[] = [];
    const results = await raceStart([
      async () => {
        order.push('a:start');
        await Promise.resolve();
        order.push('a:end');
        return 1;
      },
      async () => {
        order.push('b:start');
        throw new Error('b failed');
      },
      async () => {
        order.push('c:start');
        return 3;
      },
    ]);
    expect(order.slice(0, 3)).toEqual(['a:start', 'b:start', 'c:start']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('b failed');
  });
});

describe('snapshots', () => {
  it('records files by hash, directories and links without following them, and diffs two snapshots', () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'one.txt'), '1');
    writeFileSync(join(root, 'a', 'b', 'two.txt'), '2');
    replaceWithSymlink(join(root, 'link'), '/nowhere');
    const before = snapshotTree(root);
    expect([...before.keys()].sort()).toEqual(['a', join('a', 'b'), join('a', 'b', 'two.txt'), join('a', 'one.txt'), 'link']);
    expect(before.get('a')).toBe('dir');
    expect(before.get('link')).toBe('link:/nowhere');
    expect(before.get(join('a', 'one.txt'))).toMatch(/^file:[0-9a-f]{64}$/);

    writeFileSync(join(root, 'a', 'one.txt'), 'changed');
    rmSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'new.txt'), 'n');
    const diff = diffSnapshots(before, snapshotTree(root));
    expect(diff).toEqual({ added: ['new.txt'], removed: [join('a', 'b'), join('a', 'b', 'two.txt')].sort(), changed: [join('a', 'one.txt')] });
    expect(diffSnapshots(before, before)).toEqual({ added: [], removed: [], changed: [] });
    expect(snapshotTree(join(root, 'missing')).size).toBe(0);
  });

  it('findTempLeftovers lists .tmp files (and only files) below a root', () => {
    mkdirSync(join(root, 'plans', 'x'), { recursive: true });
    writeFileSync(join(root, 'plans', 'x', 'a.plan.json.123.uuid.tmp'), '{');
    writeFileSync(join(root, 'plans', 'a.plan.json'), '{}');
    mkdirSync(join(root, 'plans', 'dir.tmp'));
    expect(findTempLeftovers(join(root, 'plans'))).toEqual([join(root, 'plans', 'x', 'a.plan.json.123.uuid.tmp')]);
    expect(findTempLeftovers(join(root, 'plans'), '.json')).toEqual([join(root, 'plans', 'a.plan.json')]);
    expect(findTempLeftovers(join(root, 'nothing'))).toEqual([]);
  });
});
