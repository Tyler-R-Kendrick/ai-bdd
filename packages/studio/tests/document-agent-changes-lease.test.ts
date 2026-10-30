import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, HttpError, hash } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { RepositoryIdentity } from '../server/identity/github.ts';
import {
  recordAgentDocumentChanges,
  recentAgentDocumentChanges,
} from '../server/document-agent-changes.ts';
import { paragraph } from '../shared/domain.ts';
import { identityHarness } from './identity/harness.ts';

const postgres = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', ...(postgres ? ['postgres'] : [])]) {
  it(`renews healthy real repository entitlement for recent change reads after lease expiry (${adapter})`, async () => {
    const h = await identityHarness();
    const store = await Store.open(
      adapter === 'postgres'
        ? await openDatabase({
            adapter: 'postgres',
            url: postgres!,
            schema: 'marker_lease_' + randomUUID().replaceAll('-', ''),
          })
        : ':memory:',
    );
    try {
      const user = await store.createUser(
        'marker-lease-' + randomUUID() + '@example.test',
        'Actual repository reader',
        null,
      );
      const repository = 'https://github.com/acme/private';
      const project = await store.createProject(
        user,
        'Marker lease',
        '',
        repository,
      );
      const initial = await store.artifact(project.mainArtifactId, user.id);
      const before = await store.updateArtifact(
        user,
        initial.id,
        initial.version,
        {
          doc: { type: 'doc', content: [paragraph('Original requirement')] },
        },
      );
      const saved = await store.tx(async () => {
        const content = structuredClone(before.content);
        content.doc.content[0].content[0].text = 'Accepted agent requirement';
        const next = await store.updateArtifact(
          user,
          before.id,
          before.version,
          content,
        );
        await recordAgentDocumentChanges(
          store,
          user,
          before.id,
          before.content.doc,
          'Accepted agent proposal',
        );
        return next;
      });
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
        _project,
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
      // Prime the same production-style authorizer outside SQL, then confirm exact marker visibility.
      await store.artifact(saved.id, user.id);
      expect(
        await recentAgentDocumentChanges(store, user, saved.id),
      ).toHaveLength(1);
      await delay(5500); // Supported five-second lease expires; the thirty-second marker does not.
      expect(await identity.checkLease(user.id, repository, 'read')).toBe(
        false,
      );
      let markers: unknown, error: unknown;
      try {
        markers = await recentAgentDocumentChanges(store, user, saved.id);
      } catch (caught) {
        error = caught;
      }
      // A real GitHub request still grants this exact user access: TTL expiry is not revocation.
      await expect(
        identity.assertRepository(user, repository, 'read'),
      ).resolves.toBeUndefined();
      expect(error).toBeUndefined();
      expect(markers).toHaveLength(1);
    } finally {
      await store.close();
      await h.close();
    }
  }, 15000);
}
