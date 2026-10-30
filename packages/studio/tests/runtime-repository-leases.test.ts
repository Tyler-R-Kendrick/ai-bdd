import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { createDurableJobRuntime } from '../server/runtime/jobs.ts';
import { createApp } from '../server/app.ts';
import { githubFixture } from './identity/github-fixture.ts';
import type { DurableJobContext } from '../server/runtime/contracts.ts';
import { client, member, setup, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(
    adapter === 'postgres' && !process.env.STUDIO_TEST_POSTGRES_URL,
  )(adapter + ' runtime repository permission renewal over actual HTTP', () => {
    async function fixture() {
      const github = await githubFixture();
      cleanup.push(() => github.close());
      github.permissions.set('101:acme/private', { pull: true, push: true });
      const store = await Store.open(
        adapter === 'sqlite'
          ? ':memory:'
          : await openDatabase({
              adapter: 'postgres',
              url: process.env.STUDIO_TEST_POSTGRES_URL!,
              schema: 'runtime_repo_' + randomUUID().replaceAll('-', ''),
            }),
      );
      const runtime = await createDurableJobRuntime({
        store,
        leaseMs: 1200,
        dispatcher: {
          provider: 'manual-lease-fixture',
          publish: async () => ({ provider: 'manual-lease-fixture' }),
        },
      });
      const studio = await createApp(
        {
          ...testSettings('/tmp/studio-runtime-repository'),
          repositoryIdentity: {
            clientId: github.clientId,
            clientSecret: github.clientSecret,
            encryptionKey: randomBytes(32).toString('base64url'),
            kind: 'oauth-app',
            authorizationUrl: github.origin + '/login/oauth/authorize',
            tokenUrl: github.origin + '/login/oauth/access_token',
            apiBaseUrl: github.origin,
            allowLoopback: true,
            leaseSeconds: 30,
          },
        },
        { store, runtime },
      );
      cleanup.push(() => studio.app.close());
      const { user, cookie } = await setup(studio.app);
      const connect = async (sessionCookie: string) => {
        const start = await client(studio.app, sessionCookie)(
          'POST',
          '/api/identity/github/start',
          {
            returnTo: '/',
          },
        );
        expect(start.statusCode, start.body).toBe(200);
        const authorize = await fetch(start.json().authorizationUrl, {
            redirect: 'manual',
          }),
          callback = new URL(authorize.headers.get('location')!),
          binding = start.cookies.find(
            (cookie) => cookie.name === 'studio_repository_oauth',
          )!.value;
        const connected = await studio.app.inject({
          url: callback.pathname + callback.search,
          headers: { cookie: 'studio_repository_oauth=' + binding },
        });
        expect(connected.statusCode, connected.body).toBe(302);
      };
      await connect(cookie);
      const repository = 'https://github.com/acme/private';
      await studio.identity.assertRepository(user, repository, 'write');
      const project = await store.createProject(
        user,
        'Long-running authorized work',
        '',
        repository,
      );
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).startsWith(github.origin + '/repos/'))
          expect(store.db.inTransaction()).toBe(false);
        return realFetch(input, init);
      });
      const expire = () =>
        store.exec(
          'UPDATE repository_identity_leases SET expires_at=? WHERE user_id=?',
          Date.now() - 1,
          user.id,
        );
      const calls = () =>
        github.requests.filter(
          (request) => request.path === '/repos/acme/private',
        ).length;
      const enqueue = () =>
        runtime.enqueue({
          kind: 'fixture.repository-work',
          projectId: project.id,
          artifactId: project.mainArtifactId,
          principalId: user.id,
          artifactVersion: 1,
          snapshot: { explicit: 'repository permission lease fixture' },
          idempotencyKey: randomUUID(),
        });
      return {
        studio,
        store,
        runtime,
        github,
        user,
        project,
        expire,
        calls,
        enqueue,
        connect,
        cookie,
      };
    }
    it('renews expired grants before claim and from the active heartbeat without network inside SQL', async () => {
      const w = await fixture(),
        initial = w.calls();
      let retained: DurableJobContext | undefined;
      w.runtime.register('fixture.repository-work', async (ctx) => {
        retained = ctx;
        await ctx.assertCurrent();
        const beforeHeartbeat = w.calls();
        await w.expire();
        await vi.waitFor(
          () => expect(w.calls()).toBeGreaterThan(beforeHeartbeat),
          { timeout: 5000 },
        );
        await ctx.progress({
          percent: 75,
          label: 'Permission renewed from the provider',
        });
        return ctx.commit('publish-authorized-result', async () => ({
          published: true,
        }));
      });
      const job = await w.enqueue();
      await w.expire();
      await w.runtime.executeJob(job.id, {
        messageId: 'permission-expiry',
        deliveryCount: 1,
      });
      expect(await w.runtime.get(job.id)).toMatchObject({
        status: 'completed',
        result: { published: true },
      });
      expect(w.calls()).toBeGreaterThanOrEqual(initial + 2);
      const after = w.calls();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(w.calls()).toBe(after);
      await w.expire();
      await expect(retained!.assertCurrent()).rejects.toThrow(
        'lost its publication lease',
      );
      expect(w.calls()).toBe(after);
    });
    it('allows a different authorized member to cancel work after the principal is revoked without renewing that principal', async () => {
      const w = await fixture(),
        caller = await member(
          w.studio.app,
          client(w.studio.app, w.cookie),
          w.project.id,
          'editor',
          'cancel-editor@example.test',
        );
      w.github.selected.user = { id: 102, login: 'cancel-editor-fixture' };
      w.github.permissions.set('102:acme/private', { pull: true, push: true });
      await w.connect(caller.cookie);
      await w.studio.identity.assertRepository(
        caller.user,
        'https://github.com/acme/private',
        'write',
      );
      w.runtime.register('fixture.repository-work', async () => null);
      const job = await w.enqueue();
      await w.store.tx(async () => {
        await w.store.lock('project:' + w.project.id);
        await w.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          w.project.id,
          w.user.id,
        );
      });
      await w.store.exec(
        'UPDATE repository_identity_leases SET expires_at=?',
        Date.now() - 1,
      );
      await w.store.exec(
        'UPDATE studio_durable_jobs SET input_json=? WHERE id=?',
        JSON.stringify({ damaged: 'explicit corruption fixture' }),
        job.id,
      );
      const before = w.calls();
      await w.runtime.cancel(job.id, caller.user);
      expect(
        (
          await w.store.one(
            'SELECT status FROM studio_durable_jobs WHERE id=?',
            job.id,
          )
        ).status,
      ).toBe('cancelled');
      expect(w.calls()).toBe(before + 1);
      expect(
        w.github.requests
          .filter((request) => request.path === '/repos/acme/private')
          .at(-1)!.authorization,
      ).toBe('Bearer ' + w.github.lastAccess);
    });
    it('stops an active worker on actual provider revocation and preserves the cancelled publication fence', async () => {
      const w = await fixture();
      let published = false;
      w.runtime.register('fixture.repository-work', async (ctx) => {
        w.github.permissions.set('101:acme/private', {
          pull: false,
          push: false,
        });
        await w.expire();
        await new Promise<void>((_resolve, reject) =>
          ctx.signal.addEventListener(
            'abort',
            () => reject(ctx.signal.reason),
            { once: true },
          ),
        );
        return ctx.commit('must-not-publish', async () => {
          published = true;
          return { published: true };
        });
      });
      const job = await w.enqueue();
      await w.runtime.executeJob(job.id, {
        messageId: 'permission-revocation',
        deliveryCount: 1,
      });
      expect((await w.runtime.get(job.id))?.status).toBe('cancelled');
      expect(published).toBe(false);
      expect(
        await w.store.one(
          "SELECT job_id FROM studio_job_receipts WHERE job_id=? AND phase='publication'",
          job.id,
        ),
      ).toBeUndefined();
      const calls = w.calls();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(w.calls()).toBe(calls);
    });
  });
