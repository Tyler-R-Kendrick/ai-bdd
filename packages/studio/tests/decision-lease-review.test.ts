import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, HttpError, hash } from '../server/store.ts';
import { RepositoryIdentity } from '../server/identity/github.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionSettingsFromEnv } from '../server/decisions/settings.ts';
import { identityHarness } from './identity/harness.ts';

it.each([45000, 600])(
  'renews still-valid real repository entitlement before publishing a native HTTP decision after permission TTL expires (worker lease %i ms)',
  async (leaseMs) => {
    const h = await identityHarness(),
      store = await Store.open(':memory:');
    let models: DecisionModels | undefined;
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      await delay(5500); // Longer than the supported five-second repository lease, shorter than model timeout.
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          model: body.model,
          answers: body.questions.map((q: any) => ({
            name: q.name,
            type: 'predicate',
            probability: 0.99,
          })),
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const user = await store.createUser(
          'decision-lease-review@example.test',
          'Lease review',
          null,
        ),
        repository = 'https://github.com/acme/private',
        project = await store.createProject(
          user,
          'Lease review',
          '',
          repository,
        ),
        artifact = await store.artifact(project.mainArtifactId, user.id);
      await h.store.exec(
        'INSERT INTO users VALUES(?,?,?,?)',
        user.id,
        user.email,
        user.name,
        user.color,
      );
      await h.store.exec(
        'INSERT INTO sessions VALUES(?,?,?,?)',
        hash(user.id + '-session'),
        user.id,
        Date.now() + 3600000,
        'session',
      );
      h.fixture.permissions.set('101:acme/private', {
        pull: true,
        push: true,
      });
      expect((await h.connect(user)).response.statusCode).toBe(302);
      await h.project(user);
      const identity = new RepositoryIdentity(h.store, h.auth, {
        ...h.settings,
        repositoryIdentity: {
          ...h.settings.repositoryIdentity!,
          leaseSeconds: 5,
        },
      });
      await identity.initialize();
      store.repositoryAuthorizer = async (
        _projectId,
        userId,
        action,
        atomic,
      ) => {
        const permission = action === 'read' ? 'read' : 'write';
        if (atomic) {
          await store.lock('repository-identity:' + userId);
          if (!(await identity.checkLease(userId, repository, permission)))
            throw new HttpError(403, 'Repository permission lease expired');
        } else await identity.assertRepository(user, repository, permission);
      };
      models = new DecisionModels({
        store,
        settings: {
          ...decisionSettingsFromEnv(
            {
              NODE_ENV: 'test',
              STUDIO_DECISION_PROVIDER: 'openai-decisions',
              STUDIO_OPENAI_DECISIONS_KEY: 'explicit-local-fixture-only',
              STUDIO_OPENAI_DECISIONS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
              STUDIO_DECISION_TIMEOUT_MS: '10000',
            },
            false,
          ),
          leaseMs,
        },
      });
      await models.ready;
      const profile = await models.captureProfile(user, artifact.id);
      let result: unknown, error: unknown;
      try {
        result = await models.decide({
          user,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          profile,
          input: 'An unresolved boundary choice needs a decision.',
          purpose: 'conversation-offer',
          questions: [
            {
              id: 'choice',
              kind: 'boolean',
              instructions: 'Does the input contain an unresolved choice?',
            },
          ],
          idempotencyKey: crypto.randomUUID(),
        });
      } catch (caught) {
        error = caught;
      }
      // The provider still authorizes this exact user. Expiry should renew, not fabricate revocation.
      await expect(
        identity.assertRepository(user, repository, 'write'),
      ).resolves.toBeUndefined();
      expect(error).toBeUndefined();
      expect(result).toMatchObject({ status: 'answered' });
    } finally {
      await models?.close();
      await store.close();
      await h.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  15000,
);
