import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devFullUnavailableReason, linkToDevFull, lockDirectory, mountTinyTmpfs, snapshotTree } from '@ai-bdd/testing';

// The helpers adapt to the machine they run on (root or not, Linux or not). Their decisions are made through a host object, so
// every outcome is tested here on any machine instead of only on the one that happens to be configured that way.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chaos-hosts-'));
});
afterEach(() => {
  try {
    chmodSync(root, 0o755);
  } catch {
    // already gone
  }
  rmSync(root, { recursive: true, force: true });
});

describe('mountTinyTmpfs decisions', () => {
  const commands: string[][] = [];
  const exec = (cmd: string, args: string[]): void => void commands.push([cmd, ...args]);
  beforeEach(() => {
    commands.length = 0;
  });

  it('refuses outside Linux and without root, naming the reason, before touching anything', () => {
    expect(mountTinyTmpfs(join(root, 'm'), 16, { platform: 'darwin', uid: 0, exec })).toEqual({ ok: false, reason: 'tmpfs mounts are only attempted on linux (platform is darwin)' });
    expect(mountTinyTmpfs(join(root, 'm'), 16, { platform: 'linux', uid: 1000, exec })).toEqual({ ok: false, reason: 'mounting a tmpfs needs root (uid 0)' });
    expect(mountTinyTmpfs(join(root, 'm'), 16, { platform: 'linux', uid: undefined, exec })).toMatchObject({ ok: false });
    expect(commands).toEqual([]);
  });

  it('mounts a tmpfs of the requested size, can remount it read-only and unmount it', () => {
    const dir = join(root, 'm');
    const r = mountTinyTmpfs(dir, 8, { platform: 'linux', uid: 0, exec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lstatSync(dir).isDirectory()).toBe(true);
    r.remountReadOnly();
    r.unmount();
    expect(commands).toEqual([
      ['mount', '-t', 'tmpfs', '-o', 'size=8k', 'tmpfs', dir],
      ['mount', '-o', 'remount,ro', dir],
      ['umount', dir],
    ]);
  });

  it('falls back to a lazy unmount when the plain one fails', () => {
    const calls: string[][] = [];
    const flaky = (cmd: string, args: string[]): void => {
      calls.push([cmd, ...args]);
      if (cmd === 'umount' && !args.includes('-l')) throw new Error('target is busy');
    };
    const r = mountTinyTmpfs(join(root, 'm'), 16, { platform: 'linux', uid: 0, exec: flaky });
    if (!r.ok) throw new Error('expected a mount');
    r.unmount();
    expect(calls.slice(-2)).toEqual([['umount', join(root, 'm')], ['umount', '-l', join(root, 'm')]]);
  });

  it('reports why a mount was refused: the command stderr when there is one, else the error message', () => {
    const withStderr = (): void => {
      throw Object.assign(new Error('Command failed'), { stderr: Buffer.from('mount: permission denied\n') });
    };
    const bare = (): void => {
      throw new Error('spawn mount ENOENT');
    };
    const notAnError = (): void => {
      throw 'boom';
    };
    expect(mountTinyTmpfs(join(root, 'a'), 16, { platform: 'linux', uid: 0, exec: withStderr })).toEqual({ ok: false, reason: 'mount refused: mount: permission denied' });
    expect(mountTinyTmpfs(join(root, 'b'), 16, { platform: 'linux', uid: 0, exec: bare })).toEqual({ ok: false, reason: 'mount refused: spawn mount ENOENT' });
    expect(mountTinyTmpfs(join(root, 'c'), 16, { platform: 'linux', uid: 0, exec: notAnError })).toEqual({ ok: false, reason: 'mount refused: boom' });
  });
});

describe('lockDirectory outcomes', () => {
  it('is effective when the probe write is refused, and restores the previous mode', () => {
    const lock = lockDirectory(root, {
      write: () => {
        throw new Error('EACCES');
      },
    });
    expect(lock.effective).toBe(true);
    expect(lstatSync(root).mode & 0o777).toBe(0o555);
    lock.restore();
    expect(lstatSync(root).mode & 0o777).not.toBe(0o555);
  });

  it('is not effective when the probe write succeeds, and says whether root or the file system is the reason', () => {
    const asRoot = lockDirectory(root, { write: () => undefined, uid: 0 });
    expect(asRoot).toMatchObject({ effective: false, reason: 'running as root: chmod does not restrict root' });
    asRoot.restore();
    const ignored = lockDirectory(root, { write: () => undefined, uid: 1000 });
    expect(ignored).toMatchObject({ effective: false, reason: 'the file system ignores directory modes' });
    ignored.restore();
    const noUid = lockDirectory(root, { write: () => undefined, uid: undefined });
    expect(noUid.reason).toBe('the file system ignores directory modes');
    noUid.restore();
  });
});

describe('/dev/full', () => {
  it('is unavailable off Linux or when the device does not exist, and available otherwise', () => {
    expect(devFullUnavailableReason('win32', () => true)).toBe('/dev/full is linux-only (platform is win32)');
    expect(devFullUnavailableReason('linux', () => false)).toBe('/dev/full does not exist');
    expect(devFullUnavailableReason('linux', () => true)).toBeNull();
  });

  it('linkToDevFull refuses with the reason when the device cannot be used', () => {
    expect(() => linkToDevFull(join(root, 'x'), '/dev/full does not exist')).toThrow('/dev/full does not exist');
  });
});

describe('snapshotTree', () => {
  it('rethrows a failure that is not a vanished entry (a unix socket cannot be read as a file)', async () => {
    const socket = join(root, 'sock');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(() => snapshotTree(root)).toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
