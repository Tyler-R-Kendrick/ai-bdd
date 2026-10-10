import { access, constants, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AiBddError, type ResolvedConfig } from '../contracts/index.ts';
import { assertInsideRealRoot, toPosix } from '../util/index.ts';
import { errorMessage } from './util.ts';

export type OutputDir = 'plans' | 'recordings' | 'runs' | 'cache';

function dirOf(config: ResolvedConfig, which: OutputDir): string {
  switch (which) {
    case 'plans':
      return config.planDir;
    case 'recordings':
      return config.recordingsDir;
    case 'runs':
      return config.runsDir;
    case 'cache':
      return config.cacheDir;
  }
}

function why(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOTDIR') return 'a parent of it is not a directory';
  if (code === 'ELOOP') return 'it is part of a symlink loop';
  return errorMessage(err);
}

/** The directory itself, or the nearest existing ancestor (where it would be created). */
async function nearestExisting(dir: string): Promise<string> {
  let cur = dir;
  for (;;) {
    try {
      await stat(cur);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

async function check(which: OutputDir, dir: string, write: boolean): Promise<void> {
  const where = `${which} directory ${toPosix(dir)}`;
  const unusable = (err: unknown): AiBddError =>
    new AiBddError('CONFIG_INVALID', `the ${where} cannot be used: ${why(err)}`, { details: { dir: toPosix(dir), kind: which }, cause: err });
  try {
    await assertInsideRealRoot(dir); // POLICY_DENIED when a symlink leads out of the project
  } catch (err) {
    throw err instanceof AiBddError ? err : unusable(err);
  }
  let info;
  try {
    info = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw unusable(err);
    // created on first write: the nearest existing ancestor must then be writable
    if (write) {
      const ancestor = await nearestExisting(dir);
      try {
        await access(ancestor, constants.W_OK);
      } catch (accessErr) {
        const reason = (accessErr as NodeJS.ErrnoException).code === 'EROFS' ? 'it would be created on a read-only file system' : 'it cannot be created (the parent is not writable)';
        throw new AiBddError('CONFIG_INVALID', `the ${where} cannot be used: ${reason}`, { details: { dir: toPosix(dir), kind: which }, cause: accessErr });
      }
    }
    return;
  }
  if (!info.isDirectory()) {
    throw new AiBddError('CONFIG_INVALID', `the ${where} exists but is not a directory`, { details: { dir: toPosix(dir), kind: which } });
  }
  if (write) {
    try {
      await access(dir, constants.W_OK);
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === 'EROFS' ? 'it is on a read-only file system' : 'it is not writable';
      throw new AiBddError('CONFIG_INVALID', `the ${where} cannot be used: ${reason}`, { details: { dir: toPosix(dir), kind: which }, cause: err });
    }
  }
}

/**
 * Fails fast, before any model call or write, when an output directory is unusable: a file or a symlink loop where a directory
 * belongs (`CONFIG_INVALID`), or a symlink that leads out of the project (`POLICY_DENIED`). Both are exit 2 with a message that
 * names the directory, instead of an `ENOTDIR` internal error or a scenario that fails after all its model calls were spent.
 * Directories in `writes` must also be writable (a read-only file system, missing permission), also checked up front.
 */
export async function assertOutputDirs(config: ResolvedConfig, which: readonly OutputDir[], writes: readonly OutputDir[] = []): Promise<void> {
  for (const w of which) {
    if (w === 'recordings' && config.recordingsMode === 'off') continue;
    // recordings are only written in read-write mode (CI keeps them read-only on purpose)
    const write = writes.includes(w) && !(w === 'recordings' && config.recordingsMode !== 'read-write');
    await check(w, dirOf(config, w), write);
  }
}
