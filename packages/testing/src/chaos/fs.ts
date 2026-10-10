// Filesystem hostility for chaos tests. Nothing here mocks `fs`: every helper changes the REAL file system under a directory the
// test owns (replaces a directory with a file, builds symlink loops, mounts a tiny tmpfs, ...), so the code under test meets
// exactly what a hostile or broken machine would hand it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Remove whatever is at `path` (file, symlink or directory tree) without following links. */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Replace `path` (typically a directory such as `.ai-bdd/plans`) with a regular file. Parent directories are created. */
export function replaceWithFile(path: string, content = 'not a directory\n'): void {
  removePath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Replace `path` with a symlink to `target` (absolute, or relative to the link's directory). The target need not exist. */
export function replaceWithSymlink(path: string, target: string): void {
  removePath(path);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

/** Replace `path` with a symlink to a directory OUTSIDE the project (the target directory is created). Returns the target. */
export function symlinkEscape(path: string, outsideDir: string): string {
  mkdirSync(outsideDir, { recursive: true });
  replaceWithSymlink(path, outsideDir);
  return outsideDir;
}

/** Replace `path` with a symlink cycle (`path` -> `path.loop` -> `path`): every access fails with ELOOP. */
export function symlinkLoop(path: string): void {
  removePath(path);
  removePath(`${path}.loop`);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(`${path}.loop`, path);
  symlinkSync(path, `${path}.loop`);
}

export interface PermissionLock {
  /** False when the lock cannot bind this process (running as root, or the platform ignores modes): nothing was proven. */
  effective: boolean;
  reason?: string;
  restore(): void;
}

/**
 * Make a directory unwritable (mode 0555) and report whether that really stops THIS process from creating files in it.
 * Running as root, or on a file system that ignores modes, `effective` is false and tests must use another mechanism.
 */
export function lockDirectory(dir: string): PermissionLock {
  const previous = lstatSync(dir).mode & 0o777;
  chmodSync(dir, 0o555);
  const restore = (): void => chmodSync(dir, previous === 0 ? 0o755 : previous);
  const probe = join(dir, `.chaos-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return { effective: false, reason: process.getuid?.() === 0 ? 'running as root: chmod does not restrict root' : 'the file system ignores directory modes', restore };
  } catch {
    return { effective: true, restore };
  }
}

export type MountResult = { ok: true; dir: string; unmount(): void; /** Remount the file system read-only: every write fails with EROFS, even for root. */ remountReadOnly(): void } | { ok: false; reason: string };

/**
 * Mount a tiny tmpfs at `dir` (created if needed) to get a REAL "No space left on device". Needs root (or CAP_SYS_ADMIN) and
 * Linux; anywhere else it returns `{ ok: false, reason }` and the test should skip with that reason visible.
 */
export function mountTinyTmpfs(dir: string, sizeKiB = 16): MountResult {
  if (process.platform !== 'linux') return { ok: false, reason: `tmpfs mounts are only attempted on linux (platform is ${process.platform})` };
  if (process.getuid?.() !== 0) return { ok: false, reason: 'mounting a tmpfs needs root (uid 0)' };
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', `size=${sizeKiB}k`, 'tmpfs', dir], { stdio: 'pipe' });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString('utf8').trim();
    return { ok: false, reason: `mount refused: ${stderr || (err instanceof Error ? err.message : String(err))}` };
  }
  return {
    ok: true,
    dir,
    remountReadOnly() {
      execFileSync('mount', ['-o', 'remount,ro', dir], { stdio: 'pipe' });
    },
    unmount() {
      try {
        execFileSync('umount', [dir], { stdio: 'pipe' });
      } catch {
        execFileSync('umount', ['-l', dir], { stdio: 'pipe' });
      }
    },
  };
}

/** Why `/dev/full` (a device whose every write fails with ENOSPC) cannot be used here, or null when it can. */
export function devFullUnavailableReason(): string | null {
  if (process.platform !== 'linux') return `/dev/full is linux-only (platform is ${process.platform})`;
  return existsSync('/dev/full') ? null : '/dev/full does not exist';
}

/** Make writes through `path` fail with ENOSPC by pointing it at `/dev/full`. Appends and in-place writes hit it; a rename over it replaces the link. */
export function linkToDevFull(path: string): void {
  const reason = devFullUnavailableReason();
  if (reason !== null) throw new Error(reason);
  replaceWithSymlink(path, '/dev/full');
}

/** A throw-away directory OUTSIDE the repository (for "did anything escape the project" checks). */
export function makeOutsideDir(prefix = 'ai-bdd-chaos-outside-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Starts every task at the same moment (after a shared microtask barrier) and waits for all of them. Rejections are reported,
 * not thrown, so a test can assert on each writer's outcome.
 */
export async function raceStart<T>(tasks: readonly (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = tasks.map(async (task) => {
    await gate;
    return task();
  });
  release();
  return Promise.allSettled(running);
}

/** Entry of a {@link snapshotTree}: `file:<sha256>`, `dir`, or `link:<target>`. Symlinks are never followed. */
export type TreeEntry = string;

/** Hash every entry under `root` without following symlinks. Missing root gives an empty snapshot; entries that vanish mid-walk are skipped. */
export function snapshotTree(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(full)}`);
        else if (st.isDirectory()) {
          out.set(rel, 'dir');
          walk(full);
        } else out.set(rel, `file:${sha(readFileSync(full))}`);
      } catch (err) {
        // an entry that vanished while we walked (a live tree being written to by another process) is simply not there
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  };
  walk(root);
  return out;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffSnapshots(before: ReadonlyMap<string, TreeEntry>, after: ReadonlyMap<string, TreeEntry>): TreeDiff {
  const diff: TreeDiff = { added: [], removed: [], changed: [] };
  for (const [path, entry] of after) {
    const was = before.get(path);
    if (was === undefined) diff.added.push(path);
    else if (was !== entry) diff.changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) diff.removed.push(path);
  return diff;
}

/** Files under `root` whose name ends with `.tmp` (leftovers of interrupted atomic writes). Does not follow symlinks. */
export function findTempLeftovers(root: string, suffix = '.tmp'): string[] {
  return [...snapshotTree(root).entries()]
    .filter(([path, entry]) => entry.startsWith('file:') && path.endsWith(suffix))
    .map(([path]) => join(root, path))
    .sort();
}
