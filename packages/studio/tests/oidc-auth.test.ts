import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { Store } from '../server/store.ts';
import { Auth, type Settings } from '../server/auth.ts';
import { oidcFixture } from './identity/oidc-fixture.ts';

const origin = 'http://127.0.0.1:8896';
let browser: Browser,
  context: BrowserContext,
  page: Page,
  issuer: Awaited<ReturnType<typeof oidcFixture>>,
  app: ReturnType<typeof Fastify>,
  store: Store,
  settings: Settings;
beforeAll(async () => {
  const executable =
    process.env.STUDIO_CHROMIUM_PATH ?? process.env.AI_BDD_CHROMIUM_PATH;
  browser = await chromium.launch({
    ...(executable
      ? { executablePath: executable }
      : existsSync('/usr/bin/chromium')
        ? { executablePath: '/usr/bin/chromium' }
        : {}),
    headless: true,
    args: ['--no-sandbox'],
  });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  issuer = await oidcFixture(origin + '/api/auth/callback');
  settings = {
    origin,
    production: false,
    dataDir: '/tmp/studio-local-oidc-fixture',
    demo: false,
    adminEmail: 'owner@example.test',
    adminPassword: 'fixture-only-owner-password-123',
    oidcIssuer: issuer.origin,
    oidcClientId: issuer.clientId,
    oidcClientSecret: issuer.clientSecret,
    oidcAllowHttpLoopback: true,
  };
  store = await Store.open(':memory:');
  const auth = new Auth(store, settings);
  await auth.initialize();
  await store.createUser('alice@example.test', 'Alice Verified', null);
  await store.createUser('unverified@example.test', 'Unverified User', null);
  app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _req, reply) =>
    reply.code((error as any).statusCode ?? 500).send({
      error: (error as any).statusCode
        ? (error as Error).message
        : 'The server could not complete this request',
    }),
  );
  await auth.routes(app);
  app.get('/', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html lang="en"><title>Local authentication fixture</title><h1>Local authentication fixture</h1><p>Verified sessions are inspected through the actual Studio authentication API.</p></html>',
      ),
  );
  await app.listen({ port: 8896, host: '127.0.0.1' });
  context = await browser.newContext();
  page = await context.newPage();
});
afterEach(async () => {
  await context?.close();
  await app?.close();
  await store?.close();
  await issuer?.close();
});
async function start() {
  await page.goto(origin + '/api/auth/oidc');
  await page
    .getByRole('heading', { name: 'Local OIDC acceptance issuer', exact: true })
    .waitFor();
}
async function finish(account = 'alice') {
  await page
    .getByRole('combobox', { name: 'Fixture account', exact: true })
    .selectOption(account);
  await page
    .getByRole('button', { name: 'Continue sign-in', exact: true })
    .click();
}

describe('actual organization issuer authentication', () => {
  it('accepts an admitted verified account using real signed ID-token validation and authenticated UserInfo, then rejects callback replay', async () => {
    let callback = '';
    page.on('request', (req) => {
      if (req.url().startsWith(origin + '/api/auth/callback?'))
        callback = req.url();
    });
    await start();
    const binding = (await context.cookies(origin + '/api/auth/callback')).find(
      (c) => c.name === 'studio_oidc',
    )!.value;
    await finish();
    await page
      .getByRole('heading', {
        name: 'Local authentication fixture',
        exact: true,
      })
      .waitFor();
    const me = await page.request.get(origin + '/api/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).email).toBe('alice@example.test');
    expect(issuer.tokenRequests).toBe(1);
    const before = await store.all('SELECT token FROM sessions'),
      replay = await page.request.get(callback, {
        headers: { cookie: 'studio_oidc=' + binding },
        maxRedirects: 0,
      });
    expect(replay.status()).toBe(401);
    expect((await store.all('SELECT token FROM sessions')).length).toBe(
      before.length,
    );
  });
  it('rejects verified users who were not admitted by a workspace owner', async () => {
    await start();
    await finish('outsider');
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
    expect(await page.locator('body').innerText()).toContain(
      'Ask a workspace owner to add your account',
    );
    expect(await store.userByEmail('outsider@example.test')).toBeUndefined();
  });
  it('rejects an admitted user when the real issuer reports an unverified email', async () => {
    await start();
    await finish('unverified');
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
    expect(await page.locator('body').innerText()).toContain(
      'A verified email is required',
    );
  });
  it('rejects expired durable state before exchanging the signed issuer code', async () => {
    await start();
    await store.exec(
      "UPDATE identity_challenges SET expires_at=? WHERE namespace='oidc'",
      Date.now() - 1,
    );
    await finish();
    expect(await page.locator('body').innerText()).toContain('Sign-in expired');
    expect(issuer.tokenRequests).toBe(0);
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
  });
  it('binds the challenge to a separate HttpOnly browser cookie', async () => {
    await start();
    await context.clearCookies({ name: 'studio_oidc' });
    await finish();
    expect(await page.locator('body').innerText()).toContain('Sign-in expired');
    expect(issuer.tokenRequests).toBe(0);
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
  });
  it('fails closed when the real issuer token endpoint is unavailable', async () => {
    await start();
    issuer.failTokens(true);
    await finish();
    expect(await page.locator('body').innerText()).toContain(
      'could not complete this request',
    );
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
    expect(await store.all('SELECT token FROM sessions')).toEqual([]);
  });
  it('isolates issuer discovery faults from password sign-in and retries metadata discovery after recovery', async () => {
    issuer.faultDiscovery(true);
    const denied = await page.request.get(origin + '/api/auth/oidc', {
      maxRedirects: 0,
    });
    expect(denied.status()).toBe(503);
    expect(await store.all('SELECT token FROM sessions')).toEqual([]);
    const local = await page.request.post(origin + '/api/auth/login', {
      headers: { origin },
      data: {
        email: 'owner@example.test',
        password: 'fixture-only-owner-password-123',
      },
    });
    expect(local.status()).toBe(200);
    expect(
      (await (await page.request.get(origin + '/api/me')).json()).email,
    ).toBe('owner@example.test');
    issuer.faultDiscovery(false);
    const recovered = await page.request.get(origin + '/api/auth/oidc', {
      maxRedirects: 0,
    });
    expect(recovered.status()).toBe(302);
    expect(recovered.headers().location).toMatch(
      new RegExp('^' + issuer.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});
