import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';

const pg = process.env.STUDIO_TEST_POSTGRES_URL;
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function eventually(test: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await test())) {
    if (Date.now() > end)
      throw new Error('Durable process recovery condition did not converge');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const dispatcher = {
  provider: 'explicit-queue-protocol-fixture',
  async publish(_id: string, _options?: unknown) {
    return { provider: 'explicit-queue-protocol-fixture' };
  },
};
async function fixture() {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const first = await Store.open(
      await openDatabase({ adapter: 'postgres', url: pg!, schema }),
    ),
    second = await Store.open(
      await openDatabase({ adapter: 'postgres', url: pg!, schema }),
    );
  cleanup.push(
    () => first.close(),
    () => second.close(),
  );
  const user = await first.createUser(
      'owner-' + randomUUID() + '@example.test',
      'Durable process owner',
      null,
    ),
    project = await first.createProject(user, 'Process recovery', ''),
    artifact = await first.createArtifact(
      user,
      project.id,
      'code',
      'Immutable work',
    );
  await first.db.exec(
    'CREATE TABLE runtime_external_effects(id TEXT PRIMARY KEY,count INTEGER NOT NULL); CREATE TABLE runtime_publications(id TEXT PRIMARY KEY,value TEXT NOT NULL);',
  );
  const enqueue = (runtime: DurableJobCoordinator) =>
    runtime.enqueue({
      kind: 'fixture.process',
      projectId: project.id,
      artifactId: artifact.id,
      principalId: user.id,
      artifactVersion: artifact.version,
      snapshot: { request: 'An immutable process-recovery fixture' },
      idempotencyKey: randomUUID(),
    });
  return { schema, first, second, user, project, artifact, enqueue };
}

describe.skipIf(!pg)(
  'real PostgreSQL process death and queue redelivery',
  () => {
    it('resumes a job after SIGKILL without repeating its completed step or final SQL publication', async () => {
      const w = await fixture(),
        creator = new DurableJobCoordinator({
          store: w.first,
          dispatcher,
          instanceId: 'creator',
          leaseMs: 1000,
        });
      await creator.ready;
      cleanup.push(() => creator.close());
      creator.register('fixture.process', async () => null);
      const job = await w.enqueue(creator),
        dir = await mkdtemp(join(tmpdir(), 'studio-durable-death-')),
        marker = join(dir, 'step-receipt-committed');
      cleanup.push(() => rm(dir, { recursive: true, force: true }));
      const storeUrl = new URL('../server/store.ts', import.meta.url).href,
        persistenceUrl = new URL(
          '../server/persistence/index.ts',
          import.meta.url,
        ).href,
        jobsUrl = new URL('../server/runtime/jobs.ts', import.meta.url).href;
      const source = `import{Store}from ${JSON.stringify(storeUrl)};import{openDatabase}from ${JSON.stringify(persistenceUrl)};import{DurableJobCoordinator}from ${JSON.stringify(jobsUrl)};import{writeFile}from'node:fs/promises';const store=await Store.open(await openDatabase({adapter:'postgres',url:process.env.STUDIO_TEST_POSTGRES_URL,schema:${JSON.stringify(w.schema)}}));const runtime=new DurableJobCoordinator({store,dispatcher:{provider:'child-fixture',publish:async()=>({provider:'child-fixture'})},instanceId:'actual-child-process',leaseMs:1000});await runtime.ready;runtime.register('fixture.process',async ctx=>{await ctx.step('completed-external-step',async()=>{await store.exec("INSERT INTO runtime_external_effects(id,count) VALUES('effect',1) ON CONFLICT(id) DO UPDATE SET count=runtime_external_effects.count+1");return{observed:true};});await writeFile(${JSON.stringify(marker)},'committed');await new Promise(()=>{setInterval(()=>{},1000)});});await runtime.executeJob(${JSON.stringify(job.id)},{messageId:'child-first-delivery',deliveryCount:1});`;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source],
        {
          cwd: resolve(import.meta.dirname, '..'),
          env: { ...process.env, STUDIO_TEST_POSTGRES_URL: pg! },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let childError = '';
      child.stdout.on('data', () => {});
      child.stderr.on('data', (data) => {
        childError = (childError + String(data))
          .slice(-3000)
          .replaceAll(pg!, '[fixture database]');
      });
      cleanup.push(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      await eventually(async () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            'The explicit child worker exited before committing its checkpoint: ' +
              childError,
          );
        try {
          await access(marker);
          return true;
        } catch {
          return false;
        }
      });
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
      expect(
        (
          await w.second.one(
            'SELECT count FROM runtime_external_effects WHERE id=?',
            'effect',
          )
        ).count,
      ).toBe(1);
      await eventually(
        async () =>
          Number(
            (
              await w.second.one(
                'SELECT lease_expires FROM studio_durable_jobs WHERE id=?',
                job.id,
              )
            ).lease_expires,
          ) <= Date.now(),
      );
      const survivor = new DurableJobCoordinator({
        store: w.second,
        dispatcher,
        instanceId: 'surviving-instance',
        leaseMs: 1000,
      });
      await survivor.ready;
      cleanup.push(() => survivor.close());
      survivor.register('fixture.process', async (context) => {
        await context.step('completed-external-step', async () => {
          await w.second.exec(
            "UPDATE runtime_external_effects SET count=count+1 WHERE id='effect'",
          );
          return { observed: true };
        });
        return context.commit('publish-output', async () => {
          await w.second.exec(
            'INSERT INTO runtime_publications VALUES(?,?)',
            job.id,
            'Published by the survivor',
          );
          return { published: true };
        });
      });
      await survivor.recover();
      await survivor.executeJob(job.id, {
        messageId: 'actual-redelivery',
        deliveryCount: 2,
      });
      await creator.executeJob(job.id, {
        messageId: 'duplicate-after-completion',
        deliveryCount: 3,
      });
      expect((await survivor.get(job.id))?.status).toBe('completed');
      expect((await survivor.get(job.id))?.attempt).toBe(2);
      expect(
        (
          await w.second.one(
            'SELECT count FROM runtime_external_effects WHERE id=?',
            'effect',
          )
        ).count,
      ).toBe(1);
      expect(
        (
          await w.second.one(
            'SELECT count(*) AS n FROM runtime_publications WHERE id=?',
            job.id,
          )
        ).n,
      ).toBe(1);
      expect(
        (
          await w.second.one(
            'SELECT count(*) AS n FROM studio_job_receipts WHERE job_id=?',
            job.id,
          )
        ).n,
      ).toBe(2);
    });
    it('admits only one independent worker and preserves publication when duplicate messages race', async () => {
      const w = await fixture(),
        first = new DurableJobCoordinator({
          store: w.first,
          dispatcher,
          instanceId: 'first',
          leaseMs: 1000,
        }),
        second = new DurableJobCoordinator({
          store: w.second,
          dispatcher,
          instanceId: 'second',
          leaseMs: 1000,
        });
      await Promise.all([first.ready, second.ready]);
      cleanup.push(
        () => first.close(),
        () => second.close(),
      );
      let calls = 0;
      for (const [runtime, sourceStore] of [
        [first, w.first],
        [second, w.second],
      ] as const)
        runtime.register('fixture.process', async (context) => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return context.commit('publish-output', async () => {
            await sourceStore.exec(
              'INSERT INTO runtime_publications VALUES(?,?)',
              context.job.id,
              'One publication',
            );
            return { published: true };
          });
        });
      const job = await w.enqueue(first);
      await Promise.all([
        first.executeJob(job.id, { messageId: 'a', deliveryCount: 1 }),
        second.executeJob(job.id, { messageId: 'b', deliveryCount: 1 }),
      ]);
      expect(calls).toBe(1);
      expect((await second.get(job.id))?.status).toBe('completed');
      expect(
        (await w.second.one('SELECT count(*) AS n FROM runtime_publications'))
          .n,
      ).toBe(1);
    });
    it('aborts a live attempt when its principal is revoked on another instance', async () => {
      const w = await fixture(),
        runtime = new DurableJobCoordinator({
          store: w.first,
          dispatcher,
          instanceId: 'worker',
          leaseMs: 150,
        });
      await runtime.ready;
      cleanup.push(() => runtime.close());
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let published = false;
      runtime.register('fixture.process', async (context) => {
        entered();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
        return context.commit('publish-output', async () => {
          published = true;
          return {};
        });
      });
      const job = await w.enqueue(runtime),
        execution = runtime.executeJob(job.id, {
          messageId: 'running',
          deliveryCount: 1,
        });
      await ready;
      await w.second.tx(async () => {
        await w.second.db.lock('project:' + w.project.id);
        await w.second.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          w.project.id,
          w.user.id,
        );
      });
      await execution;
      expect(published).toBe(false);
      expect((await runtime.get(job.id))?.status).toBe('cancelled');
    });
  },
);
