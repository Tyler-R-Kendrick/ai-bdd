import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  lstat,
  realpath,
  open,
  rm,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const execute = promisify(execFile);
export class MachineTransportError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
export const retryable = (error: unknown) =>
  !(error instanceof MachineTransportError) ||
  error.status === 408 ||
  error.status === 425 ||
  error.status === 429 ||
  error.status >= 500;
export const reasonCode = (error: unknown) =>
  error instanceof MachineTransportError
    ? `HTTP ${error.status}`
    : typeof (error as any)?.cause?.code === 'string'
      ? String((error as any).cause.code).slice(0, 40)
      : 'NETWORK_ERROR';
export async function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('Aborted'));
      },
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        done();
      }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function reconnect<T>(
  operation: () => Promise<T>,
  options: {
    signal?: AbortSignal;
    maxElapsedMs?: number;
    maxDelayMs?: number;
    onStatus?: (
      event: 'lost' | 'retry' | 'restored',
      attempt: number,
      code: string,
    ) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
) {
  const started = Date.now();
  let attempt = 0,
    last = '';
  while (true) {
    options.signal?.throwIfAborted();
    try {
      const value = await operation();
      if (attempt) options.onStatus?.('restored', attempt, last);
      return value;
    } catch (error) {
      if (
        options.signal?.aborted ||
        !retryable(error) ||
        Date.now() - started >= (options.maxElapsedMs ?? 600000)
      )
        throw error;
      last = reasonCode(error);
      attempt++;
      options.onStatus?.(attempt === 1 ? 'lost' : 'retry', attempt, last);
      await (options.sleep ?? pause)(
        Math.random() *
          Math.min(
            options.maxDelayMs ?? 300000,
            1000 * 2 ** Math.min(attempt - 1, 19),
          ),
        options.signal,
      );
    }
  }
}
export async function privateJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp',
    handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
export async function readPrivateJson(
  file: string,
  maxBytes = 2 * 1024 * 1024,
) {
  const meta = await lstat(file);
  if (
    !meta.isFile() ||
    meta.isSymbolicLink() ||
    meta.size > maxBytes ||
    (meta.mode & 0o077) !== 0 ||
    (process.getuid && meta.uid !== process.getuid())
  )
    throw new Error(
      'The connector state file must be bounded and private to the current OS user',
    );
  return JSON.parse(await readFile(file, 'utf8'));
}
export const pendingSchema = z
  .object({
    version: z.literal(1),
    workId: z.string().uuid(),
    generation: z.number().int().positive(),
    route: z
      .string()
      .regex(
        /^\/machines\/[0-9a-f-]{36}\/investigations\/[0-9a-f-]{36}\/(?:complete|fail)$/,
      ),
    body: z.record(z.string(), z.json()),
    phase: z.enum(['started', 'report']),
    worktree: z.string(),
  })
  .strict();
export type PendingReport = z.infer<typeof pendingSchema>;
export class DurableMachineReports {
  constructor(readonly directory: string) {}
  path(id: string) {
    return join(this.directory, z.string().uuid().parse(id) + '.json');
  }
  async save(value: PendingReport) {
    await privateJson(this.path(value.workId), pendingSchema.parse(value));
  }
  async read(id: string) {
    return pendingSchema.parse(await readPrivateJson(this.path(id)));
  }
  async clear(id: string) {
    await rm(this.path(id), { force: true });
  }
}
const normalizeRepository = (value: string) =>
  value
    .trim()
    .replace(/^git@github.com:/, 'https://github.com/')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
export async function inspectCheckout(cwd: string) {
  const root = await realpath(cwd);
  const options = { cwd: root, timeout: 15000, maxBuffer: 8192 };
  const remote = normalizeRepository(
    (
      await execute(
        'git',
        ['-c', 'core.fsmonitor=false', 'remote', 'get-url', 'origin'],
        options,
      )
    ).stdout,
  );
  if (!/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(remote))
    throw new Error('Select a checkout with a github.com origin remote');
  const sourceCommit = (
    await execute(
      'git',
      ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'],
      options,
    )
  ).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit))
    throw new Error('The local checkout does not have a full Git commit');
  const branch = (
    await execute(
      'git',
      ['-c', 'core.fsmonitor=false', 'branch', '--show-current'],
      options,
    )
  ).stdout.trim();
  return { root, repository: remote, sourceCommit, branch };
}
export async function prepareWorktree(input: {
  cwd: string;
  stateDirectory: string;
  workId: string;
  generation: number;
  repository: string;
  sourceCommit: string;
  spike?: boolean;
}) {
  const checkout = await inspectCheckout(input.cwd);
  if (checkout.repository !== normalizeRepository(input.repository))
    throw new Error(
      'The approved repository does not match this machine checkout',
    );
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error('An investigation requires an exact full Git commit');
  const state = await realpath(
      await mkdir(resolve(input.stateDirectory), {
        recursive: true,
        mode: 0o700,
      }).then(() => resolve(input.stateDirectory)),
    ),
    hooks = join(state, 'empty-hooks');
  await mkdir(hooks, { recursive: true, mode: 0o700 });
  const git = [
    '-c',
    'core.hooksPath=' + hooks,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'submodule.recurse=false',
  ];
  const options = { cwd: checkout.root, timeout: 30000, maxBuffer: 8192 };
  try {
    await execute(
      'git',
      [...git, 'cat-file', '-e', input.sourceCommit + '^{commit}'],
      options,
    );
  } catch {
    await execute(
      'git',
      [
        ...git,
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        input.sourceCommit,
      ],
      options,
    );
  }
  const path = join(
    state,
    'worktrees',
    z.string().uuid().parse(input.workId) +
      '-' +
      z.number().int().positive().parse(input.generation),
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await lstat(path);
    throw new Error(
      'An investigation worktree already exists. Uncertain local work is never executed again automatically.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await execute(
    'git',
    [...git, 'worktree', 'add', '--detach', path, input.sourceCommit],
    options,
  );
  if (input.spike) {
    await execute(
      'git',
      [...git, 'config', 'extensions.worktreeConfig', 'true'],
      options,
    );
    await execute(
      'git',
      [
        '-C',
        path,
        ...git,
        'config',
        '--worktree',
        'remote.origin.pushurl',
        'file:///dev/null',
      ],
      options,
    );
    await execute(
      'git',
      ['-C', path, ...git, 'config', '--worktree', 'core.hooksPath', hooks],
      options,
    );
    await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n', {
      mode: 0o700,
    });
  }
  return {
    path,
    sourceCommit: input.sourceCommit,
    repository: checkout.repository,
    async cleanup() {
      if (input.spike)
        await execute(
          'git',
          [...git, 'worktree', 'remove', '--force', path],
          options,
        );
    },
  };
}
export async function localImage(worktree: string, file: string) {
  const root = await realpath(worktree),
    requested = resolve(root, file),
    actual = await realpath(requested),
    within = relative(root, actual);
  if (
    actual !== requested ||
    within === '..' ||
    within.startsWith('..' + sep) ||
    isAbsolute(within)
  )
    throw new Error(
      'Investigation images must be regular files inside their own worktree, without symlinks',
    );
  const meta = await lstat(actual);
  if (!meta.isFile() || meta.size > 1048576)
    throw new Error(
      'Investigation screenshots must be regular files no larger than 1 MiB',
    );
  const bytes = await readFile(actual);
  const mime = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216
      ? 'image/jpeg'
      : bytes.subarray(0, 4).toString() === 'RIFF' &&
          bytes.subarray(8, 12).toString() === 'WEBP'
        ? 'image/webp'
        : null;
  if (!mime)
    throw new Error('Investigation screenshots must be PNG, JPEG or WebP');
  return {
    mime,
    base64: bytes.toString('base64'),
    name: actual.split(sep).pop()!,
  };
}
