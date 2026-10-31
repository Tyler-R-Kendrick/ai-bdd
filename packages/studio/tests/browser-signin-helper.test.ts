/** Controlled browser helper regression; no live GitHub/Connect or model calls. */
import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../server/app.ts';
import { githubSignInFixture } from './identity/github-signin-fixture.ts';
import { signInBrowser } from './browser-fixture.ts';

it('refuses an old valid session after a different actor exchange fails, then admits that actor only through a fresh callback', async () => {
  const clientDir = resolve(import.meta.dirname, '../dist/client');
  expect(existsSync(join(clientDir, 'index.html')), 'Build the Studio client before the browser boundary test').toBe(true);
  const issuer = await githubSignInFixture();
  const settings = { production: false, demo: false, origin: 'http://127.0.0.1:0', dataDir: '/tmp/owned-browser-signin-helper', githubSignInProvider: issuer.provider };
  const studio = await createApp(settings, { db: ':memory:', clientDir, startupDispatchLimit: 0 });
  const executable = process.env.STUDIO_CHROMIUM_PATH ?? process.env.AI_BDD_CHROMIUM_PATH;
  const browser = await chromium.launch({ headless: true,
    ...(executable ? { executablePath: executable } : existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const origin = await studio.app.listen({ host: '127.0.0.1', port: 0 });
    settings.origin = origin;
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    await context.route('**/*', route => [origin, issuer.origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const first = await signInBrowser(page, origin, 'first-helper-actor@example.test');
    const before = (await context.cookies(origin)).find(cookie => cookie.name === 'studio_session');
    expect(!!before).toBe(true);
    issuer.failTokens(true);
    await expect(signInBrowser(page, origin, 'second-helper-actor@example.test')).rejects.toThrow();
    const retained = (await context.cookies(origin)).find(cookie => cookie.name === 'studio_session');
    expect(retained?.value === before!.value).toBe(true);
    const previous = await page.request.get(origin + '/api/me');
    expect(previous.status()).toBe(200);
    expect((await previous.json()).id).toBe(first.id);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(1);
    issuer.failTokens(false);
    await page.setViewportSize({ width: 390, height: 844 });
    const second = await signInBrowser(page, origin, 'second-helper-actor@example.test');
    expect(second.id).not.toBe(first.id);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(2);
    await context.close();
  } finally {
    await browser.close();
    await studio.app.close();
    await issuer.close();
  }
});
