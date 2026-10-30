import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inspectCheckout } from './runtime.ts';
const execute = promisify(execFile);

export function canonicalCloneRepository(value: string) {
  const url = value
    .replace(/\.git\/?$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  const match = /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/.exec(
    url,
  );
  if (
    value.length > 300 ||
    !match ||
    match
      .slice(1)
      .some((part) => part === '.' || part === '..' || part!.startsWith('-'))
  )
    throw new Error(
      'Clone repositories must be canonical https://github.com/owner/name URLs without credentials or query parameters',
    );
  return url;
}

export async function managedClone(
  repository: string,
  root: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  repository = canonicalCloneRepository(repository);
  if (!isAbsolute(root))
    throw new Error('The managed clone root must be absolute');
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new Error(
      'The managed clone root must be a private, operator-owned directory without symlinks',
    );
  if ((await realpath(root)) !== root)
    throw new Error('The managed clone root must not traverse symlinks');
  const key =
    'clone-' +
    createHash('sha256').update(repository).digest('hex').slice(0, 32);
  const path = join(root, key);
  const reuse = async () => {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await realpath(path)) !== path
    )
      throw new Error(
        'A managed clone path was replaced; review it before continuing',
      );
    const checkout = await inspectCheckout(path);
    if (checkout.repository !== repository)
      throw new Error(
        'A managed clone origin changed; review it before continuing',
      );
    return { key, path, checkout };
  };
  try {
    return await reuse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lockPath = join(root, '.' + key + '.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error(
      'This managed clone is locked; confirm no connector is cloning it before removing its named lock',
    );
  });
  const staging = join(root, '.' + key + '-' + randomUUID());
  try {
    // No checkout, submodule, hook or remote-supplied command is executed. Git
    // authentication stays with the operator's ordinary local credential helper.
    const childEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
    for (const name of Object.keys(childEnv))
      if (name.startsWith('STUDIO_')) delete childEnv[name];
    await execute(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.ext.allow=never',
        'clone',
        '--no-checkout',
        '--no-hardlinks',
        '--no-recurse-submodules',
        '--config',
        'core.hooksPath=/dev/null',
        '--config',
        'core.fsmonitor=false',
        repository + '.git',
        staging,
      ],
      { env: childEnv, signal, timeout: 120000, maxBuffer: 65536 },
    ).catch(() => {
      throw new Error(
        'The authorized repository could not be cloned; check local Git authentication and connectivity',
      );
    });
    const checkout = await inspectCheckout(staging);
    if (checkout.repository !== repository)
      throw new Error('The clone did not retain the authorized origin');
    await rename(staging, path);
    return await reuse();
  } finally {
    await rm(staging, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
