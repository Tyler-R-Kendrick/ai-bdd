import { test, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { signInBrowser } from './browser-fixture.ts';
import { passwordHash, type Settings } from '../server/auth.ts';
import { githubSignInFixture } from './identity/github-signin-fixture.ts';
import { githubFixture } from './identity/github-fixture.ts';

const origin = 'http://127.0.0.1:8896';
let issuer: Awaited<ReturnType<typeof githubSignInFixture>>,
  github: Awaited<ReturnType<typeof githubFixture>>,
  studio: Awaited<ReturnType<typeof createApp>>,
  directory: string;
test.beforeAll(async () => {
  issuer = await githubSignInFixture();
  issuer.account('unverified@example.test').verifiedEmails = [];
  github = await githubFixture();
  directory = await mkdtemp('/tmp/studio-identity-browser-');
  const settings: Settings & {
    repositoryIdentity: import('../server/identity/ports.ts').RepositoryIdentitySettings;
  } = {
    origin,
    production: false,
    dataDir: directory,
    demo: false,
    adminEmail: 'owner@example.test',
    githubSignInProvider: issuer.provider,
    repositoryIdentity: {
      clientId: github.clientId,
      clientSecret: github.clientSecret,
      encryptionKey: randomBytes(32).toString('base64url'),
      authorizationUrl: github.origin + '/login/oauth/authorize',
      tokenUrl: github.origin + '/login/oauth/access_token',
      apiBaseUrl: github.origin,
      allowLoopback: true,
      kind: 'oauth-app',
      webhookSecret: 'fixture-only-webhook-secret-more-than32-characters',
    },
  };
  studio = await createApp(settings, {
    db: ':memory:',
    clientDir: resolve(import.meta.dirname, '../dist/client'),
  });
  const start=await studio.app.inject('/api/auth/github');
  const callback=new URL(issuer.callbackFor('alice@example.test',String(start.headers.location)));
  const binding=start.cookies.find(cookie=>cookie.name==='studio_github_signin')!.value;
  const signed=await studio.app.inject({url:callback.pathname+callback.search,headers:{cookie:'studio_github_signin='+binding}});
  expect(signed.headers.location).toBe('/');
  const session=signed.cookies.find(cookie=>cookie.name==='studio_session')!.value;
  const alice=(await studio.app.inject({url:'/api/me',headers:{cookie:'studio_session='+session}})).json();
  await studio.store.createUser(
    'teammate@example.test',
    'Password teammate',
    await passwordHash('fixture-only-teammate-password-123'),
  );
  await studio.store.createProject(
    alice,
    'GitHub verified workspace',
    'Synthetic issuer acceptance content.',
    '',
  );
  await studio.app.listen({ host: '127.0.0.1', port: 8896 });
});
test.afterAll(async () => {
  await studio?.app.close();
  await issuer?.close();
  await github?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function begin(page: Page) {
  await page.goto(origin + '/api/auth/github');
  await expect(page.getByRole('heading', {
    name: 'Owned GitHub OAuth test provider', exact: true,
  })).toBeVisible();
}
async function login(page: Page, account: string) {
  await signInBrowser(page, origin, account + '@example.test');
}
async function finish(page: Page, email = 'alice@example.test') {
  await page.getByLabel('Fixture GitHub email', { exact: true }).fill(email);
  await page.getByRole('button', {
    name: 'Continue fixture GitHub sign-in', exact: true,
  }).click();
}
async function capture(page: Page, name: string) {
  await mkdir(resolve(import.meta.dirname, '../../../work/review'), {
    recursive: true,
  });
  await page.screenshot({
    path: resolve(import.meta.dirname, `../../../work/review/${name}.png`),
    fullPage: true,
  });
}

test('GitHub OAuth authenticates a provisioned user through PKCE and durable state; callback replay cannot mint another session', async ({
  page,
}) => {
  let callback = '';
  page.on('request', (req) => {
    if (req.url().startsWith(origin + '/api/auth/github/callback?'))
      callback = req.url();
  });
  await begin(page);
  const binding = (
    await page.context().cookies(origin + '/api/auth/github/callback')
  ).find((cookie) => cookie.name === 'studio_github_signin')!.value;
  await finish(page);
  await expect(
    page.getByRole('button', { name: 'Workspace settings', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('heading', {
        name: 'GitHub verified workspace — design',
        exact: true,
      })
      .first(),
  ).toBeVisible();
  expect((await page.request.get(origin + '/api/me')).status()).toBe(200);
  const me = await (await page.request.get(origin + '/api/me')).json();
  expect(me.email).toMatch(/@identity\.invalid$/);
  expect(issuer.tokenRequests).toBeGreaterThan(0);
  expect(callback).toContain('state=');
  const sessions = await studio.store.all(
      'SELECT token FROM sessions WHERE user_id=?',
      me.id,
    ),
    replay = await page.request.get(callback, {
      headers: { cookie: 'studio_github_signin=' + binding },
      maxRedirects: 0,
    });
  expect(replay.status()).toBe(302);
  expect(replay.headers().location).toBe('/?signin=failed');
  expect(
    (
      await studio.store.all(
        'SELECT token FROM sessions WHERE user_id=?',
        me.id,
      )
    ).length,
  ).toBe(sessions.length);
  await capture(page, 'studio-github-verified-session');
});

test('GitHub web connection uses the signed-in user and repository membership never substitutes for GitHub entitlement', async ({
  page,
  browser,
}) => {
  await login(page, 'alice');
  await page
    .getByRole('button', { name: 'Workspace settings', exact: true })
    .click();
  const identity = page.getByRole('region', {
    name: 'GitHub repository identity',
    exact: true,
  });
  await expect(identity).toBeVisible();
  github.permissions.set('101:acme/private', { pull: true, push: true });
  await identity
    .getByRole('button', { name: 'Connect GitHub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Workspace settings', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Workspace settings', exact: true })
    .click();
  await expect(
    page.getByText('Connected as alice-fixture.', { exact: true }),
  ).toBeVisible();
  await capture(page, 'studio-github-user-identity');
  const response = await page.request.post(origin + '/api/projects', {
    headers: { origin },
    data: {
      title: 'Verified repository workspace',
      description: 'Actual local GitHub protocol fixture.',
      repository: 'https://github.com/acme/private',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const project = await response.json();
  const reader = await page.request.post(
    origin + '/api/identity/repository/read',
    {
      headers: { origin },
      data: {
        repository: 'https://github.com/acme/private',
        request: { kind: 'pull_request', number: 7 },
      },
    },
  );
  expect(reader.status()).toBe(200);
  expect((await reader.json()).title).toBe('Protected fixture change');
  const teammate = await browser.newContext({ baseURL: origin });
  const passwordLogin = await teammate.request.post('/api/auth/login', {
    headers: { origin },
    data: {
      email: 'teammate@example.test',
      password: 'fixture-only-teammate-password-123',
    },
  });
  expect(passwordLogin.status()).toBe(403);
  const teammatePage = await teammate.newPage();
  const actor=await signInBrowser(teammatePage, origin, 'teammate@example.test');
  const admission=await page.request.post(origin+`/api/projects/${project.id}/members`,{headers:{origin},data:{userId:actor.id,role:'viewer'}});
  expect(admission.status()).toBe(200);expect(await admission.json()).not.toHaveProperty('temporaryPassword');
  const denied = await teammate.request.get(`/api/artifacts/${project.mainArtifactId}`);
  expect(denied.status()).toBe(403);
  await teammate.close();
  await page
    .getByRole('region', { name: 'GitHub repository identity', exact: true })
    .getByRole('button', { name: 'Disconnect', exact: true })
    .click();
  await expect(
    page.getByText(
      'Connect your own account to open repository-backed projects.',
      { exact: true },
    ),
  ).toBeVisible();
});

test('a genuine GitHub account can sign in without a local account or invitation', async ({
  page,
}) => {
  await begin(page);
  await finish(page, 'outsider@example.test');
  await expect(page.getByRole('button',{name:'Workspace settings',exact:true})).toBeVisible();
  expect((await page.request.get(origin + '/api/me')).status()).toBe(200);
  expect(
    await studio.store.userByEmail('outsider@example.test'),
  ).toBeUndefined();
});
test('an authenticated GitHub account does not need a released verified email', async ({
  page,
}) => {
  await begin(page);
  await finish(page, 'unverified@example.test');
  await expect(page.getByRole('button',{name:'Workspace settings',exact:true})).toBeVisible();
  expect((await page.request.get(origin + '/api/me')).status()).toBe(200);
});
test('expired durable state is denied before the real issuer authorization code can be exchanged', async ({
  page,
}) => {
  await begin(page);
  const before = issuer.tokenRequests;
  await studio.store.exec(
    "UPDATE identity_challenges SET expires_at=? WHERE namespace='github-signin'",
    Date.now() - 1,
  );
  await finish(page);
  await expect(page).toHaveURL(origin + '/?signin=failed');
  expect(issuer.tokenRequests).toBe(before);
  expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
});
test('issuer token endpoint failure leaves the browser unsigned in and consumes the attempted state', async ({
  page,
}) => {
  await begin(page);
  issuer.failTokens(true);
  try {
    await finish(page);
    await expect(page).toHaveURL(origin + '/?signin=failed');
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
  } finally {
    issuer.failTokens(false);
  }
});

test('legacy organization, setup, demo and password routes cannot establish a session', async ({ page }) => {
  expect((await page.request.get(origin + '/api/auth/oidc')).status()).toBe(404);
  for (const route of ['login', 'setup', 'demo']) {
    const response = await page.request.post(origin + '/api/auth/' + route, {
      headers: { origin }, data: { email: 'teammate@example.test', password: 'fixture-only-teammate-password-123' },
    });
    expect(response.status()).toBe(403);
  }
  expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
});
