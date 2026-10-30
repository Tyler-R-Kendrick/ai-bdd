import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

// Exercise Docker's actual command, not an imported factory or a mocked server.
let directory: string;
let entrypoint: string;
const cleanup: (() => Promise<unknown>)[] = [];
const password = 'entrypoint-fixture-password-only';
const previewOrigin = 'https://entrypoint-preview.vercel.app';
beforeAll(async () => {
  await mkdir('dist', { recursive: true });
  directory = await mkdtemp(resolve('dist/entrypoint-regression-'));
  entrypoint = join(directory, 'server/main.js');
  await mkdir(join(directory, 'client'), { recursive: true });
  await writeFile(
    join(directory, 'client/index.html'),
    '<title>Studio entrypoint fixture</title>',
  );
  await build({
    entryPoints: ['server/main.ts'],
    outfile: entrypoint,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function launch(overrides: NodeJS.ProcessEnv) {
  const port = await freePort();
  const dataDirectory = await mkdtemp(join(tmpdir(), 'studio-entrypoint-'));
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  // Never inherit live provider bindings or operator authentication into fixtures.
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      STUDIO_HOST: '127.0.0.1',
      STUDIO_PORT: String(port),
      STUDIO_DATA_DIR: dataDirectory,
      STUDIO_ADMIN_EMAIL: 'entrypoint@example.test',
      STUDIO_ADMIN_PASSWORD: password,
      DO_NOT_TRACK: '1',
      SCARF_NO_ANALYTICS: 'true',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (part) => {
    output = (output + part).slice(-16000);
  });
  child.stderr!.on('data', (part) => {
    output = (output + part).slice(-16000);
  });
  const exited = once(child, 'exit') as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [code, signal] = await exited;
        expect({ code, signal }).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timeout);
      }
    })());
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) await stop();
  });
  return {
    child,
    exited,
    stop,
    output: () => output,
    url: 'http://127.0.0.1:' + port,
  };
}
async function ready(service: Awaited<ReturnType<typeof launch>>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null || service.child.signalCode !== null)
      throw new Error(
        'Default image command exited before becoming healthy: ' +
          service.output(),
      );
    try {
      const response = await fetch(service.url + '/api/health', {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      /* Wait for the actual process to listen. */
    }
    await delay(25);
  }
  throw new Error(
    'Default image command did not become healthy: ' + service.output(),
  );
}
async function login(url: string, origin: string) {
  const response = await fetch(url + '/api/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'entrypoint@example.test', password }),
  });
  return response;
}
const cloud = {
  VERCEL_ENV: 'preview',
  VERCEL_URL: 'entrypoint-preview.vercel.app',
  VERCEL_PROJECT_PRODUCTION_URL: 'production.example.test',
  VERCEL_DEPLOYMENT_ID: 'dpl_entrypoint_fixture',
  STUDIO_MEDIA_SANDBOX_IMAGE: 'studio-media@sha256:' + 'a'.repeat(64),
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_entrypoint_fixture_not_live',
  STUDIO_JOB_SECRET: 'entrypoint-synthetic-job-secret-at-least-32-characters',
};
async function isolatedPostgres() {
  const url = new URL(process.env.STUDIO_TEST_POSTGRES_URL!);
  const administration = new Pool({ connectionString: url.toString() });
  const name = 'entrypoint_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE DATABASE "' + name + '"');
  url.pathname = '/' + name;
  const database = new Pool({ connectionString: url.toString() });
  cleanup.push(async () => {
    await database.end();
    try {
      await administration.query('DROP DATABASE "' + name + '" WITH (FORCE)');
    } finally {
      await administration.end();
    }
  });
  return { url: url.toString(), database };
}
describe('Provider-aware default image entrypoint', () => {
  it.each([
    { label: 'default local development', env: { NODE_ENV: 'development' } },
    {
      label: 'explicit Node production even with a platform marker',
      env: {
        STUDIO_HOSTING_PROVIDER: 'node',
        VERCEL: '1',
        STUDIO_ORIGIN: 'https://node.example.test',
      },
    },
  ])('preserves $label startup and graceful shutdown', async ({ env }) => {
    const service = await launch(env);
    await ready(service);
    expect((await fetch(service.url + '/api/hosting/readiness')).status).toBe(
      404,
    );
    const response = await login(
      service.url,
      env.STUDIO_ORIGIN ?? 'http://127.0.0.1:8787',
    );
    expect(response.status).toBe(200);
    await service.stop();
  });
  it.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL).each([
    { label: 'Vercel marker', env: { VERCEL: '1' } },
    {
      label: 'explicit Vercel provider',
      env: { STUDIO_HOSTING_PROVIDER: 'vercel' },
    },
  ])(
    'boots $label through the bundled default command with a derived preview origin and durable PostgreSQL',
    async ({ env }) => {
      const postgres = await isolatedPostgres();
      const settings = { ...cloud, ...env, DATABASE_URL: postgres.url };
      // No STUDIO_ORIGIN is present: the cloud composition must derive it before
      // production auth validation. No upload, enqueue, or Sandbox call is made.
      const service = await launch(settings);
      await ready(service);
      const readiness = await fetch(service.url + '/api/hosting/readiness');
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({
        ready: true,
        provider: 'vercel',
        database: 'postgres',
        objects: 'vercel-blob',
        jobs: 'vercel-queue',
        ephemeralStaging: true,
        services: {
          database: { state: 'verified' },
          objects: { state: 'configured' },
          jobs: { state: 'configured' },
          media: { adapter: 'vercel-sandbox', verified: false },
        },
      });
      expect(
        (await login(service.url, 'https://production.example.test')).status,
      ).toBe(403);
      const authenticated = await login(service.url, previewOrigin);
      expect(authenticated.status).toBe(200);
      expect(authenticated.headers.get('set-cookie')).toContain('Secure');
      const cookie = authenticated.headers.get('set-cookie')!.split(';')[0];
      const created = await fetch(service.url + '/api/projects', {
        method: 'POST',
        headers: {
          cookie,
          origin: previewOrigin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Bundled cloud entrypoint',
          description: 'Actual durable SQL publication',
        }),
      });
      expect(created.status).toBe(201);
      const project = (await created.json()) as { id: string };
      expect(
        (
          await postgres.database.query(
            'SELECT title FROM projects WHERE id=$1',
            [project.id],
          )
        ).rows,
      ).toEqual([{ title: 'Bundled cloud entrypoint' }]);
      expect(
        (
          await fetch(service.url + '/internal/jobs/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: randomUUID() }),
          })
        ).status,
      ).toBe(401);
      await service.stop();
      const restarted = await launch(settings);
      await ready(restarted);
      const restored = await fetch(restarted.url + '/api/projects', {
        headers: { cookie },
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: project.id })]),
      );
      await restarted.stop();
    },
  );
  it.each([
    ...[undefined, '1'].map((marker) => ({
      label: `unknown hosting provider with VERCEL=${marker ?? 'unset'}`,
      env: {
        STUDIO_HOSTING_PROVIDER: 'vercle',
        VERCEL: marker,
        STUDIO_ORIGIN: 'https://node.example.test',
      },
      error: 'Unknown Studio hosting provider',
    })),
    {
      label: 'local HTTPS',
      env: {},
      error: 'Production requires an HTTPS STUDIO_ORIGIN',
    },
    {
      label: 'cloud demo',
      env: { ...cloud, VERCEL: '1', STUDIO_DEMO: '1' },
      error: 'Demo bootstrap is forbidden in Vercel deployments',
    },
    {
      label: 'cloud job secret',
      env: {
        ...cloud,
        VERCEL: '1',
        STUDIO_JOB_SECRET: '',
        DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/unused',
      },
      error:
        'Cloud execution requires a stable job secret and trusted deployment identity',
    },
    {
      label: 'cloud private worker image',
      env: {
        ...cloud,
        VERCEL: '1',
        DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/unused',
        STUDIO_MEDIA_SANDBOX_IMAGE: 'mutable:latest',
      },
      error: 'Hosted media requires STUDIO_MEDIA_SANDBOX_IMAGE pinned',
    },
  ])(
    'retains the $label guard in the real bundled process',
    async ({ env, error }) => {
      const service = await launch(env);
      const [code, signal] = await service.exited;
      expect({ code, signal }).toEqual({ code: 1, signal: null });
      expect(service.output()).toContain(error);
      await expect(
        fetch(service.url + '/api/health', {
          signal: AbortSignal.timeout(500),
        }),
      ).rejects.toThrow();
    },
  );
});
