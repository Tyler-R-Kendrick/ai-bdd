import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import { ImplementationDrafting } from '../server/integrations/implementation-drafting.ts';
import type { ImplementationDefinition } from '../shared/implementation.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const definition: ImplementationDefinition = {
  tasks: [
    {
      id: 'boundary',
      title: 'Verify the boundary',
      description: 'Implement the reviewed contract.',
      acceptanceCriteria: ['The consumer passes its declared contract.'],
    },
  ],
  edges: [],
};
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !pg)(
    adapter + ' durable graph drafting',
    () => {
      async function fixture(provider = vi.fn(async () => definition)) {
        const schema = 'test_' + randomUUID().replaceAll('-', '');
        const store = await Store.open(
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({ adapter: 'postgres', url: pg!, schema }),
        );
        cleanup.push(async () => {
          if (adapter === 'postgres')
            await store.db.exec('DROP SCHEMA "' + schema + '" CASCADE');
          await store.close();
        });
        const user = await store.createUser(
          'draft-' + randomUUID() + '@example.test',
          'Draft owner',
          null,
        );
        const project = await store.createProject(
          user,
          'Grounded implementation',
          'A concrete boundary',
          'https://github.com/example/draft-fixture',
        );
        const artifact = await store.artifact(
          project.mainArtifactId,
          user.id,
        );
        const runtime = new DurableJobCoordinator({
          store,
          dispatcher: {
            provider: 'explicit-dispatch-fixture',
            publish: async () => ({ provider: 'explicit-dispatch-fixture' }),
          },
        });
        await runtime.ready;
        cleanup.push(() => runtime.close());
        const graphs = new ImplementationGraphs({ store });
        await graphs.initialize();
        const service = new ImplementationDrafting({
          store,
          runtime,
          graphs,
          provider,
          allowed: async () => true,
          onAdmit: async () => {},
        });
        await service.initialize();
        const execute = (id: string) =>
          runtime.executeJob(id, {
            messageId: 'delivery-' + id,
            deliveryCount: 1,
          });
        return {
          store,
          user,
          artifact,
          project,
          runtime,
          graphs,
          service,
          provider,
          execute,
        };
      }
      it('coalesces concurrent presses, retains stable request aliases after completion, and publishes an unapproved graph once', async () => {
        const w = await fixture(),
          a = randomUUID(),
          b = randomUUID();
        const [first, second] = await Promise.all([
          w.service.start(w.user, w.artifact.id, a),
          w.service.start(w.user, w.artifact.id, b),
        ]);
        expect(second.id).toBe(first.id);
        await w.execute(first.id);
        await w.execute(first.id);
        expect((await w.service.start(w.user, w.artifact.id, b)).id).toBe(
          first.id,
        );
        const state = await w.graphs.read(w.user, w.artifact.id);
        expect(state.graph?.status).toBe('draft');
        expect(state.activeRun).toBeNull();
        expect(state.graph?.definition).toEqual(definition);
        expect(w.provider).toHaveBeenCalledTimes(1);
        expect((await w.runtime.get(first.id))?.status).toBe('completed');
      });
      it('does not overwrite a newer human graph while the model is running', async () => {
        let release!: (value: ImplementationDefinition) => void,
          entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const provider = vi.fn(async () => {
          entered();
          return new Promise<ImplementationDefinition>((resolve) => {
            release = resolve;
          });
        });
        const w = await fixture(provider),
          job = await w.service.start(w.user, w.artifact.id);
        const executing = w.execute(job.id);
        await started;
        const humanDefinition = {
          tasks: [{ ...definition.tasks[0]!, title: 'Human-reviewed scope' }],
          edges: [],
        };
        await w.graphs.edit({ user: w.user, kind: 'human' }, w.artifact.id, {
          expected: null,
          planRevision: w.artifact.version,
          definition: humanDefinition,
        });
        release(definition);
        await executing;
        expect(
          (await w.graphs.read(w.user, w.artifact.id)).graph?.definition,
        ).toEqual(humanDefinition);
        expect((await w.runtime.get(job.id))?.status).not.toBe('completed');
      });
      it('fences changed source after the external step and publishes neither a graph nor a completed result', async () => {
        let release!: (value: ImplementationDefinition) => void,
          entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const w = await fixture(
          vi.fn(async () => {
            entered();
            return new Promise<ImplementationDefinition>((resolve) => {
              release = resolve;
            });
          }),
        );
        const job = await w.service.start(w.user, w.artifact.id),
          executing = w.execute(job.id);
        await started;
        await w.store.updateArtifact(
          w.user,
          w.artifact.id,
          w.artifact.version,
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'A revised human plan' }],
                },
              ],
            },
          },
        );
        release(definition);
        await executing;
        expect((await w.graphs.read(w.user, w.artifact.id)).graph).toBeNull();
        expect((await w.runtime.get(job.id))?.status).not.toBe('completed');
      });
    },
  );
