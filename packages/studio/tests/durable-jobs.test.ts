import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import {
  DurableJobCoordinator,
  TerminalJobError,
} from '../server/runtime/jobs.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const store = await Store.open(':memory:');
  cleanup.push(() => store.close());
  const user = await store.createUser(
      'owner-' + randomUUID() + '@example.test',
      'Job owner',
      null,
    ),
    project = await store.createProject(user, 'Durable execution', ''),
    artifact = await store.createArtifact(
      user,
      project.id,
      'code',
      'Execution target',
    );
  let now = Date.now();
  const clock = () => now;
  const sent: { id: string; options: any }[] = [];
  const dispatcher = {
    provider: 'explicit-dispatch-protocol-fixture',
    publish: vi.fn(async (id: string, options?: any) => {
      sent.push({ id, options });
      return { provider: 'explicit-dispatch-protocol-fixture' };
    }),
  };
  const coordinator = new DurableJobCoordinator({
    store,
    dispatcher,
    instanceId: 'first-instance',
    leaseMs: 500,
    clock,
  });
  await coordinator.ready;
  cleanup.push(() => coordinator.close());
  const enqueue = (key = randomUUID(), overrides: Record<string, any> = {}) =>
    coordinator.enqueue({
      kind: 'fixture.work',
      projectId: project.id,
      artifactId: artifact.id,
      principalId: user.id,
      artifactVersion: artifact.version,
      snapshot: { approved: 'immutable fixture input' },
      idempotencyKey: key,
      ...overrides,
    });
  return {
    store,
    user,
    project,
    artifact,
    coordinator,
    dispatcher,
    sent,
    enqueue,
    clock,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
const delivery = (id: string) => ({ messageId: id, deliveryCount: 1 });

describe('durable fenced execution and publication', () => {
  it('composes snapshot and outbox with an outer transaction and dispatches no source in queue payloads', async () => {
    const w = await fixture();
    w.coordinator.register('fixture.work', async () => null);
    await expect(
      w.store.tx(async () => {
        await w.enqueue('rollback');
        throw new Error('rollback request');
      }),
    ).rejects.toThrow('rollback request');
    expect(
      (await w.store.one('SELECT count(*) AS n FROM studio_durable_jobs')).n,
    ).toBe(0);
    expect(w.sent).toEqual([]);
    const job = await w.store.tx(async () => {
      const job = await w.enqueue('approved');
      await w.store.exec(
        'UPDATE artifacts SET title=? WHERE id=?',
        'Metadata shares the same commit',
        w.artifact.id,
      );
      return job;
    });
    expect(w.sent).toEqual([]);
    await w.coordinator.flushOutbox();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.id).toBe(job.id);
    expect(w.sent[0]?.options.dispatchId).toBeTruthy();
    expect(JSON.stringify(w.sent)).not.toContain('immutable fixture input');
    expect(
      (
        await w.coordinator.enqueue({
          kind: 'fixture.work',
          projectId: w.project.id,
          artifactId: w.artifact.id,
          principalId: w.user.id,
          artifactVersion: w.artifact.version,
          snapshot: { approved: 'immutable fixture input' },
          idempotencyKey: 'approved',
        })
      ).id,
    ).toBe(job.id);
  });
  it('atomically publishes source, receipt, and completed state even if later cleanup fails', async () => {
    const w = await fixture();
    let calls = 0;
    w.coordinator.register('fixture.work', async (context) => {
      await context.commit('publish-source', async () => {
        calls++;
        await w.store.updateArtifact(w.user, w.artifact.id, 1, {
          ...w.artifact.content,
          files: { 'index.html': '<h1>Published once</h1>' },
        });
        return { published: true };
      });
      throw new Error('A post-publication cleanup failed');
    });
    const job = await w.enqueue();
    await w.coordinator.executeJob(job.id, delivery('first'));
    await w.coordinator.executeJob(job.id, delivery('redelivered'));
    expect(calls).toBe(1);
    expect((await w.coordinator.get(job.id))?.status).toBe('completed');
    expect((await w.coordinator.get(job.id))?.result).toEqual({
      published: true,
    });
    expect((await w.store.artifact(w.artifact.id, w.user.id)).version).toBe(
      2,
    );
    expect(
      (
        await w.store.one(
          'SELECT count(*) AS n FROM studio_job_receipts WHERE job_id=?',
          job.id,
        )
      ).n,
    ).toBe(1);
  });
  it('fences a stale worker and publishes only the current attempt after lease expiry', async () => {
    const w = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const publications: string[] = [];
    w.coordinator.register('fixture.work', async (context) => {
      entered();
      await gate;
      return context.commit('publish', async () => {
        publications.push('stale');
        return { by: 'stale' };
      });
    });
    const job = await w.enqueue(),
      original = w.coordinator.executeJob(job.id, delivery('original'));
    await ready;
    w.advance(1000);
    const second = new DurableJobCoordinator({
      store: w.store,
      dispatcher: w.dispatcher,
      instanceId: 'second-instance',
      leaseMs: 500,
      clock: w.clock,
    });
    await second.ready;
    cleanup.push(() => second.close());
    second.register('fixture.work', (context) =>
      context.commit('publish', async () => {
        publications.push('current');
        return { by: 'current' };
      }),
    );
    await second.executeJob(job.id, delivery('retry'));
    release();
    await original;
    expect(publications).toEqual(['current']);
    expect((await second.get(job.id))?.result).toEqual({ by: 'current' });
    expect((await second.get(job.id))?.attempt).toBe(2);
  });
  it('caches an external step across bounded retry without claiming universal exactly-once calls', async () => {
    const w = await fixture();
    let providerCalls = 0,
      attempts = 0;
    w.coordinator.register('fixture.work', async (context) => {
      const value = await context.step('provider-result', async (key) => {
        expect(key).toBe(context.job.id + ':provider-result');
        providerCalls++;
        return { value: 'persisted external result' };
      });
      if (++attempts === 1)
        throw new Error('Worker failed after its durable step receipt');
      return context.commit('publish', async () => value);
    });
    const job = await w.enqueue();
    await w.coordinator.executeJob(job.id, delivery('first'));
    expect((await w.coordinator.get(job.id))?.status).toBe('queued');
    w.advance(2000);
    await w.coordinator.recover();
    await w.coordinator.executeJob(job.id, delivery('second'));
    expect(providerCalls).toBe(1);
    expect((await w.coordinator.get(job.id))?.status).toBe('completed');
  });
  it('retains dispatch intent through a failed publisher and uses new identities for later recovery', async () => {
    const w = await fixture();
    w.coordinator.register('fixture.work', (context) =>
      context.commit('done', async () => ({ done: true })),
    );
    const job = await w.enqueue();
    w.dispatcher.publish.mockRejectedValueOnce(
      new Error('Queue unavailable'),
    );
    await expect(w.coordinator.flushOutbox()).rejects.toThrow('pending');
    expect((await w.coordinator.get(job.id))?.status).toBe('queued');
    const firstIntent = (
      await w.store.one(
        'SELECT id FROM studio_job_outbox WHERE job_id=?',
        job.id,
      )
    ).id;
    w.advance(2000);
    await w.coordinator.recover();
    expect(
      w.sent.some((message) => message.options.dispatchId === firstIntent),
    ).toBe(true);
    w.advance(30000);
    await w.coordinator.recover();
    expect(
      new Set(w.sent.map((message) => message.options.dispatchId)).size,
    ).toBeGreaterThan(1);
    await w.coordinator.executeJob(job.id, delivery('late delivery'));
    expect((await w.coordinator.get(job.id))?.status).toBe('completed');
  });
  it('rejects new publication after a source edit and rolls SQL side effects back when final receipt persistence fails', async () => {
    const w = await fixture();
    w.coordinator.register('fixture.work', (context) =>
      context.commit('publish', async () => {
        await w.store.exec(
          'UPDATE artifacts SET title=? WHERE id=?',
          'Must roll back',
          w.artifact.id,
        );
        return { published: true };
      }),
    );
    const job = await w.enqueue();
    await w.store.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON studio_job_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
    );
    await w.coordinator.executeJob(job.id, delivery('failure'));
    expect((await w.store.artifact(w.artifact.id, w.user.id)).title).toBe(
      'Execution target',
    );
    expect((await w.coordinator.get(job.id))?.status).toBe('queued');
    await w.store.db.exec('DROP TRIGGER reject_receipt');
    await w.store.updateArtifact(w.user, w.artifact.id, 1, {
      ...w.artifact.content,
      files: { 'index.html': '<h1>New human source</h1>' },
    });
    w.advance(2000);
    await w.coordinator.executeJob(job.id, delivery('stale'));
    expect((await w.coordinator.get(job.id))?.status).toBe('failed');
    expect((await w.coordinator.get(job.id))?.error).toContain('stale');
    expect(
      (await w.store.artifact(w.artifact.id, w.user.id)).content.files[
        'index.html'
      ],
    ).toContain('New human source');
  });
  it('persists cancellation and fences an active worker even if it ignores its AbortSignal', async () => {
    const w = await fixture();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    let published = false;
    w.coordinator.register('fixture.work', async (context) => {
      entered();
      await gate;
      return context.commit('publish', async () => {
        published = true;
        return {};
      });
    });
    const job = await w.enqueue(),
      execution = w.coordinator.executeJob(job.id, delivery('running'));
    await ready;
    await w.coordinator.cancel(job.id, w.user);
    release();
    await execution;
    expect(published).toBe(false);
    expect((await w.coordinator.get(job.id))?.status).toBe('cancelled');
  });
  it('fails closed on an altered immutable snapshot and bounds terminal retries', async () => {
    const w = await fixture();
    let calls = 0;
    w.coordinator.register('fixture.work', async () => {
      calls++;
      throw new TerminalJobError('Invalid requested output format');
    });
    const altered = await w.enqueue();
    await w.store.exec(
      'UPDATE studio_durable_jobs SET input_json=? WHERE id=?',
      '{}',
      altered.id,
    );
    await w.coordinator.executeJob(altered.id, delivery('tamper'));
    expect(
      (
        await w.store.one(
          'SELECT status FROM studio_durable_jobs WHERE id=?',
          altered.id,
        )
      ).status,
    ).toBe('failed');
    expect(calls).toBe(0);
    const terminal = await w.enqueue();
    await w.coordinator.executeJob(terminal.id, delivery('terminal'));
    await w.coordinator.executeJob(terminal.id, delivery('repeat'));
    expect(calls).toBe(1);
    expect((await w.coordinator.get(terminal.id))?.status).toBe('failed');
  });
});
