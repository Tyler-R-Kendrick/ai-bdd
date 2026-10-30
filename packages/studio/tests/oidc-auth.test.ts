// Historical filename retained so existing CI selection now verifies the GitHub-only replacement.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Store } from '../server/store.ts';
import { Auth, passwordHash, type Settings } from '../server/auth.ts';
import { githubSignInFixture } from './identity/github-signin-fixture.ts';
let origin: string, browser: Browser, context: BrowserContext, page: Page,
  issuer: Awaited<ReturnType<typeof githubSignInFixture>>,
  app: ReturnType<typeof Fastify>, store: Store, settings: Settings;
beforeAll(async () => {
  const executable = process.env.STUDIO_CHROMIUM_PATH ?? process.env.AI_BDD_CHROMIUM_PATH;
  browser = await chromium.launch({
    ...(executable ? { executablePath: executable } : existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
    headless: true, args: ['--no-sandbox'],
  });
});
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  issuer = await githubSignInFixture();
  issuer.account('unverified@example.test').verifiedEmails = [];
  settings = {
    origin: 'http://127.0.0.1:8896', production: false,
    dataDir: '/tmp/studio-local-github-fixture', demo: false,
    adminEmail: 'owner@example.test',
    // Historical password/OIDC configuration must not enable either login path.
    adminPassword: 'fixture-only-owner-password-123',
    oidcIssuer: 'https://unconfigured-organization.example.test',
    githubSignInProvider: issuer.provider,
  };
  store = await Store.open(':memory:');
  const auth = new Auth(store, settings);
  await auth.initialize();
  await store.createUser('owner@example.test', 'Legacy owner', await passwordHash(settings.adminPassword!));
  await store.createUser('alice@example.test', 'Alice Verified', null);
  await store.createUser('unverified@example.test', 'Unverified User', null);
  app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error: unknown, _req: FastifyRequest, reply: FastifyReply) =>
    reply.code((error as any).statusCode ?? 500).send({ error: (error as any).statusCode ? (error as Error).message : 'The server could not complete this request' }));
  await auth.routes(app);
  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html').send('<!doctype html><html lang="en"><title>Local authentication fixture</title><h1>Local authentication fixture</h1><p>Sessions use actual Studio GitHub authentication.</p></html>'));
  origin = await app.listen({ port: 0, host: '127.0.0.1' });
  settings.origin = origin;
  context = await browser.newContext();
  page = await context.newPage();
});
afterEach(async () => {
  await context?.close(); await app?.close(); await store?.close(); await issuer?.close();
});
async function start() {
  await page.goto(origin + '/api/auth/github');
  await page.getByRole('heading', { name: 'Owned GitHub OAuth test provider', exact: true }).waitFor();
}
async function finish(email = 'alice@example.test') {
  await page.getByLabel('Fixture GitHub email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Continue fixture GitHub sign-in', exact: true }).click();
}
async function denied() {
  await expect.poll(() => page.url()).toBe(origin + '/?signin=failed');
  expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
  expect(await store.all('SELECT token FROM sessions')).toEqual([]);
}
describe('actual browser GitHub-only authentication', () => {
  it('accepts an admitted verified GitHub identity with real durable binding/PKCE and refuses callback replay', async () => {
    let callback = '';
    page.on('request', req => { if (req.url().startsWith(origin + '/api/auth/github/callback?')) callback = req.url(); });
    await start();
    const binding = (await context.cookies(origin + '/api/auth/github/callback')).find(c => c.name === 'studio_github_signin')!;
    expect(binding.httpOnly).toBe(true); expect(binding.sameSite).toBe('Lax');
    await finish();
    await page.getByRole('heading', { name: 'Local authentication fixture', exact: true }).waitFor();
    const me = await page.request.get(origin + '/api/me');
    expect(me.status()).toBe(200); expect((await me.json()).email).toBe('alice@example.test');
    expect(issuer.tokenRequests).toBe(1);
    const before = await store.all('SELECT token FROM sessions');
    const replay = await page.request.get(callback, { headers: { cookie: 'studio_github_signin=' + binding.value }, maxRedirects: 0 });
    expect(replay.status()).toBe(302); expect(replay.headers().location).toBe('/?signin=failed');
    expect((await store.all('SELECT token FROM sessions')).length).toBe(before.length);
  });
  it('rejects a verified GitHub account that has not been invited', async () => {
    await start(); await finish('outsider@example.test'); await denied();
    expect(await store.userByEmail('outsider@example.test')).toBeUndefined();
  });
  it('rejects an admitted identity without a verified GitHub email', async () => {
    await start(); await finish('unverified@example.test'); await denied();
  });
  it('rejects expired durable state before exchanging the authorization code', async () => {
    await start();
    await store.exec("UPDATE identity_challenges SET expires_at=? WHERE namespace='github-signin'", Date.now() - 1);
    await finish(); await denied(); expect(issuer.tokenRequests).toBe(0);
  });
  it('requires the independent HttpOnly browser-binding cookie', async () => {
    await start(); await context.clearCookies({ name: 'studio_github_signin' });
    await finish(); await denied(); expect(issuer.tokenRequests).toBe(0);
  });
  it('fails closed when the owned provider exchange fails and consumes attempted state', async () => {
    await start(); issuer.failTokens(true); await finish(); await denied();
    expect(issuer.tokenRequests).toBe(1);
    expect(await store.all('SELECT namespace FROM identity_challenges')).toEqual([]);
  });
  it('refuses legacy valid passwords, setup/demo credentials and organization login', async () => {
    expect((await page.request.get(origin + '/api/auth/oidc')).status()).toBe(404);
    for (const path of ['login', 'setup', 'demo']) {
      const response = await page.request.post(origin + '/api/auth/' + path, {
        headers: { origin }, data: { email: 'owner@example.test', password: settings.adminPassword },
      });
      expect(response.status()).toBe(403);
    }
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
    expect(await store.all('SELECT token FROM sessions')).toEqual([]);
  });
});
