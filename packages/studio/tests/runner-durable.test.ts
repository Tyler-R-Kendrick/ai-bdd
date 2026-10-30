import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, hash } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { createDurableJobRuntime } from '../server/runtime/jobs.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import { ObjectWorkspaceStore } from '../server/hosting/workspaces.ts';
import { Runner } from '../server/runner.ts';
import { testSettings } from './helpers.ts';
let executions = 0;
vi.mock('@ai-bdd/sdk', () => ({
  loadConfig: async () => ({}),
  createPlanStore: () => ({ loadAll: async () => [] }),
  createEngine: (config: any) => ({
    config,
    close: async () => {},
    run: async () => {
      executions++;
      const runId = randomUUID(),
        path = 'evidence/capture.png',
        bytes = Buffer.from('deterministic-engine-evidence');
      await mkdir(resolve(config.runsDir, runId, 'evidence'), {
        recursive: true,
      });
      await writeFile(resolve(config.runsDir, runId, path), bytes);
      return {
        runId,
        exitCode: 0,
        scenarios: [
          {
            status: 'passed',
            steps: [
              {
                evidence: [
                  {
                    id: 'capture',
                    path,
                    kind: 'screenshot',
                    sha256: hash(bytes),
                  },
                ],
              },
            ],
          },
        ],
      };
    },
    verifyRun: async () => ({ ok: true }),
  }),
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(postgres = false) {
  const directory = await mkdtemp('/workspace/ai-bdd/work/runner-durable-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = postgres
    ? await openDatabase({
        adapter: 'postgres',
        url: process.env.STUDIO_TEST_POSTGRES_URL!,
        schema: 'runner_' + randomUUID().replaceAll('-', ''),
      })
    : undefined;
  const store = await Store.open(database ?? ':memory:');
  cleanup.push(() => store.close());
  const user = await store.createUser(
      randomUUID() + '@example.test',
      'Owner',
      null,
    ),
    project = await store.createProject(user, 'Durable runner', '');
  const objects = new DiskObjectStore(resolve(directory, 'objects')),
    workspaces = new ObjectWorkspaceStore(objects),
    messages: string[] = [];
  const jobs = {
    provider: 'test',
    publish: async (id: string) => {
      messages.push(id);
      return { provider: 'test' };
    },
  };
  const runtime = await createDurableJobRuntime({ store, dispatcher: jobs });
  cleanup.push(() => runtime.close());
  const notify = vi.fn(async () => {}),
    runner = new Runner(
      store,
      {
        ...testSettings(directory),
        runnerConfig: resolve(directory, 'operator.mjs'),
      },
      { notify } as any,
      { runtime, hosting: { objects, workspaces, jobs } },
    );
  await runner.initialize();
  return {
    directory,
    store,
    user,
    project,
    runtime,
    runner,
    messages,
    objects,
  };
}
describe('durable runner snapshots and retained evidence', () => {
  for (const postgres of [false, true])
    it.skipIf(postgres && !process.env.STUDIO_TEST_POSTGRES_URL)(
      `executes immutable input and publishes evidence once across redelivery (${postgres ? 'PostgreSQL' : 'SQLite'})`,
      async () => {
        const {
          store,
          user,
          project,
          runtime,
          runner,
          messages,
          directory,
          objects,
        } = await fixture(postgres);
        executions = 0;
        const admitted = await runner.run(user, project!.mainArtifactId);
        expect(messages).toHaveLength(1);
        await runtime.executeJob(messages[0]!, {
          messageId: 'first',
          deliveryCount: 1,
        });
        await runtime.executeJob(messages[0]!, {
          messageId: 'duplicate',
          deliveryCount: 2,
        });
        expect(executions).toBe(1);
        const run = await store.run(admitted.id, project!.mainArtifactId);
        expect(run!.status).toBe('passed');
        expect(run!.result.evidenceWorkspace.key).toContain('/manifests/');
        expect(
          (
            await runner.evidence(
              user,
              project!.mainArtifactId,
              admitted.id,
              'capture',
            )
          ).bytes.toString(),
        ).toBe('deterministic-engine-evidence');
        const another = new Runner(
          store,
          {
            ...testSettings(directory),
            runnerConfig: resolve(directory, 'operator.mjs'),
          },
          { notify: async () => {} } as any,
          {
            runtime,
            hosting: {
              objects,
              workspaces: new ObjectWorkspaceStore(objects),
              jobs: {
                provider: 'unused',
                publish: async () => ({ provider: 'unused' }),
              },
            },
          },
        );
        expect(
          (
            await another.evidence(
              user,
              project!.mainArtifactId,
              admitted.id,
              'capture',
            )
          ).bytes.toString(),
        ).toBe('deterministic-engine-evidence');
      },
    );
  it('downloads an exact retained run after more than100 newer runs', async () => {
    const { directory, store, user, project, runner } = await fixture();
    const artifactId = project!.mainArtifactId,
      runId = randomUUID(),
      bytes = Buffer.from('historical evidence');
    await mkdir(
      resolve(directory, 'workspaces', artifactId, 'runs', 'retained'),
      { recursive: true },
    );
    await writeFile(
      resolve(
        directory,
        'workspaces',
        artifactId,
        'runs',
        'retained',
        'capture.png',
      ),
      bytes,
    );
    const result = {
      runId: 'retained',
      scenarios: [
        {
          steps: [
            {
              evidence: [
                {
                  id: 'old',
                  path: 'capture.png',
                  kind: 'screenshot',
                  sha256: hash(bytes),
                },
              ],
            },
          ],
        },
      ],
    };
    await store.exec(
      'INSERT INTO runs(id,artifact_id,artifact_version,status,result,created_at) VALUES(?,?,?,?,?,?)',
      runId,
      artifactId,
      1,
      'passed',
      JSON.stringify(result),
      '2020-01-01',
    );
    for (let index = 0; index < 105; index++)
      await store.exec(
        'INSERT INTO runs(id,artifact_id,artifact_version,status,created_at) VALUES(?,?,?,?,?)',
        randomUUID(),
        artifactId,
        1,
        'failed',
        `2026-10-30T00:00:${index}`,
      );
    expect((await store.runs(artifactId)).some((row) => row.id === runId)).toBe(
      false,
    );
    expect(
      (await runner.evidence(user, artifactId, runId, 'old')).bytes,
    ).toEqual(bytes);
  });
});
