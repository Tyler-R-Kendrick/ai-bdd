import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.ts';
import { Collaboration } from '../server/collaboration.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { Agent } from '../server/agent.ts';
import { closeLocalModels } from '../server/local/model.ts';
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID } from '../server/local/catalog.ts';
import { integrationSettingsFromEnv } from '../server/integrations/settings.ts';
const directory = process.env.STUDIO_LOCAL_TEST_MODEL_DIR;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeLocalModels();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('accepts only an operator-selected absolute offline asset directory', () => {
  expect(
    integrationSettingsFromEnv({ STUDIO_LOCAL_MODEL_DIR: '/opt/studio-model' })
      .localModel,
  ).toEqual({ directory: '/opt/studio-model' });
  expect(() =>
    integrationSettingsFromEnv({
      STUDIO_LOCAL_MODEL_DIR: 'https://example.test/model.gguf',
    }),
  ).toThrow('absolute');
  expect(() =>
    integrationSettingsFromEnv({ STUDIO_LOCAL_MODEL_DIR: 'relative' }),
  ).toThrow('absolute');
});
describe.skipIf(!directory)(
  'real CPU model through the artifact Agent and SQL durable runtime',
  () => {
    it('persists a selected local profile and one generated response across duplicate job deliveries without Gateway calls', async () => {
      const store = await Store.open(':memory:');
      cleanup.push(() => store.close());
      const settings: any = {
        production: false,
        origin: 'http://127.0.0.1:8787',
        dataDir: '/tmp/studio-local-agent-test',
        demo: false,
        model: 'deliberately-unused-paid-model',
        integrations: { localModel: { directory } },
      };
      const collab = new Collaboration(store, { settings } as any);
      await collab.initialize();
      cleanup.push(() => collab.close());
      const runtime = new DurableJobCoordinator({
        store,
        dispatcher: {
          provider: 'explicit-local-acceptance-dispatch',
          publish: async () => ({
            provider: 'explicit-local-acceptance-dispatch',
          }),
        },
      });
      await runtime.ready;
      cleanup.push(() => runtime.close());
      const agent = new Agent(store, settings, collab, { runtime });
      await agent.initialize();
      const user = await store.createUser(
          'cpu@test.invalid',
          'CPU owner',
          null,
        ),
        project = await store.createProject(user, 'Local model acceptance', ''),
        artifact = await store.artifact(project.mainArtifactId, user.id),
        thread = (await store.threads(artifact.id))[0]!.id;
      const selected = {
        harness: 'local-cpu',
        provider: LOCAL_PROVIDER_ID,
        model: LOCAL_MODEL_ID,
      } as const;
      await agent.profiles.view(user, artifact.id, selected);
      expect(await agent.captureProfile(user, artifact.id)).toEqual(selected);
      const resolved = agent.modelForProfile(
        selected,
        'independent-local-proof',
      );
      if (typeof resolved === 'string')
        throw new Error('Local inference must be a concrete model');
      expect(resolved.provider).toBe(LOCAL_PROVIDER_ID);
      const network = vi.spyOn(globalThis, 'fetch');
      await store.message(
        user,
        artifact.id,
        thread,
        'What is 2 + 2? Please answer briefly.',
      );
      const job = await agent.respond(user, artifact.id, thread, 'chat');
      await runtime.executeJob(job.id, {
        messageId: 'local-acceptance-first',
        deliveryCount: 1,
      });
      expect((await runtime.get(job.id))?.status).toBe('completed');
      await runtime.executeJob(job.id, {
        messageId: 'local-acceptance-replay',
        deliveryCount: 2,
      });
      const responses = (
        await store.messagePage(artifact.id, thread, { limit: 20 })
      ).messages.filter((message) => message.role === 'assistant');
      expect(responses).toHaveLength(1);
      expect(responses[0]!.body).toContain('4');
      expect(network).not.toHaveBeenCalled();
      expect((await store.artifact(artifact.id, user.id)).version).toBe(
        artifact.version,
      );
    });
  },
);
