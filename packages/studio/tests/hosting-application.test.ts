import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostingApplication } from '../server/hosting/application.ts';
import { openDatabase } from '../server/persistence/index.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const password = 'composition-fixture-owner-password';
describe('hosting composition root', () => {
  it('starts the real application with one local SQL/runtime graph and restores persisted project state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosting-app-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const env = {
      STUDIO_DATA_DIR: directory,
      STUDIO_ORIGIN: 'http://127.0.0.1:8787',
      STUDIO_ADMIN_EMAIL: 'owner@example.test',
      STUDIO_ADMIN_PASSWORD: password,
    };
    const first = await createHostingApplication(env);
    cleanup.push(() => first.close());
    expect(first.runtime.options.store).toBe(first.store);
    expect(first.agent.options.runtime).toBe(first.runtime);
    expect(first.runner.options.runtime).toBe(first.runtime);
    const login = await first.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: env.STUDIO_ORIGIN },
      payload: { email: env.STUDIO_ADMIN_EMAIL, password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find(
        (c) => c.name === 'studio_session',
      )!.value,
      headers = {
        cookie: 'studio_session=' + cookie,
        origin: env.STUDIO_ORIGIN,
      };
    const created = await first.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        title: 'Durable composition',
        description: 'A restart retains the same artifacts.',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(
      (await first.app.inject('/api/hosting/readiness')).json(),
    ).toMatchObject({
      ready: true,
      provider: 'node',
      database: 'sqlite',
      services: {
        database: { state: 'verified' },
        objects: { state: 'configured' },
        jobs: { state: 'configured' },
      },
    });
    await first.hosting.objects.put(
      'composition/restart.txt',
      Buffer.from('private bytes'),
      { contentType: 'text/plain' },
    );
    await first.close();
    cleanup.pop();
    const second = await createHostingApplication(env);
    cleanup.push(() => second.close());
    const projects = await second.app.inject({ url: '/api/projects', headers });
    expect(projects.statusCode).toBe(200);
    expect(projects.json().map((p: { title: string }) => p.title)).toContain(
      'Durable composition',
    );
    expect(
      (
        await second.hosting.objects.get('composition/restart.txt', {
          maxBytes: 100,
        })
      )?.bytes,
    ).toEqual(Buffer.from('private bytes'));
    second.beginDrain();
    expect((await second.app.inject('/api/hosting/readiness')).statusCode).toBe(
      503,
    );
  });
  it.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL)(
    'boots the Vercel graph on actual isolated PostgreSQL without claiming unprovisioned Blob/Queue verification',
    async () => {
      const database = await openDatabase({
        adapter: 'postgres',
        url: process.env.STUDIO_TEST_POSTGRES_URL!,
        schema: 'hosting_app_' + randomUUID().replaceAll('-', ''),
      });
      const service = await createHostingApplication(
        {
          NODE_ENV: 'production',
          VERCEL: '1',
          VERCEL_ENV: 'preview',
          VERCEL_URL: 'composition-preview.vercel.app',
          VERCEL_DEPLOYMENT_ID: 'dpl_composition_fixture',
          DATABASE_URL: process.env.STUDIO_TEST_POSTGRES_URL!,
          BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_fixture_test-only-key',
          STUDIO_JOB_SECRET: 'fixture-stable-job-secret-at-least-32-characters',
          STUDIO_ADMIN_EMAIL: 'owner@example.test',
          STUDIO_ADMIN_PASSWORD: password,
        },
        { database },
      );
      cleanup.push(() => service.close());
      const ready = await service.app.inject('/api/hosting/readiness');
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        provider: 'vercel',
        database: 'postgres',
        ephemeralStaging: true,
        services: {
          objects: { state: 'configured' },
          jobs: { state: 'configured' },
        },
      });
      expect(ready.body).not.toContain('test-only-key');
      expect(service.config.origin).toBe(
        'https://composition-preview.vercel.app',
      );
      expect(
        (
          await service.app.inject({
            method: 'POST',
            url: '/internal/jobs/execute',
            payload: { jobId: randomUUID() },
          })
        ).statusCode,
      ).toBe(401);
    },
  );
});
