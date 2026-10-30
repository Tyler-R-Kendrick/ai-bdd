import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  createIdentityLeaseHandler,
  PrivateIdentityLeaseClient,
  isValidatedIdentityLease,
  type IdentityScope,
} from '../server/hosting/identity-lease.ts';
import { internalHeaders } from '../server/hosting/internal-auth.ts';
import {
  IDENTITY_PATH,
  IDENTITY_RESPONSE_CONTEXT,
  IDENTITY_LEASE_MS,
} from '../server/hosting/identity-protocol.ts';
const secret = 'fixture-only-identity-service-secret-32characters';
const scope: IdentityScope = {
  ownerId: 'team_Fixture',
  ownerSlug: 'fixture-team',
  projectId: 'prj_Fixture',
  projectName: 'fixture-project',
  environment: 'preview',
  deploymentId: 'dpl_Fixture',
  issuer: 'https://oidc.vercel.com/fixture-team',
  audience: 'https://vercel.com/fixture-team',
};
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
});
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  publicKey = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'fixture-key',
    use: 'sig',
    alg: 'RS256',
  };
});
async function token(
  changes: Record<string, unknown> = {},
  key = keys.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: scope.issuer,
    aud: scope.audience,
    sub: `owner:${scope.ownerSlug}:project:${scope.projectName}:environment:${scope.environment}`,
    iat: now,
    nbf: now,
    exp: now + 7200,
    owner: scope.ownerSlug,
    owner_id: scope.ownerId,
    project: scope.projectName,
    project_id: scope.projectId,
    environment: scope.environment,
    ...changes,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key' })
    .sign(key);
}
async function fixture() {
  let current = await token();
  let calls = 0;
  let requests = 0;
  let transform:
    | ((request: Request, response: Response) => Promise<Response>)
    | undefined;
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    return fetch(
      url === scope.issuer + '/.well-known/jwks' ? origin + '/jwks' : input,
      init,
    );
  };
  const handler = createIdentityLeaseHandler({
    scope,
    secret,
    getToken: async () => {
      calls++;
      return current;
    },
    fetch: fetcher,
  });
  const server = createServer(async (req, reply) => {
    try {
      if (req.url === '/jwks') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ keys: [publicKey] }));
        return;
      }
      requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new Request(origin + req.url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      });
      let response = await handler(request);
      if (transform) response = await transform(request, response);
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      reply.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      reply.writeHead(500);
      reply.end('fixture-failure');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin =
    'http://127.0.0.1:' + (server.address() as { port: number }).port;
  close.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new PrivateIdentityLeaseClient({
    bindingUrl: origin,
    scope,
    secret,
    fetch: fetcher,
  });
  return {
    client,
    origin,
    handler,
    fetcher,
    setToken: (value: string) => {
      current = value;
    },
    calls: () => calls,
    requests: () => requests,
    transform: (value: typeof transform) => {
      transform = value;
    },
  };
}
describe('private native identity lease over actual HTTP and signed JWKS', () => {
  it('verifies a fresh grant and keeps its token out of serialization', async () => {
    const f = await fixture();
    const lease = await f.client.acquire();
    expect(isValidatedIdentityLease(lease)).toBe(true);
    expect(isValidatedIdentityLease({ ...lease })).toBe(false);
    expect(lease.expiresAt).toBeGreaterThan(Date.now() + 290_000);
    expect(JSON.stringify(lease)).not.toContain('token');
    expect(Object.keys(lease)).not.toContain('token');
    expect(f.calls()).toBe(1);
    await f.client.acquire();
    expect(f.calls()).toBe(2);
  });
  it('authenticates before acquiring any provider token and refuses another deployment', async () => {
    const f = await fixture();
    const body = JSON.stringify({
      schemaVersion: 1,
      nonce: 'a'.repeat(43),
      deploymentId: 'dpl_Other',
    });
    const unauthenticated = await fetch(f.origin + IDENTITY_PATH, {
      method: 'POST',
      body,
    });
    expect(unauthenticated.status).toBe(401);
    const mismatch = await fetch(f.origin + IDENTITY_PATH, {
      method: 'POST',
      body,
      headers: internalHeaders(secret, IDENTITY_PATH, body),
    });
    expect(mismatch.status).toBe(409);
    expect(f.calls()).toBe(0);
  });
  it.each(['project_id', 'owner_id', 'environment', 'iss', 'aud', 'sub'])(
    'refuses a cryptographically valid JWT with wrong %s',
    async (claim) => {
      const f = await fixture();
      f.setToken(await token({ [claim]: 'wrong-scope' }));
      await expect(f.client.acquire()).rejects.toMatchObject({
        name: 'IdentityLeaseError',
        code: 'transport',
      });
      expect(f.calls()).toBe(1);
    },
  );
  it('refuses an invalid signature and a token expiring inside the grant', async () => {
    const f = await fixture();
    const unrelated = await generateKeyPair('RS256');
    f.setToken(await token({}, unrelated.privateKey));
    await expect(f.client.acquire()).rejects.toMatchObject({
      name: 'IdentityLeaseError',
    });
    f.setToken(await token({ exp: Math.floor(Date.now() / 1000) + 60 }));
    await expect(f.client.acquire()).rejects.toMatchObject({
      name: 'IdentityLeaseError',
    });
  });
  it('validates response HMAC, nonce, TTL, and JWT independently of the broker', async () => {
    const f = await fixture();
    f.transform(
      async (_request, response) =>
        new Response(await response.text(), { status: 200 }),
    );
    await expect(f.client.acquire()).rejects.toMatchObject({
      name: 'IdentityLeaseError',
    });
    for (const changed of [
      { nonce: 'z'.repeat(43) },
      { expiresAt: Date.now() + IDENTITY_LEASE_MS * 2 },
      { token: await token({ project_id: 'prj_Other' }) },
    ]) {
      f.transform(async (_request, response) => {
        const value = { ...(await response.json()), ...changed };
        const raw = JSON.stringify(value);
        return new Response(raw, {
          headers: internalHeaders(secret, IDENTITY_RESPONSE_CONTEXT, raw),
        });
      });
      await expect(f.client.acquire()).rejects.toMatchObject({
        name: 'IdentityLeaseError',
      });
    }
  });
  it('refuses redirects, oversized bodies, and provider acquisition failure without leaking details', async () => {
    const f = await fixture();
    f.transform(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://not-followed.invalid' },
        }),
    );
    await expect(f.client.acquire()).rejects.toMatchObject({
      code: 'transport',
    });
    expect(f.requests()).toBe(1);
    f.transform(async () => new Response('x'.repeat(8193)));
    await expect(f.client.acquire()).rejects.toMatchObject({
      code: 'body-limit',
    });
    const handler = createIdentityLeaseHandler({
      scope,
      secret,
      getToken: async () => {
        throw new Error('PRIVATE-CREDENTIAL-ERROR');
      },
      fetch: f.fetcher,
    });
    const body = JSON.stringify({
      schemaVersion: 1,
      nonce: 'a'.repeat(43),
      deploymentId: scope.deploymentId,
    });
    const response = await handler(
      new Request(f.origin + IDENTITY_PATH, {
        method: 'POST',
        body,
        headers: internalHeaders(secret, IDENTITY_PATH, body),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE-CREDENTIAL-ERROR');
  });
});
