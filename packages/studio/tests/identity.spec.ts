import { test, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { passwordHash, type Settings } from '../server/auth.ts';
import { oidcFixture } from './identity/oidc-fixture.ts';
import { githubFixture } from './identity/github-fixture.ts';

const origin = 'http://127.0.0.1:8896';
let issuer: Awaited<ReturnType<typeof oidcFixture>>,
  github: Awaited<ReturnType<typeof githubFixture>>,
  studio: Awaited<ReturnType<typeof createApp>>,
  directory: string;
test.beforeAll(async () => {
  issuer = await oidcFixture(origin + '/api/auth/callback');
  github = await githubFixture();
  directory = await mkdtemp('/tmp/studio-identity-browser-');
  const settings: Settings & {
    oidcAllowHttpLoopback: boolean;
    repositoryIdentity: import('../server/identity/ports.ts').RepositoryIdentitySettings;
  } = {
    origin,
    production: false,
    dataDir: directory,
    demo: false,
    adminEmail: 'owner@example.test',
    adminPassword: 'fixture-only-owner-password-123',
    oidcIssuer: issuer.origin,
    oidcClientId: issuer.clientId,
    oidcClientSecret: issuer.clientSecret,
    oidcAllowHttpLoopback: true,
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
  const alice = await studio.store.createUser(
    'alice@example.test',
    'Alice Verified',
    null,
  );
  await studio.store.createUser(
    'teammate@example.test',
    'Password teammate',
    await passwordHash('fixture-only-teammate-password-123'),
  );
  await studio.store.createUser(
    'unverified@example.test',
    'Unverified User',
    null,
  );
  await studio.store.createProject(
    alice,
    'OIDC verified workspace',
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
  await page.goto(origin);
  await page
    .getByRole('link', { name: 'Continue with your organization', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Local OIDC acceptance issuer',
      exact: true,
    }),
  ).toBeVisible();
}
async function login(page: Page, account: string) {
  await begin(page);
  await page
    .getByRole('combobox', { name: 'Fixture account', exact: true })
    .selectOption(account);
  await page
    .getByRole('button', { name: 'Continue sign-in', exact: true })
    .click();
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

test('real issuer verifies an admitted user through PKCE, signed ID token and UserInfo; callback replay cannot mint another session', async ({
  page,
}) => {
  let callback = '';
  page.on('request', (req) => {
    if (req.url().startsWith(origin + '/api/auth/callback?'))
      callback = req.url();
  });
  await begin(page);
  const binding = (
    await page.context().cookies(origin + '/api/auth/callback')
  ).find((cookie) => cookie.name === 'studio_oidc')!.value;
  await page
    .getByRole('combobox', { name: 'Fixture account', exact: true })
    .selectOption('alice');
  await page
    .getByRole('button', { name: 'Continue sign-in', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Workspace settings', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('heading', {
        name: 'OIDC verified workspace — design',
        exact: true,
      })
      .first(),
  ).toBeVisible();
  expect((await page.request.get(origin + '/api/me')).status()).toBe(200);
  const me = await (await page.request.get(origin + '/api/me')).json();
  expect(me.email).toBe('alice@example.test');
  expect(issuer.tokenRequests).toBeGreaterThan(0);
  expect(callback).toContain('state=');
  const sessions = await studio.store.all(
      'SELECT token FROM sessions WHERE user_id=?',
      me.id,
    ),
    replay = await page.request.get(callback, {
      headers: { cookie: 'studio_oidc=' + binding },
      maxRedirects: 0,
    });
  expect(replay.status()).toBe(401);
  expect(
    (
      await studio.store.all(
        'SELECT token FROM sessions WHERE user_id=?',
        me.id,
      )
    ).length,
  ).toBe(sessions.length);
  await capture(page, 'studio-oidc-verified-session');
});

test('GitHub web connection uses the signed-in user and repository membership never substitutes for GitHub entitlement', async ({
  page,
  playwright,
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
  const admission = await page.request.post(
    origin + `/api/projects/${project.id}/members`,
    {
      headers: { origin },
      data: {
        email: 'teammate@example.test',
        name: 'Password teammate',
        role: 'viewer',
      },
    },
  );
  expect(admission.status()).toBe(200);
  expect((await admission.json()).temporaryPassword).toBeNull();
  const teammate = await playwright.request.newContext({ baseURL: origin });
  const passwordLogin = await teammate.post('/api/auth/login', {
    headers: { origin },
    data: {
      email: 'teammate@example.test',
      password: 'fixture-only-teammate-password-123',
    },
  });
  expect(passwordLogin.status()).toBe(200);
  const denied = await teammate.get(`/api/artifacts/${project.mainArtifactId}`);
  expect(denied.status()).toBe(403);
  await teammate.dispose();
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

test('verified but unadmitted issuer accounts cannot create a Studio account or session', async ({
  page,
}) => {
  await login(page, 'outsider');
  await expect(page.locator('body')).toContainText(
    /Ask a workspace owner to add your account/,
  );
  expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
  expect(
    await studio.store.userByEmail('outsider@example.test'),
  ).toBeUndefined();
});
test('an admitted account still cannot sign in with an unverified issuer email', async ({
  page,
}) => {
  await login(page, 'unverified');
  await expect(page.locator('body')).toContainText(
    /verified email is required/,
  );
  expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
});
test('expired durable state is denied before the real issuer authorization code can be exchanged', async ({
  page,
}) => {
  await begin(page);
  const before = issuer.tokenRequests;
  await studio.store.exec(
    "UPDATE identity_challenges SET expires_at=? WHERE namespace='oidc'",
    Date.now() - 1,
  );
  await page
    .getByRole('button', { name: 'Continue sign-in', exact: true })
    .click();
  await expect(page.locator('body')).toContainText(/Sign-in expired/);
  expect(issuer.tokenRequests).toBe(before);
  expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
});
test('issuer token endpoint failure leaves the browser unsigned in and consumes the attempted state', async ({
  page,
}) => {
  await begin(page);
  issuer.failTokens(true);
  try {
    await page
      .getByRole('button', { name: 'Continue sign-in', exact: true })
      .click();
    await expect(page.locator('body')).toContainText(
      /could not complete this request|could not complete this sign-in|Sign-in could not be completed/,
    );
    expect((await page.request.get(origin + '/api/me')).status()).toBe(401);
  } finally {
    issuer.failTokens(false);
  }
});
