import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { settingsFromEnv, Auth, type Settings } from '../server/auth.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { githubSignInResponse, injectedGitHub } from './identity/github-signin-inject-fixture.ts';
const origin = 'http://127.0.0.1:8897',
  cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(store: Store) {
  const app = Fastify();
  await app.register(cookie);
  const settings: Settings = {
      production: false,
      origin,
      dataDir: '/tmp/studio-auth-async',
      demo: false,
      adminEmail: 'owner@example.test',
      githubSignInProvider: injectedGitHub,
    },
    auth = new Auth(store, settings);
  await auth.initialize();
  await auth.routes(app);
  app.setErrorHandler((error, request, reply) =>
    reply
      .code((error as any).statusCode ?? 500)
      .send({ error: (error as Error).message }),
  );
  cleanup.push(
    () => app.close(),
    () => store.close(),
  );
  return { app, auth, store };
}
const signIn = (
  app: Awaited<ReturnType<typeof fixture>>['app'],
  email = 'owner@example.test',
) => githubSignInResponse(app, email);
describe('awaited authentication persistence', () => {
  it('commits a GitHub-provenance session before returning it and rejects durable revocation', async () => {
    const { app, store } = await fixture(await Store.open(':memory:'));
    const response = await signIn(app);
    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe('/');
    const session = response.cookies.find(
      (value) => value.name === 'studio_session',
    )!.value;
    expect(
      (
        await app.inject({
          url: '/api/me',
          headers: { cookie: 'studio_session=' + session },
        })
      ).statusCode,
    ).toBe(200);
    await store.exec('DELETE FROM sessions');
    expect(
      (
        await app.inject({
          url: '/api/me',
          headers: { cookie: 'studio_session=' + session },
        })
      ).statusCode,
    ).toBe(401);
  });
});
describe.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL)(
  'real PostgreSQL authentication admission',
  () => {
    it('admits exactly one GitHub identity for the first owner across two application instances', async () => {
      const url = process.env.STUDIO_TEST_POSTGRES_URL!,
        schema = 'auth_' + randomUUID().replaceAll('-', '');
      const first = await fixture(
          await Store.open(
            await openDatabase({ adapter: 'postgres', url, schema }),
          ),
        ),
        second = await fixture(
          await Store.open(
            await openDatabase({ adapter: 'postgres', url, schema }),
          ),
        );
      const result = await Promise.all([
        githubSignInResponse(first.app, 'owner@example.test', {id:'101'}),
        githubSignInResponse(second.app, 'owner@example.test', {id:'202'}),
      ]);
      expect(
        result.filter((response) => response.headers.location === '/'),
      ).toHaveLength(1);
      expect(
        result.filter((response) => response.headers.location === '/?signin=failed'),
      ).toHaveLength(1);
      expect((await first.store.one('SELECT count(*) AS n FROM users')).n).toBe(
        1,
      );
      expect((await first.store.one('SELECT count(*) AS n FROM github_signin_identities')).n).toBe(1);
      const winner = result.find((response) => response.headers.location === '/')!,
        session = winner.cookies.find(
          (value) => value.name === 'studio_session',
        )!.value;
      expect(
        (
          await second.app.inject({
            url: '/api/me',
            headers: { cookie: 'studio_session=' + session },
          })
        ).statusCode,
      ).toBe(200);
    });
    it('consumes a shared GitHub callback exactly once across PostgreSQL application instances', async () => {
      const url = process.env.STUDIO_TEST_POSTGRES_URL!, schema = 'auth_replay_' + randomUUID().replaceAll('-', '');
      const first = await fixture(await Store.open(await openDatabase({adapter:'postgres',url,schema})));
      const second = await fixture(await Store.open(await openDatabase({adapter:'postgres',url,schema})));
      const start = await first.app.inject('/api/auth/github');
      const binding = start.cookies.find(value=>value.name==='studio_github_signin')!.value;
      const code = injectedGitHub.issue(String(start.headers.location),'owner@example.test');
      const request = {url:'/api/auth/github/callback?'+new URLSearchParams(code),headers:{cookie:'studio_github_signin='+binding}};
      const results = await Promise.all([first.app.inject(request),second.app.inject(request)]);
      expect(results.filter(response=>response.headers.location==='/')).toHaveLength(1);
      expect(results.filter(response=>response.headers.location==='/?signin=failed')).toHaveLength(1);
      expect((await first.store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(1);
      expect((await first.store.one('SELECT COUNT(*) AS n FROM github_signin_sessions')).n).toBe(1);
      expect((await first.store.one('SELECT COUNT(*) AS n FROM identity_challenges')).n).toBe(0);
      expect((await second.app.inject(request)).headers.location).toBe('/?signin=failed');
    });
  },
);

it('accepts Vercel ambient or linked OIDC for AI Gateway without requiring a long-lived key', () => {
  const model = {
    STUDIO_MODEL: 'example/model',
    STUDIO_ORIGIN: 'http://localhost:8787',
  };
  expect(() => settingsFromEnv({ ...model, VERCEL: '1' })).not.toThrow();
  expect(() =>
    settingsFromEnv({ ...model, VERCEL_OIDC_TOKEN: 'synthetic-linked-token' }),
  ).not.toThrow();
  expect(() => settingsFromEnv(model)).toThrow(
    'AI_GATEWAY_API_KEY or Vercel OIDC',
  );
});
