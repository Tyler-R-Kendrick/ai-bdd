import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { settingsFromEnv, Auth, type Settings } from '../server/auth.ts';
import { openDatabase } from '../server/persistence/index.ts';
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
const setup = (
  app: Awaited<ReturnType<typeof fixture>>['app'],
  email = 'owner@example.test',
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { origin },
    payload: {
      email,
      name: 'Admitted owner',
      password: 'secure-shared-authentication-password',
    },
  });
describe('awaited authentication persistence', () => {
  it('commits an actual password session before returning it and rejects durable revocation', async () => {
    const { app, store } = await fixture(await Store.open(':memory:'));
    const response = await setup(app);
    expect(response.statusCode, response.body).toBe(200);
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
    it('admits exactly one first owner across two application instances', async () => {
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
        setup(first.app, 'first@example.test'),
        setup(second.app, 'second@example.test'),
      ]);
      expect(
        result.filter((response) => response.statusCode === 200),
      ).toHaveLength(1);
      expect(
        result.filter((response) => [403, 409].includes(response.statusCode)),
      ).toHaveLength(1);
      expect((await first.store.one('SELECT count(*) AS n FROM users')).n).toBe(
        1,
      );
      const winner = result.find((response) => response.statusCode === 200)!,
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
