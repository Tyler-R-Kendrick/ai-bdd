import { stat } from 'node:fs/promises';
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

async function check(which: OutputDir, dir: string): Promise<void> {
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // created on first write
    throw unusable(err);
  }
  if (!info.isDirectory()) {
    throw new AiBddError('CONFIG_INVALID', `the ${where} exists but is not a directory`, { details: { dir: toPosix(dir), kind: which } });
  }
}

/**
 * Fails fast, before any model call or write, when an output directory is unusable: a file or a symlink loop where a directory
 * belongs (`CONFIG_INVALID`), or a symlink that leads out of the project (`POLICY_DENIED`). Both are exit 2 with a message that
 * names the directory, instead of an `ENOTDIR` internal error or a scenario that fails after all its model calls were spent.
 */
export async function assertOutputDirs(config: ResolvedConfig, which: readonly OutputDir[]): Promise<void> {
  for (const w of which) {
    if (w === 'recordings' && config.recordingsMode === 'off') continue;
    await check(w, dirOf(config, w));
  }
}
