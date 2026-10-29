import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { CredentialVault } from '../server/identity/vault.ts';
import { DurableChallenges } from '../server/identity/challenges.ts';
import { RepositoryIdentity } from '../server/identity/github.ts';
import { identityHarness } from './identity/harness.ts';

let h: Awaited<ReturnType<typeof identityHarness>>;
beforeEach(async () => {
  h = await identityHarness();
});
afterEach(async () => {
  await h.close();
});
const repository = 'https://github.com/acme/private';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
describe('durable connection challenges and credential vault', () => {
  it('uses shared one-use state and cookie binding across adapter instances, with expiry enforced atomically', async () => {
    const state = randomBytes(32).toString('base64url'),
      binding = randomBytes(32).toString('base64url');
    await h.identity.challenges.put(
      'oidc',
      state,
      binding,
      { verifier: 'fixture-verifier', nonce: 'fixture-nonce' },
      Date.now() + 300000,
    );
    const another = new DurableChallenges(h.store);
    await another.initialize();
    expect(await another.consume('oidc', state, 'wrong-binding')).toBeNull();
    expect(
      (await another.consume<{ nonce: string }>('oidc', state, binding))
        ?.payload.nonce,
    ).toBe('fixture-nonce');
    expect(
      await h.identity.challenges.consume('oidc', state, binding),
    ).toBeNull();
    await another.put(
      'oidc',
      state,
      binding,
      { verifier: 'fixture' },
      Date.now() + 300000,
    );
    await h.store.exec(
      'UPDATE identity_challenges SET expires_at=?',
      Date.now() - 1,
    );
    expect(await another.consume('oidc', state, binding)).toBeNull();
  });
  it('encrypts with a stable key and authenticates user, purpose and ciphertext rather than storing plaintext tokens', () => {
    const key = randomBytes(32).toString('base64url'),
      first = new CredentialVault(key),
      second = new CredentialVault(key),
      sealed = first.seal('sensitive-test-access-token', 'user-a', 'access');
    expect(sealed).not.toContain('sensitive-test-access-token');
    expect(second.open(sealed, 'user-a', 'access')).toBe(
      'sensitive-test-access-token',
    );
    expect(() => second.open(sealed, 'user-b', 'access')).toThrow(
      'could not be decrypted',
    );
    expect(() => second.open(sealed, 'user-a', 'refresh')).toThrow(
      'could not be decrypted',
    );
    expect(() =>
      new CredentialVault(randomBytes(32).toString('base64url')).open(
        sealed,
        'user-a',
        'access',
      ),
    ).toThrow('could not be decrypted');
    const parts = sealed.split('.');
    parts[3] = randomBytes(16).toString('base64url');
    expect(() => second.open(parts.join('.'), 'user-a', 'access')).toThrow(
      'could not be decrypted',
    );
  });
});
describe('actual HTTP GitHub OAuth and per-user repository permissions', () => {
  it('completes PKCE, stores encrypted expiring credentials, rejects replay, and never grants another user operator-token access', async () => {
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    const connected = await h.connect();
    expect(connected.response.statusCode).toBe(302);
    expect(
      new URL(connected.url).searchParams.get('code_challenge_method'),
    ).toBe('S256');
    const row = await h.store.one(
      'SELECT * FROM repository_identities WHERE user_id=?',
      h.users[0]!.id,
    );
    expect(JSON.stringify(row)).not.toContain('test-ghu-');
    expect(JSON.stringify(row)).not.toContain('test-ghr-');
    expect(Number(row.access_expires)).toBeGreaterThan(Date.now());
    await h.identity.assertRepository(h.users[0]!, repository, 'write');
    expect(
      await h.identity.checkLease(h.users[0]!.id, repository, 'write'),
    ).toBe(true);
    (h.settings as any).githubToken = 'operator-master-test-token';
    (h.settings as any).githubRepositories = ['acme/private'];
    await expect(
      h.identity.assertRepository(h.users[2]!, repository, 'read'),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      h.fixture.requests.some((r) =>
        r.authorization.includes('operator-master'),
      ),
    ).toBe(false);
    const replay = await h.app.inject({
      url:
        new URL(connected.callback).pathname +
        new URL(connected.callback).search,
      headers: { cookie: 'studio_repository_oauth=' + connected.browserCookie },
    });
    expect(replay.statusCode).toBe(401);
  });
  it('uses the selected user token, requires both project membership and pull/push permission, and filters inaccessible projects', async () => {
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    h.fixture.permissions.set('202:acme/private', { pull: true, push: false });
    await h.connect();
    await h.connect(h.users[1]!, { id: 202, login: 'bob-fixture' });
    await h.project(h.users[0]!);
    await h.project(h.users[1]!);
    await h.identity.assertRepository(h.users[1]!, repository, 'read');
    await expect(
      h.identity.assertRepository(h.users[1]!, repository, 'write'),
    ).rejects.toMatchObject({ statusCode: 403 });
    await h.identity.assertRepository(h.users[0]!, repository, 'write');
    const result = await h.identity.readRepository(h.users[0]!, repository, {
      kind: 'pull_request',
      number: 7,
    });
    expect(result).toMatchObject({ title: 'Protected fixture change' });
    const row = await h.store.one(
        'SELECT * FROM repository_identities WHERE user_id=?',
        h.users[0]!.id,
      ),
      token = new CredentialVault(
        h.settings.repositoryIdentity!.encryptionKey,
      ).open(row.access_cipher, h.users[0]!.id, 'access');
    expect(
      h.fixture.requests.findLast((r) => r.path.endsWith('/pulls/7'))
        ?.authorization,
    ).toBe('Bearer ' + token);
    await h.store.exec(
      'DELETE FROM memberships WHERE project_id=? AND user_id=?',
      'private-project',
      h.users[1]!.id,
    );
    await expect(
      h.identity.readRepository(h.users[1]!, repository, {
        kind: 'file',
        path: 'README.md',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const supplied = await h.store.projects(h.users[0]!.id);
    expect(await h.identity.filteredProjects(h.users[2]!, supplied)).toEqual(
      [],
    );
    expect((await h.identity.filteredProjects(h.users[0]!)).length).toBe(1);
  });
  it('refreshes expired user credentials through the provider and invalidates old permission leases', async () => {
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    await h.connect();
    await h.identity.assertRepository(h.users[0]!, repository, 'read');
    const before = await h.store.one(
      'SELECT * FROM repository_identities WHERE user_id=?',
      h.users[0]!.id,
    );
    await h.store.exec(
      'UPDATE repository_identities SET access_expires=? WHERE user_id=?',
      Date.now() - 1,
      h.users[0]!.id,
    );
    expect(
      await h.identity.checkLease(h.users[0]!.id, repository, 'read'),
    ).toBe(false);
    await h.identity.assertRepository(h.users[0]!, repository, 'read');
    const after = await h.store.one(
      'SELECT * FROM repository_identities WHERE user_id=?',
      h.users[0]!.id,
    );
    expect(h.fixture.refreshCount).toBe(1);
    expect(after.version).toBe(before.version + 1);
    expect(after.access_cipher).not.toBe(before.access_cipher);
    expect(
      await h.identity.checkLease(h.users[0]!.id, repository, 'read'),
    ).toBe(true);
  });
  it('removes invalid refresh grants and revokes provider tokens without keeping shared-instance leases alive', async () => {
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    await h.connect();
    await h.identity.assertRepository(h.users[0]!, repository, 'read');
    const other = new RepositoryIdentity(h.store, h.auth, h.settings);
    await other.initialize();
    expect(await other.checkLease(h.users[0]!.id, repository, 'read')).toBe(
      true,
    );
    const revoked = await h.app.inject({
      method: 'DELETE',
      url: '/api/identity/github',
      headers: { origin: h.origin, cookie: h.cookieFor(h.users[0]!) },
    });
    expect(revoked.statusCode).toBe(200);
    expect(h.fixture.revocations).toBe(1);
    expect(await other.checkLease(h.users[0]!.id, repository, 'read')).toBe(
      false,
    );
    await h.connect();
    h.fixture.revokeRefreshes();
    await h.store.exec(
      'UPDATE repository_identities SET access_expires=? WHERE user_id=?',
      Date.now() - 1,
      h.users[0]!.id,
    );
    await expect(
      h.identity.assertRepository(h.users[0]!, repository, 'read'),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(
      await h.store.one(
        'SELECT user_id FROM repository_identities WHERE user_id=?',
        h.users[0]!.id,
      ),
    ).toBeUndefined();
  });
  it('invalidates repository permission leases from a signed webhook across instances and rejects forged bodies', async () => {
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    await h.connect();
    await h.identity.assertRepository(h.users[0]!, repository, 'read');
    const other = new RepositoryIdentity(h.store, h.auth, h.settings);
    await other.initialize();
    const body = JSON.stringify({
        action: 'removed',
        repository: { full_name: 'acme/private' },
      }),
      url = '/api/auth/repository/github/webhook';
    const rejected = await h.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'member',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      },
      payload: body,
    });
    expect(rejected.statusCode).toBe(401);
    expect(await other.checkLease(h.users[0]!.id, repository, 'read')).toBe(
      true,
    );
    const signature =
      'sha256=' +
      createHmac('sha256', h.settings.repositoryIdentity!.webhookSecret!)
        .update(body)
        .digest('hex');
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'member',
            'x-hub-signature-256': signature,
          },
          payload: body,
        })
      ).statusCode,
    ).toBe(202);
    expect(await other.checkLease(h.users[0]!.id, repository, 'read')).toBe(
      false,
    );
    h.fixture.permissions.set('101:acme/private', { pull: false, push: false });
    await expect(
      other.assertRepository(h.users[0]!, repository, 'read'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it('prevents a delayed old permission response granting access after disconnect and reconnect to another GitHub account', async () => {
    h.fixture.permissions.set('101:acme/private', { pull: true, push: true });
    await h.connect();
    const gate = deferred(),
      entered = deferred();
    h.fixture.gateRepository(async () => {
      entered.resolve();
      await gate.promise;
    });
    const pending = h.identity.assertRepository(
      h.users[0]!,
      repository,
      'write',
      { fresh: true },
    );
    await entered.promise;
    await h.identity.revoke(h.users[0]!.id, false);
    await h.connect(h.users[0]!, { id: 303, login: 'replacement-fixture' });
    h.fixture.gateRepository();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await h.identity.checkLease(h.users[0]!.id, repository, 'write'),
    ).toBe(false);
    expect((await h.identity.status(h.users[0]!)).login).toBe(
      'replacement-fixture',
    );
  });
  it('cancels an already-started OAuth exchange when the user disconnects before the provider returns', async () => {
    const user = h.users[0]!,
      start = await h.app.inject({
        method: 'POST',
        url: '/api/identity/github/start',
        headers: { origin: h.origin, cookie: h.cookieFor(user) },
        payload: {},
      }),
      authorize = await fetch(start.json().authorizationUrl, {
        redirect: 'manual',
      }),
      callback = new URL(authorize.headers.get('location')!),
      binding = start.cookies.find(
        (c) => c.name === 'studio_repository_oauth',
      )!.value,
      gate = deferred(),
      entered = deferred();
    h.fixture.gateToken(async () => {
      entered.resolve();
      await gate.promise;
    });
    const pending = h.app.inject({
      url: callback.pathname + callback.search,
      headers: { cookie: 'studio_repository_oauth=' + binding },
    });
    await entered.promise;
    await h.identity.revoke(user.id, false);
    h.fixture.gateToken();
    gate.resolve();
    expect((await pending).statusCode).toBe(401);
    expect((await h.identity.status(user)).connected).toBe(false);
  });
});
