import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import {
  ArtifactTitles,
  type TitleProvider,
} from '../server/integrations/titles.ts';

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
async function setup(
  provider: TitleProvider = async () => 'A useful generated title',
) {
  const store = await Store.open(':memory:');
  close.push(() => store.close());
  const user = await store.createUser(
    'title@example.test',
    'Title owner',
    null,
  );
  const project = await store.createProject(user, 'Title policy', '');
  const artifact = await store.createArtifact(
    user,
    project.id,
    'document',
    'My human title',
  );
  const thread = (await store.threads(artifact.id))[0]!;
  const runtime = new DurableJobCoordinator({
    store,
    dispatcher: {
      provider: 'title-delivery-fixture',
      publish: async () => ({ provider: 'title-delivery-fixture' }),
    },
  });
  await runtime.ready;
  close.push(() => runtime.close());
  let allowed = true;
  const titles = new ArtifactTitles({
    store,
    runtime,
    provider,
    allowed: async () => allowed,
    quietMs: 0,
  });
  await titles.initialize();
  const observe = async (body = 'We are planning the test strategy') => {
    await store.message(user, artifact.id, thread.id, body);
    await titles.observeMessage(user, artifact.id, thread.id);
    return (
      await store.all(
        "SELECT id FROM studio_durable_jobs WHERE kind='artifact.title' ORDER BY created_at,id",
      )
    ).map((row) => row.id as string);
  };
  const execute = (id: string) =>
    runtime.executeJob(id, { messageId: 'delivery-' + id, deliveryCount: 1 });
  return {
    store,
    user,
    project,
    artifact,
    thread,
    runtime,
    titles,
    observe,
    execute,
    pause: () => {
      allowed = false;
    },
  };
}
describe('durable artifact title maintenance', () => {
  it('protects human names by default and only runs after explicit opt-in', async () => {
    const provider = vi.fn(async () => 'Acceptance tests and evidence');
    const w = await setup(provider);
    expect(await w.observe()).toEqual([]);
    await w.titles.policy(w.user, w.artifact.id, 'automatic');
    const ids = await w.observe();
    await w.execute(ids[0]!);
    await w.execute(ids[0]!);
    expect((await w.store.artifact(w.artifact.id, w.user.id)).title).toBe(
      'Acceptance tests and evidence',
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await w.runtime.get(ids[0]!))?.status).toBe('completed');
  });
  it('does not overwrite a human rename made while the actual provider operation is in flight', async () => {
    let release!: (value: string) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const w = await setup(async () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await w.titles.policy(w.user, w.artifact.id, 'automatic');
    const ids = await w.observe();
    const running = w.execute(ids[0]!);
    await started;
    await w.store.tx(async () => {
      await w.store.lock('project:' + w.project.id);
      await w.titles.markHuman(w.artifact.id);
      await w.store.exec(
        'UPDATE artifacts SET title=? WHERE id=?',
        'A title chosen by a person',
        w.artifact.id,
      );
    });
    release('Late model title');
    await running;
    expect((await w.store.artifact(w.artifact.id, w.user.id)).title).toBe(
      'A title chosen by a person',
    );
    expect((await w.runtime.get(ids[0]!))?.result).toEqual({ skipped: true });
    await w.store.tx(() => w.titles.markGenerated(w.artifact.id));
    expect((await w.titles.policy(w.user, w.artifact.id)).mode).toBe('human');
  });
  it('skips superseded messages and obeys shared pause before calling the provider', async () => {
    const provider = vi.fn(async () => 'Current topic');
    const w = await setup(provider);
    await w.titles.policy(w.user, w.artifact.id, 'automatic');
    const first = await w.observe('Old topic');
    await w.observe('New topic');
    await w.execute(first[0]!);
    expect(provider).not.toHaveBeenCalled();
    w.pause();
    const jobs = await w.store.all(
      "SELECT id FROM studio_durable_jobs WHERE status='queued'",
    );
    for (const job of jobs) await w.execute(job.id);
    expect(provider).not.toHaveBeenCalled();
    expect((await w.store.artifact(w.artifact.id, w.user.id)).title).toBe(
      'My human title',
    );
  });
  it('rejects unbounded provider titles without publishing or losing human policy', async () => {
    const w = await setup(async () => 'x'.repeat(181));
    await w.titles.policy(w.user, w.artifact.id, 'automatic');
    const ids = await w.observe();
    await w.execute(ids[0]!);
    expect((await w.store.artifact(w.artifact.id, w.user.id)).title).toBe(
      'My human title',
    );
    expect((await w.runtime.get(ids[0]!))?.status).not.toBe('completed');
  });
});
