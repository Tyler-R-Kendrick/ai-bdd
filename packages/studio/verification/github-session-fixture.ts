/**
 * Disposable release-gate identity only. No shipping entrypoint imports this
 * module, and no environment variable enables it. Sessions are issued by the
 * real OAuth challenge/callback, then consumed by the unmodified image command.
 * This is controlled provider evidence, never a live GitHub login claim.
 */
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Auth } from '../server/auth.ts';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { injectedGitHub, githubSignIn } from '../tests/identity/github-signin-inject-fixture.ts';

export async function prepareGitHubSession(input: {
  dataDirectory: string;
  email: string;
  databaseUrl?: string;
}) {
  assert(isAbsolute(input.dataDirectory));
  assert.match(input.email, /^[A-Za-z0-9_.+-]+@example\.test$/);
  if (input.databaseUrl) {
    const url = new URL(input.databaseUrl);
    assert(['postgres:', 'postgresql:'].includes(url.protocol));
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'Controlled GitHub fixtures must never seed a hosted database');
    assert(url.pathname !== '/' && url.pathname !== '/postgres');
  }
  const origin = 'https://github-session-fixture.example.test';
  const store = await Store.open(input.databaseUrl
    ? await openDatabase({ adapter: 'postgres', url: input.databaseUrl })
    : join(input.dataDirectory, 'studio.sqlite'));
  const app = Fastify({ logger: false });
  try {
    await app.register(cookie);
    const auth = new Auth(store, {
      origin,
      production: true,
      dataDir: input.dataDirectory,
      demo: false,
      adminEmail: input.email,
      githubSignInProvider: injectedGitHub,
    });
    await auth.initialize();
    await auth.routes(app);
    const { cookie: token, user, response } = await githubSignIn(app, input.email);
    const session = response.cookies.find(item => item.name === 'studio_session');
    assert(session);
    assert.equal(session.secure, true);
    assert.equal(session.httpOnly, true);
    assert.equal(user.email, input.email);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: input.email, password: 'rejected-fixture-password' } })).statusCode, 403);
    return { cookie: 'studio_session=' + token, user, controlledOAuthProvider: true as const };
  } finally {
    await app.close();
    await store.close();
  }
}
