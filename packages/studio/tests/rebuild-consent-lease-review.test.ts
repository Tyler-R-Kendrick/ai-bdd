import { expect, it } from 'vitest';
import { Store, HttpError, hash } from '../server/store.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import { RebuildMachines } from '../server/integrations/rebuild-machines.ts';
import { identityHarness } from './identity/harness.ts';
it('renews the original builders still-valid repository permission before browser rebuild consent', async () => {
  const h = await identityHarness(),
    store = await Store.open(':memory:');
  try {
    const user = await store.createUser(
        'rebuild-consent-review@example.test',
        'Consent review',
        null,
      ),
      repository = 'https://github.com/acme/private',
      project = await store.createProject(
        user,
        'Consent review',
        '',
        repository,
      );
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
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    expect((await h.connect(user)).response.statusCode).toBe(302);
    await h.project(user);
    store.repositoryAuthorizer = async (_project, userId, action, atomic) => {
      const permission = action === 'read' ? 'read' : 'write';
      if (atomic) {
        await store.lock('repository-identity:' + userId);
        if (!(await h.identity.checkLease(userId, repository, permission)))
          throw new HttpError(403, 'Repository permission lease expired');
      } else await h.identity.assertRepository(user, repository, permission);
    };
    const machines = new MachineService(store, { notify() {} } as any);
    await machines.initialize();
    const credentials = await machines.pair(
        (await machines.pairing(user, project.id, 'Consent reviewer laptop'))
          .code,
      ),
      principal = await store.one(
        'SELECT * FROM studio_machines WHERE id=?',
        credentials.id,
      );
    const investigations = new InvestigationService({
      store,
      auth: {} as any,
      machines,
      objects: {} as any,
    });
    await investigations.ready;
    await investigations.registerCheckout(principal, {
      repository,
      sourceCommit: 'a'.repeat(40),
      branch: 'main',
    });
    const graphs = await new ImplementationGraphs({ store }).initialize(),
      rebuilds = new RebuildMachines({
        store,
        auth: {} as any,
        graphs,
        machines,
        assertReady: async () => {},
        resolvePullRequest: async () => {
          throw new Error('This consent action must not query PRs.');
        },
      });
    await rebuilds.ready;
    await h.store.exec(
      'UPDATE repository_identity_leases SET expires_at=0 WHERE user_id=?',
      user.id,
    );
    let result: unknown, error: unknown;
    try {
      result = await rebuilds.consent(user, credentials.id, true);
    } catch (caught) {
      error = caught;
    }
    await expect(
      h.identity.assertRepository(user, repository, 'write'),
    ).resolves.toBeUndefined();
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ enabled: true, repository });
  } finally {
    await store.close();
    await h.close();
  }
});
