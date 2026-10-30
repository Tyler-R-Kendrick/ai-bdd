import { createServer } from 'node:http';
import { appendFile, writeFile } from 'node:fs/promises';
import { Store } from '../../server/store.ts';
import { DurableJobCoordinator } from '../../server/runtime/jobs.ts';
import { LocalJobDispatcher } from '../../server/hosting/local-queue.ts';
import { createLocalMaintenance } from '../../server/runtime/local-maintenance.ts';
const [mode, database, receiptFile, completionFile] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const store = await Store.open(database),
  dispatcher = new LocalJobDispatcher();
const runtime = new DurableJobCoordinator({ store, dispatcher, leaseMs: 5000 });
await runtime.ready;
dispatcher.bind(runtime.executeJob);
await store.db.exec(
  'CREATE TABLE IF NOT EXISTS local_cycle_publications(job_id TEXT PRIMARY KEY,started_at BIGINT NOT NULL)',
);
runtime.register('fixture.local-maintenance', async (ctx) => {
  const startedAt = Date.now();
  await ctx.step('external-receipt', async () => {
    await appendFile(receiptFile, 'external-effect\n');
    return { saved: true };
  });
  if (mode === 'seed') {
    process.send?.({ type: 'claimed', jobId: ctx.job.id });
    await new Promise<void>((_resolve, reject) =>
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), {
        once: true,
      }),
    );
  }
  return ctx.commit('publish-once', async () => {
    await store.exec(
      'INSERT INTO local_cycle_publications VALUES(?,?)',
      ctx.job.id,
      startedAt,
    );
    return { startedAt };
  });
});
const server = createServer((_req, res) => {
  res.end('Local maintenance process fixture');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
if (mode === 'seed') {
  const user = await store.createUser(
      'local-maintenance@example.test',
      'Local worker',
      null,
    ),
    project = await store.createProject(user, 'Local recovery', '');
  const artifact = await store.artifact(project.mainArtifactId, user.id);
  const job = await runtime.enqueue({
    kind: 'fixture.local-maintenance',
    projectId: project.id,
    artifactId: artifact.id,
    principalId: user.id,
    artifactVersion: artifact.version,
    snapshot: { immutable: 'source' },
    idempotencyKey: 'local-maintenance-process-job',
  });
  void runtime.executeJob(job.id, {
    messageId: 'initial-local-delivery',
    deliveryCount: 1,
  });
}
let cycles = 0;
const local = createLocalMaintenance({
  intervalMs: 25,
  runtime,
  maintenance: async () => {
    cycles++;
    if (mode === 'drain') {
      process.send?.({ type: 'maintenance-started' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(
        completionFile,
        JSON.stringify({ maintenanceFinished: true, cycles }),
      );
    }
    const publication = await store.one(
      'SELECT p.job_id,p.started_at,j.status,j.attempts FROM local_cycle_publications p JOIN studio_durable_jobs j ON j.id=p.job_id LIMIT 1',
    );
    if (publication)
      await writeFile(completionFile, JSON.stringify(publication));
  },
});
if (mode !== 'seed') {
  const before = await store.one(
    'SELECT id,status,lease_expires,attempts FROM studio_durable_jobs LIMIT 1',
  );
  // Startup recovery must leave the still-owned lease alone; later periodic recovery must resume it.
  await runtime.recover({ dispatchLimit: 5 });
  process.send?.({
    type: 'ready',
    before,
    after: await store.one(
      'SELECT id,status,lease_expires,attempts FROM studio_durable_jobs LIMIT 1',
    ),
  });
  local.start();
}
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  void (async () => {
    await local.close();
    await runtime.close();
    await dispatcher.close();
    await store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.send)
      process.send({ type: 'closed', cycles }, () => process.exit(0));
    else process.exit(0);
  })().catch(() => process.exit(1));
});
