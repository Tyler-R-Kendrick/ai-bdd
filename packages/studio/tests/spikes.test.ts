import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { createDurableJobRuntime } from '../server/runtime/jobs.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import {
  createSpikeJudge,
  SpeculativeSpikes,
} from '../server/integrations/spikes.ts';
import { testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture(
  provider: 'sqlite' | 'postgres' = 'sqlite',
  enabled = true,
  consent = true,
) {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-classifier-http-fixture');
  const directory = await mkdtemp('/workspace/ai-bdd/work/spike-classifier-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const requests: any[] = [];
  let beforeReply: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      body: JSON.parse(body),
      headers: req.headers,
    });
    await beforeReply?.();
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              useful: true,
              brief:
                'Measure the uncertain rendering latency in a disposable local prototype',
              reason:
                'A measurement can resolve the saved feasibility question',
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const store = await Store.open(
    provider === 'sqlite'
      ? ':memory:'
      : await openDatabase({
          adapter: 'postgres',
          url: process.env.STUDIO_TEST_POSTGRES_URL!,
          schema: 'spikes_' + randomUUID().replaceAll('-', ''),
        }),
  );
  cleanup.push(() => store.close());
  const user = await store.createUser(
      randomUUID() + '@example.test',
      'Owner',
      null,
    ),
    project = (await store.createProject(
      user,
      'Prototype source',
      '',
      'https://github.com/example/prototype',
    ))!;
  const jobs: string[] = [],
    runtime = await createDurableJobRuntime({
      store,
      dispatcher: {
        provider: 'fixture',
        publish: async (id) => {
          expect(store.db.inTransaction()).toBe(false);
          jobs.push(id);
          return { provider: 'fixture' };
        },
      },
    });
  cleanup.push(() => runtime.close());
  const settings = {
      ...testSettings(directory),
      model: 'fixture/model',
      integrations: {
        gatewayBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      },
    },
    judge = createSpikeJudge(settings)!;
  const machines = new MachineService(store, { notify: async () => {} } as any);
  await machines.initialize();
  const paired = await machines.pair(
      (await machines.pairing(user, project.id, 'Personal machine')).code,
    ),
    machine = await store.one(
      'SELECT * FROM studio_machines WHERE id=?',
      paired.id,
    );
  const notifications: string[] = [],
    investigations = new InvestigationService({
      store,
      auth: {} as any,
      machines,
      objects: new DiskObjectStore(join(directory, 'objects')),
      spikes: { enabled, judge },
      notify: async (_project, id) => {
        expect(store.db.inTransaction()).toBe(false);
        notifications.push(id);
      },
    });
  await investigations.ready;
  await investigations.registerCheckout(machine, {
    repository: project.repository,
    sourceCommit: 'a'.repeat(40),
    branch: 'feature/prototype',
  });
  if (consent) await investigations.consent(user, machine.id, true);
  const spikes = new SpeculativeSpikes({
    store,
    runtime,
    investigations,
    enabled,
    judge,
    quietMs: 0,
  });
  await spikes.initialize();
  store.sourceObserver = (user, before, after) =>
    spikes.observe(user, before, after);
  const edit = async (text: string) => {
    const artifact = await store.artifact(project.mainArtifactId, user.id);
    return store.updateArtifact(user, artifact.id, artifact.version, {
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    });
  };
  return {
    store,
    user,
    project,
    runtime,
    jobs,
    requests,
    investigations,
    notifications,
    edit,
    setBeforeReply: (hook: () => Promise<void>) => (beforeReply = hook),
  };
}
const passage =
  'Could the preview render ten thousand independent objects without exceeding the interaction latency budget?';
describe('saved-source speculative prototype classifier', () => {
  for (const provider of ['sqlite', 'postgres'] as const)
    it.skipIf(provider === 'postgres' && !process.env.STUDIO_TEST_POSTGRES_URL)(
      `uses a real bounded SDK HTTP judgment and commits one owner-consented prototype (${provider})`,
      async () => {
        const w = await fixture(provider);
        await w.edit(passage);
        expect(w.jobs).toHaveLength(1);
        expect(w.requests).toHaveLength(0);
        await w.runtime.executeJob(w.jobs[0]!, {
          messageId: 'first',
          deliveryCount: 1,
        });
        await w.runtime.executeJob(w.jobs[0]!, {
          messageId: 'duplicate',
          deliveryCount: 2,
        });
        expect(w.requests).toHaveLength(1);
        expect(w.requests[0].headers['idempotency-key']).toBeTruthy();
        expect(JSON.stringify(w.requests[0].body)).toContain(passage);
        const items = await w.investigations.list(
          w.user,
          w.project.mainArtifactId,
        );
        expect(items.records).toHaveLength(1);
        expect(items.records[0]).toMatchObject({
          mode: 'spike',
          status: 'queued',
          ownerId: w.user.id,
        });
        expect(w.notifications.length).toBeGreaterThan(0);
      },
    );
  it('coalesces queued source updates and judges the latest exact saved passage', async () => {
    const w = await fixture();
    await w.edit(passage);
    const latest = passage + ' Measure both cold and warm frames.';
    await w.edit(latest);
    expect(w.jobs).toHaveLength(1);
    await w.runtime.executeJob(w.jobs[0]!, {
      messageId: 'latest',
      deliveryCount: 1,
    });
    expect(w.requests).toHaveLength(1);
    expect(JSON.stringify(w.requests[0].body)).toContain(latest);
    expect(
      (await w.investigations.list(w.user, w.project.mainArtifactId)).records,
    ).toHaveLength(1);
  });
  it('makes no provider calls without explicit operator enablement and personal machine consent', async () => {
    for (const [enabled, consent] of [
      [false, true],
      [true, false],
    ]) {
      const w = await fixture('sqlite', enabled, consent);
      await w.edit(passage);
      expect(w.jobs).toHaveLength(0);
      expect(w.requests).toHaveLength(0);
    }
  });
  it('publishes no prototype after the requesting member is revoked during the provider call', async () => {
    const w = await fixture();
    await w.edit(passage);
    w.setBeforeReply(async () => {
      await w.store.tx(async () => {
        await w.store.lock('project:' + w.project.id);
        await w.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          w.project.id,
          w.user.id,
        );
      });
    });
    await w.runtime.executeJob(w.jobs[0]!, {
      messageId: 'revoked',
      deliveryCount: 1,
    });
    expect(
      await w.store.all('SELECT id FROM studio_investigations'),
    ).toHaveLength(0);
    expect((await w.runtime.get(w.jobs[0]!))!.status).not.toBe('completed');
  });
  it('rolls the observer intent back together with a rejected source write', async () => {
    const w = await fixture(),
      source = await w.store.artifact(w.project.mainArtifactId, w.user.id);
    await expect(
      w.store.tx(async () => {
        await w.edit(passage);
        throw new Error('review hook rollback');
      }),
    ).rejects.toThrow('review hook rollback');
    expect(w.jobs).toHaveLength(0);
    expect(
      await w.store.all('SELECT id FROM studio_durable_jobs'),
    ).toHaveLength(0);
    expect((await w.store.artifact(source.id, w.user.id)).version).toBe(
      source.version,
    );
  });
  it('enforces the shared classifier budget before provider I/O', async () => {
    const w = await fixture();
    for (let index = 0; index < 6; index++)
      await w.store.exec(
        'INSERT INTO studio_spike_checks(artifact_id,user_id,source_version,created_at) VALUES(?,?,?,?)',
        w.project.mainArtifactId,
        w.user.id,
        100 + index,
        Date.now(),
      );
    await w.edit(passage);
    await w.runtime.executeJob(w.jobs[0]!, {
      messageId: 'budget',
      deliveryCount: 1,
    });
    expect(w.requests).toHaveLength(0);
    expect(
      await w.store.all('SELECT id FROM studio_investigations'),
    ).toHaveLength(0);
  });
  it('fences a changed passage during classification and schedules the newest saved source', async () => {
    const w = await fixture();
    await w.edit(passage);
    let changed = false;
    const latest = passage + ' Explicitly measure cold startup latency.';
    w.setBeforeReply(async () => {
      if (!changed) {
        changed = true;
        await w.edit(latest);
      }
    });
    await w.runtime.executeJob(w.jobs[0]!, {
      messageId: 'superseded',
      deliveryCount: 1,
    });
    expect(
      await w.store.all('SELECT id FROM studio_investigations'),
    ).toHaveLength(0);
    expect(w.jobs).toHaveLength(2);
    await w.runtime.executeJob(w.jobs[1]!, {
      messageId: 'newest',
      deliveryCount: 1,
    });
    expect(
      (await w.investigations.list(w.user, w.project.mainArtifactId)).records,
    ).toHaveLength(1);
    expect(JSON.stringify(w.requests[1].body)).toContain(latest);
  });
});
