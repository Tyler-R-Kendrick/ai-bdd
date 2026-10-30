import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createApp } from '../server/app.ts';
import { passwordHash } from '../server/auth.ts';
import { Store, HttpError } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import {
  DurableJobCoordinator,
  OutboxDispatchPendingError,
} from '../server/runtime/jobs.ts';
import type { DurableJobContext } from '../server/runtime/contracts.ts';
import { client, origin, ownerPassword, testSettings } from './helpers.ts';

// Explicit local protocol fixtures only; deployed database URLs are rejected.
const postgresUrl =
  process.env.STUDIO_TEST_POSTGRES_URL ??
  'postgresql://studio:studio-integration-only@127.0.0.1:55432/studio?sslmode=disable';
const postgresEnabled = !!process.env.STUDIO_TEST_POSTGRES_URL;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const degraded = {
  state: 'degraded',
  reason: 'outbox-dispatch-pending',
  verified: false,
};
const configured = { state: 'configured', verified: false };
const kind = 'fixture.startup-availability';
type Adapter = 'sqlite' | 'postgres';

async function fixture(adapter: Adapter) {
  if (
    adapter === 'postgres' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(postgresUrl).hostname)
  )
    throw new Error('Outbox regression fixtures require local PostgreSQL');
  const dir = await mkdtemp(join(tmpdir(), 'studio-outbox-startup-')),
    schema = 'outbox_startup_' + randomUUID().replaceAll('-', '');
  cleanup.push(async () => {
    if (adapter === 'postgres') {
      const pool = new Pool(postgresPoolConfig({ url: postgresUrl }));
      try {
        await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  const openStore = async () => {
    const store = await Store.open(
      adapter === 'sqlite'
        ? join(dir, 'studio.sqlite')
        : await openDatabase({ adapter, url: postgresUrl, schema }),
    );
    cleanup.push(() => store.close());
    return store;
  };
  const store = await openStore();
  if (adapter === 'postgres') {
    const version = Number(
      (await store.db.one('SHOW server_version_num')).server_version_num,
    );
    expect(version).toBeGreaterThanOrEqual(170000);
    expect(version).toBeLessThan(180000);
  }
  const user = await store.createUser(
      'outbox-owner-' + randomUUID() + '@example.test',
      'Outbox availability owner',
      await passwordHash(ownerPassword),
    ),
    project = await store.createProject(user, 'Cold-start workspace', ''),
    artifact = await store.createArtifact(
      user,
      project.id,
      'code',
      'Durable output target',
    );
  await store.db.exec(
    'CREATE TABLE startup_publications(job_id TEXT PRIMARY KEY,fence INTEGER NOT NULL,source TEXT NOT NULL)',
  );
  let unavailable: Error | undefined = new Error(
    'Synthetic queue credential rejected; provider-private-detail',
  );
  const dispatcher = {
    provider: 'explicit-startup-queue-fixture',
    publish: vi.fn(async (_id: string, _options?: unknown) => {
      if (unavailable) throw unavailable;
      return {
        provider: 'explicit-startup-queue-fixture',
        messageId: 'fixture-' + randomUUID(),
      };
    }),
  };
  // A stable clock keeps retries deterministic across actual Store/runtime restarts.
  let now = Date.now();
  const runtimeFor = async (sourceStore: Store) => {
    const runtime = new DurableJobCoordinator({
      store: sourceStore,
      dispatcher,
      clock: () => now,
      instanceId: 'startup-' + randomUUID(),
      leaseMs: 10000,
    });
    cleanup.push(() => runtime.close());
    await runtime.ready;
    return runtime;
  };
  const seed = await runtimeFor(store);
  seed.register(kind, async () => {
    throw new Error('Seeding must never execute a worker');
  });
  const job = await seed.enqueue({
    kind,
    projectId: project.id,
    artifactId: artifact.id,
    principalId: user.id,
    artifactVersion: artifact.version,
    snapshot: { approved: 'Recover the explicitly queued fixture output' },
    idempotencyKey: randomUUID(),
  });
  expect(dispatcher.publish).not.toHaveBeenCalled();
  await seed.close();
  await store.close();
  const start = async (
    handler: (
      context: DurableJobContext,
      store: Store,
    ) => Promise<unknown> = async () => {
      throw new Error('A queue publisher must never execute a worker');
    },
  ) => {
    const sourceStore = await openStore(),
      runtime = await runtimeFor(sourceStore);
    runtime.register(kind, (context) => handler(context, sourceStore));
    const application = await createApp(testSettings(dir), {
      store: sourceStore,
      runtime,
    });
    cleanup.push(() => application.app.close());
    return application;
  };
  const login = async (application: Awaited<ReturnType<typeof start>>) => {
    const response = await application.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: user.email, password: ownerPassword },
    });
    expect(response.statusCode, response.body).toBe(200);
    const session = response.cookies.find(
      (cookie) => cookie.name === 'studio_session',
    );
    expect(session).toBeDefined();
    return client(application.app, session!.value);
  };
  return {
    dir,
    user,
    project,
    artifact,
    job,
    openStore,
    runtimeFor,
    dispatcher,
    start,
    login,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    setFailure: (error?: Error) => {
      unavailable = error;
    },
  };
}

async function rejectOutboxWrite(store: Store, phase: 'reset' | 'receipt') {
  const condition =
      phase === 'reset'
        ? "NEW.status='pending'"
        : "NEW.status='dispatched' AND NEW.receipt_json IS NOT NULL",
    message = 'fixture outbox ' + phase + ' SQL write rejected';
  if (store.db.dialect === 'sqlite')
    await store.db.exec(
      `CREATE TRIGGER reject_startup_outbox_write BEFORE UPDATE ON studio_job_outbox WHEN ${condition} BEGIN SELECT RAISE(ABORT,'${message}'); END`,
    );
  else
    await store.db.exec(
      `CREATE FUNCTION reject_startup_outbox_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION '${message}'; END IF; RETURN NEW; END $$;
       CREATE TRIGGER reject_startup_outbox_write BEFORE UPDATE ON studio_job_outbox FOR EACH ROW EXECUTE FUNCTION reject_startup_outbox_write()`,
    );
  return message;
}

for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !postgresEnabled)(
    adapter + ' cold-start outbox availability',
    () => {
      it('keeps authenticated manual documents available across a persisted outage and publishes actual fenced output once after repair', async () => {
        const w = await fixture(adapter);
        const first = await w.start();
        expect(w.dispatcher.publish).toHaveBeenCalled();
        expect(await first.executionReadiness()).toEqual(degraded);
        const failedRows = await first.store.all(
          'SELECT * FROM studio_job_outbox WHERE job_id=?',
          w.job.id,
        );
        expect(failedRows.length).toBeGreaterThan(0);
        for (const row of failedRows) {
          expect(row.status).toBe('pending');
          expect(Number(row.attempts)).toBeGreaterThan(0);
          expect(row.receipt_json).toBeNull();
          expect(row.error).toBeTruthy();
          expect(Number(row.retry_at)).toBeGreaterThan(
            Number(row.available_at),
          );
        }
        await first.app.close();
        w.dispatcher.publish.mockClear();

        // This second startup has no in-memory outage flag and no retry due yet.
        const application = await w.start();
        expect(w.dispatcher.publish).not.toHaveBeenCalled();
        const request = await w.login(application),
          health = await application.app.inject('/api/health');
        expect(health.statusCode).toBe(200);
        expect(health.json()).toEqual({ ok: true });
        expect(health.headers['x-studio-execution-state']).toBe('degraded');
        expect(await application.executionReadiness()).toEqual(degraded);
        const capabilities = await request('GET', '/api/capabilities');
        expect(capabilities.statusCode).toBe(200);
        expect(capabilities.json().execution).toEqual(degraded);
        expect(capabilities.body).not.toContain('provider-private-detail');
        expect(
          (await application.app.inject('/api/capabilities')).statusCode,
        ).toBe(401);

        const created = await request(
          'POST',
          `/api/projects/${w.project.id}/artifacts`,
          { kind: 'document', title: 'Manual outage notes' },
        );
        expect(created.statusCode, created.body).toBe(201);
        const manual = created.json(),
          manualContent = {
            ...manual.content,
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Human edits remain durable.' },
                  ],
                },
              ],
            },
          },
          saved = await request('PATCH', `/api/artifacts/${manual.id}`, {
            version: manual.version,
            content: manualContent,
          });
        expect(saved.statusCode, saved.body).toBe(200);
        const read = await request('GET', `/api/artifacts/${manual.id}`);
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json().artifact.version).toBe(manual.version + 1);
        expect(JSON.stringify(read.json().artifact.content.doc)).toContain(
          'Human edits remain durable.',
        );
        expect(await application.runtime.get(w.job.id)).toMatchObject({
          status: 'queued',
          attempt: 0,
          fence: 0,
          result: null,
          progress: null,
          leaseOwner: null,
        });
        expect(
          (await application.store.artifact(w.artifact.id, w.user.id)).content,
        ).toEqual(w.artifact.content);
        expect(
          (
            await application.store.one(
              'SELECT count(*) AS n FROM startup_publications',
            )
          ).n,
        ).toBe(0);
        expect(
          (
            await application.store.one(
              'SELECT count(*) AS n FROM studio_job_receipts WHERE job_id=?',
              w.job.id,
            )
          ).n,
        ).toBe(0);

        // Merely correcting configuration or moving a retry deadline is not a receipt.
        w.setFailure(undefined);
        await application.store.exec(
          'UPDATE studio_job_outbox SET retry_at=0 WHERE job_id=?',
          w.job.id,
        );
        expect(await application.executionReadiness()).toEqual(degraded);
        await application.runtime.recover();
        expect(await application.executionReadiness()).toEqual(configured);
        expect(await application.runtime.get(w.job.id)).toMatchObject({
          status: 'queued',
          attempt: 0,
          result: null,
        });
        const dispatched = await application.store.all(
          'SELECT status,receipt_json FROM studio_job_outbox WHERE job_id=?',
          w.job.id,
        );
        expect(
          dispatched.every(
            (row) =>
              row.status === 'dispatched' &&
              JSON.parse(row.receipt_json).provider === w.dispatcher.provider,
          ),
        ).toBe(true);

        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
        let publications = 0;
        const publish = (context: DurableJobContext, sourceStore: Store) =>
          context.commit('publish-recovered-source', async () => {
            publications++;
            await sourceStore.exec(
              'INSERT INTO startup_publications(job_id,fence,source) VALUES(?,?,?)',
              context.job.id,
              context.fence,
              'Actual recovered fixture output',
            );
            await sourceStore.updateArtifact(
              w.user,
              w.artifact.id,
              w.artifact.version,
              {
                ...w.artifact.content,
                files: {
                  'index.html': '<h1>Actual recovered fixture output</h1>',
                },
              },
            );
            return { published: true };
          });
        // Register the real handler on a fresh coordinator, sharing the app Store.
        const worker = await w.runtimeFor(application.store);
        worker.register(kind, async (context) => {
          entered();
          await gate;
          return publish(context, application.store);
        });
        const competingStore =
            adapter === 'postgres' ? await w.openStore() : application.store,
          competitor = await w.runtimeFor(competingStore);
        competitor.register(kind, (context) =>
          publish(context, competingStore),
        );
        const execution = worker.executeJob(w.job.id, {
          messageId: 'repaired-queue-delivery',
          deliveryCount: 1,
        });
        try {
          await started;
          await competitor.executeJob(w.job.id, {
            messageId: 'concurrent-duplicate',
            deliveryCount: 2,
          });
          expect(publications).toBe(0);
          w.advance(10001);
          await competitor.executeJob(w.job.id, {
            messageId: 'redelivered-after-worker-lease-expired',
            deliveryCount: 3,
          });
          expect(publications).toBe(1);
        } finally {
          release();
        }
        await execution;
        await competitor.executeJob(w.job.id, {
          messageId: 'duplicate-after-publication',
          deliveryCount: 4,
        });
        expect(publications).toBe(1);
        expect(await worker.get(w.job.id)).toMatchObject({
          status: 'completed',
          attempt: 2,
          fence: 2,
          result: { published: true },
        });
        expect(
          (
            await application.store.one(
              'SELECT count(*) AS n FROM startup_publications',
            )
          ).n,
        ).toBe(1);
        expect(
          (
            await application.store.one(
              "SELECT count(*) AS n FROM studio_job_receipts WHERE job_id=? AND phase='publication'",
              w.job.id,
            )
          ).n,
        ).toBe(1);
        expect(
          (await application.store.artifact(w.artifact.id, w.user.id)).content
            .files['index.html'],
        ).toContain('Actual recovered fixture output');
        expect(
          (await request('GET', '/api/capabilities')).json().execution,
        ).toEqual(configured);
        const recoveredHealth = await application.app.inject('/api/health');
        expect(recoveredHealth.json()).toEqual({ ok: true });
        expect(recoveredHealth.headers['x-studio-execution-state']).toBe(
          'configured',
        );
      });

      it('retains persisted dispatching degradation until authorized cancellation without claiming dispatch or output', async () => {
        const w = await fixture(adapter),
          application = await w.start();
        expect(await application.executionReadiness()).toEqual(degraded);
        // Provider SDK HTTP statuses are not Studio's domain authorization errors.
        w.setFailure(
          Object.assign(new Error('Synthetic provider SDK HTTP 401'), {
            status: 401,
          }),
        );
        await application.store.exec(
          'UPDATE studio_job_outbox SET retry_at=0 WHERE job_id=?',
          w.job.id,
        );
        await expect(application.runtime.flushOutbox()).rejects.toBeInstanceOf(
          OutboxDispatchPendingError,
        );
        for (const row of await application.store.all(
          'SELECT status,error,receipt_json FROM studio_job_outbox WHERE job_id=?',
          w.job.id,
        )) {
          expect(row.status).toBe('pending');
          expect(row.error).toBeTruthy();
          expect(row.receipt_json).toBeNull();
        }
        await application.store.exec(
          "UPDATE studio_job_outbox SET status='dispatching',dispatch_owner=?,dispatch_expires=? WHERE job_id=?",
          'another-dispatcher',
          Date.now() + 60000,
          w.job.id,
        );
        expect(await application.executionReadiness()).toEqual(degraded);
        await application.runtime.cancel(w.job.id, w.user);
        expect(await application.executionReadiness()).toEqual(configured);
        expect(await application.runtime.get(w.job.id)).toMatchObject({
          status: 'cancelled',
          attempt: 0,
          result: null,
        });
        for (const row of await application.store.all(
          'SELECT receipt_json FROM studio_job_outbox WHERE job_id=?',
          w.job.id,
        ))
          expect(row.receipt_json).toBeNull();
        expect(
          (
            await application.store.one(
              'SELECT count(*) AS n FROM startup_publications',
            )
          ).n,
        ).toBe(0);
      });

      it.each(['reset', 'receipt'] as const)(
        'rejects startup for a real SQL %s write failure instead of treating it as provider degradation',
        async (phase) => {
          const w = await fixture(adapter),
            sourceStore = await w.openStore(),
            runtime = await w.runtimeFor(sourceStore);
          runtime.register(kind, async () => null);
          if (phase === 'receipt') w.setFailure(undefined);
          const message = await rejectOutboxWrite(sourceStore, phase);
          let failure: unknown;
          try {
            await runtime.flushOutbox();
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(Error);
          expect(failure).not.toBeInstanceOf(OutboxDispatchPendingError);
          expect((failure as Error).message).toContain(message);
          const persisted = await sourceStore.one(
            'SELECT status,error,receipt_json FROM studio_job_outbox WHERE job_id=?',
            w.job.id,
          );
          expect(persisted).toMatchObject({
            status: 'dispatching',
            error: null,
            receipt_json: null,
          });
          expect(await runtime.dispatchReadiness()).toEqual(configured);
          // Recover creates another durable intent; its SQL failure must stay fatal.
          await expect(
            createApp(testSettings(w.dir), { store: sourceStore, runtime }),
          ).rejects.toThrow(message);
        },
      );

      it.each([401, 403, 404])(
        'preserves a domain HttpError %i as a fatal startup error',
        async (status) => {
          const w = await fixture(adapter),
            sourceStore = await w.openStore(),
            runtime = await w.runtimeFor(sourceStore),
            denied = new HttpError(
              status,
              'Fixture domain authorization denied',
            );
          runtime.register(kind, async () => null);
          w.setFailure(denied);
          await expect(runtime.flushOutbox()).rejects.toBe(denied);
          expect(await runtime.dispatchReadiness()).toEqual(configured);
          await expect(
            createApp(testSettings(w.dir), { store: sourceStore, runtime }),
          ).rejects.toBe(denied);
          expect(denied).not.toBeInstanceOf(OutboxDispatchPendingError);
        },
      );
    },
  );
