import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const adapter of [
  'sqlite',
  ...(process.env.STUDIO_TEST_POSTGRES_URL ? ['postgres'] : []),
] as const) {
  async function fixture() {
    const store = await Store.open(
      adapter === 'postgres'
        ? await openDatabase({
            adapter: 'postgres',
            url: process.env.STUDIO_TEST_POSTGRES_URL!,
            schema: 'abort_review_' + randomUUID().replaceAll('-', ''),
          })
        : ':memory:',
    );
    cleanup.push(() => store.close());
    const user = await store.createUser(
        randomUUID() + '@abort-review.test',
        'Abort reviewer',
        null,
      ),
      project = await store.createProject(
        user,
        'Delivery cancellation review',
        '',
      ),
      artifact = await store.artifact(project.mainArtifactId, user.id);
    await store.db.exec(
      'CREATE TABLE runtime_abort_review_effects(id TEXT PRIMARY KEY)',
    );
    const runtime = new DurableJobCoordinator({
      store,
      dispatcher: {
        provider: 'explicit-independent-delivery-fixture',
        async publish() {
          return { provider: this.provider };
        },
      },
      leaseMs: 5000,
    });
    await runtime.ready;
    cleanup.push(() => runtime.close());
    const enqueue = () =>
      runtime.enqueue({
        kind: 'review.abort',
        projectId: project.id,
        artifactId: artifact.id,
        principalId: user.id,
        artifactVersion: artifact.version,
        snapshot: { approved: true },
        idempotencyKey: randomUUID(),
      });
    return { store, runtime, enqueue };
  }
  describe(`independent delivery-abort publication review (${adapter})`, () => {
    it('does not complete an ignored delivery abort when a handler returns without committing', async () => {
      const w = await fixture(),
        entered = gate(),
        release = gate(),
        controller = new AbortController();
      w.runtime.register('review.abort', async () => {
        entered.resolve();
        await release.promise;
        return { shouldNotPublish: true };
      });
      const job = await w.enqueue(),
        work = w.runtime.executeJob(job.id, {
          messageId: 'abort-before-generic-publication',
          deliveryCount: 1,
          signal: controller.signal,
        });
      await entered.promise;
      controller.abort(new Error('Actual delivery was cancelled'));
      release.resolve();
      await work;
      expect((await w.runtime.get(job.id))?.status).not.toBe('completed');
    });
    it('rolls back a final SQL callback if the delivery aborts while that callback is awaiting', async () => {
      const w = await fixture(),
        entered = gate(),
        release = gate(),
        controller = new AbortController();
      w.runtime.register('review.abort', (ctx) =>
        ctx.commit('publish', async () => {
          await w.store.exec(
            'INSERT INTO runtime_abort_review_effects(id) VALUES(?)',
            ctx.job.id,
          );
          entered.resolve();
          await release.promise;
          return { shouldNotPublish: true };
        }),
      );
      const job = await w.enqueue(),
        work = w.runtime.executeJob(job.id, {
          messageId: 'abort-during-sql-publication',
          deliveryCount: 1,
          signal: controller.signal,
        });
      await entered.promise;
      controller.abort(new Error('Actual delivery was cancelled'));
      release.resolve();
      await work;
      expect(
        (
          await w.store.one(
            'SELECT COUNT(*) AS n FROM runtime_abort_review_effects',
          )
        ).n,
      ).toBe(0);
      expect((await w.runtime.get(job.id))?.status).not.toBe('completed');
    });
    it('preserves already committed output when delivery aborts during later handler cleanup', async () => {
      const w = await fixture(),
        committed = gate(),
        release = gate(),
        controller = new AbortController();
      w.runtime.register('review.abort', async (ctx) => {
        const value = await ctx.commit('publish', async () => {
          await w.store.exec(
            'INSERT INTO runtime_abort_review_effects(id) VALUES(?)',
            ctx.job.id,
          );
          return { alreadyPublished: true };
        });
        committed.resolve();
        await release.promise;
        return value;
      });
      const job = await w.enqueue(),
        work = w.runtime.executeJob(job.id, {
          messageId: 'abort-after-committed-publication',
          deliveryCount: 1,
          signal: controller.signal,
        });
      await committed.promise;
      controller.abort(new Error('Abort after committed output'));
      release.resolve();
      await work;
      expect((await w.runtime.get(job.id))?.status).toBe('completed');
      expect(
        (
          await w.store.one(
            'SELECT COUNT(*) AS n FROM runtime_abort_review_effects',
          )
        ).n,
      ).toBe(1);
    });
  });
}
