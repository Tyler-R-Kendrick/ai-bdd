import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLocalMaintenance } from '../server/runtime/local-maintenance.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until<T>(
  read: () => Promise<T | undefined>,
  timeout = 7000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('Local recovery fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'studio-local-cycle-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return {
    database: join(dir, 'studio.sqlite'),
    receipt: join(dir, 'external.txt'),
    completion: join(dir, 'completed.json'),
  };
}
function processFixture(
  paths: Awaited<ReturnType<typeof fixture>>,
  mode: string,
) {
  const child = spawn(
    process.execPath,
    [
      '--conditions=source',
      '--import',
      'tsx',
      resolve(import.meta.dirname, 'fixtures/local-maintenance-process.ts'),
      mode,
      paths.database,
      paths.receipt,
      paths.completion,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, DO_NOT_TRACK: '1' },
    },
  );
  const messages: any[] = [];
  let errors = '';
  child.on('message', (message) => messages.push(message));
  child.stderr?.on('data', (chunk) => {
    errors += chunk.toString();
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  return { child, messages, errors: () => errors };
}
async function message(w: ReturnType<typeof processFixture>, type: string) {
  return until(async () => {
    const value = w.messages.find((row) => row.type === type);
    if (value) return value;
    if (w.child.exitCode !== null || w.child.signalCode !== null)
      throw new Error(w.errors());
    return undefined;
  });
}
async function terminate(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL') {
  const exited = once(child, 'exit');
  child.kill(signal);
  return exited;
}
it('never overlaps cycles, drains shutdown before further database work, and keeps recovery alive after a domain cleanup failure', async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0,
    recoveries = 0,
    flushes = 0;
  const loop = createLocalMaintenance({
    intervalMs: 5,
    maintenance: async () => {
      calls++;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    runtime: {
      recover: async () => {
        recoveries++;
      },
      flushOutbox: async () => {
        flushes++;
      },
    },
  });
  loop.start();
  await started;
  const repeated = loop.run();
  const stopping = loop.close();
  expect(calls).toBe(1);
  let closed = false;
  void stopping.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await repeated;
  await stopping;
  await loop.run();
  expect(calls).toBe(1);
  expect(recoveries).toBe(0);
  expect(flushes).toBe(0);
  const errors: unknown[] = [];
  const retry = createLocalMaintenance({
    maintenance: async () => {
      throw new Error('Explicit cleanup fixture failure');
    },
    runtime: {
      recover: async () => {
        recoveries++;
      },
      flushOutbox: async () => {
        flushes++;
      },
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  await retry.run();
  await retry.close();
  expect(errors).toHaveLength(1);
  expect(recoveries).toBe(1);
  expect(flushes).toBe(1);
});
it('recovers an unexpired-at-restart SQLite job after its lease actually expires in a replacement Node process without repeating an external receipt', async () => {
  const paths = await fixture(),
    first = processFixture(paths, 'seed');
  await message(first, 'claimed');
  await terminate(first.child, 'SIGKILL');
  const replacement = processFixture(paths, 'recover'),
    ready = await message(replacement, 'ready');
  expect(ready.before.status).toBe('running');
  expect(ready.before.lease_expires).toBeGreaterThan(Date.now());
  expect(ready.after).toEqual(ready.before);
  const result: any = await until(async () => {
    try {
      const row = JSON.parse(await readFile(paths.completion, 'utf8'));
      return row.status === 'completed' ? row : undefined;
    } catch {
      return undefined;
    }
  });
  expect(result.started_at).toBeGreaterThanOrEqual(ready.before.lease_expires);
  expect(result.attempts).toBe(2);
  expect(await readFile(paths.receipt, 'utf8')).toBe('external-effect\n');
  expect((await terminate(replacement.child, 'SIGTERM'))[0]).toBe(0);
});
it('a real Node SIGTERM waits for an in-flight maintenance callback before closing its database and process', async () => {
  const paths = await fixture(),
    worker = processFixture(paths, 'drain');
  await message(worker, 'maintenance-started');
  expect((await terminate(worker.child, 'SIGTERM'))[0]).toBe(0);
  expect(JSON.parse(await readFile(paths.completion, 'utf8'))).toEqual({
    maintenanceFinished: true,
    cycles: 1,
  });
  expect(worker.messages.find((row) => row.type === 'closed')?.cycles).toBe(1);
});
it('starts the real standalone Node entrypoint with the scheduler bound and exits cleanly on SIGTERM', async () => {
  const paths = await fixture();
  const child = spawn(
    process.execPath,
    [
      '--conditions=source',
      '--import',
      'tsx',
      resolve(import.meta.dirname, '../server/main.ts'),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DO_NOT_TRACK: '1',
        STUDIO_HOST: '127.0.0.1',
        STUDIO_PORT: '0',
        STUDIO_ORIGIN: 'http://127.0.0.1:0',
        STUDIO_DATA_DIR: dirname(paths.database),
      },
    },
  );
  let logs = '',
    errors = '';
  child.stdout?.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    errors += chunk.toString();
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  const origin = await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(errors || logs);
    return logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  });
  const response = await fetch(origin + '/api/health');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect((await terminate(child, 'SIGTERM'))[0]).toBe(0);
  expect(logs).not.toContain('Local lifecycle maintenance failed');
});
