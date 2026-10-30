import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const evidence = resolve('../../work/e2e/github-signin');
const available = {
  github: true,
  password: false,
  setup: false,
  oidc: false,
  demo: false,
};

async function signInScreen(
  page: Page,
  status: (attempt: number) => { status?: number; body: unknown },
  path = '/',
) {
  const requests: string[] = [];
  let statusAttempts = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    requests.push(request.method() + ' ' + path);
    if (path === '/api/me')
      return route.fulfill({
        status: 401,
        json: { error: 'Sign in to continue' },
      });
    if (path === '/api/auth/status') {
      const response = status(++statusAttempts);
      return route.fulfill({ status: response.status ?? 200, json: response.body });
    }
    if (path === '/api/auth/github')
      return route.fulfill({
        contentType: 'text/html',
        body: '<p>Controlled sign-in navigation boundary; no identity is authenticated.</p>',
      });
    return route.fulfill({ status: 500, json: { error: 'Unexpected request' } });
  });
  await page.goto(path);
  return requests;
}

async function noCredentialForm(page: Page) {
  await expect(page.locator('input, form')).toHaveCount(0);
  await expect(page.getByText('Open local demo')).toHaveCount(0);
  await expect(page.getByText('Continue with your organization')).toHaveCount(0);
}

test('GitHub is the only sign-in action on desktop and mobile', async ({ page }) => {
  await signInScreen(page, () => ({ body: available }));
  const signIn = page.getByRole('link', { name: 'Continue with GitHub' });
  await expect(signIn).toHaveAttribute('href', '/api/auth/github');
  await expect(signIn).toBeVisible();
  await noCredentialForm(page);
  await expect(page.getByText(/verified email|has access to this workspace|invitation|already registered/i)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('12px "Inter Variable"')))
    .toBe(true);
  const contrast = await signIn.evaluate((element) => {
    const styles = getComputedStyle(element);
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
    };
    const foreground = luminance(styles.color),
      background = luminance(styles.backgroundColor);
    return (Math.max(foreground, background) + .05) /
      (Math.min(foreground, background) + .05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: evidence + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(signIn).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: evidence + '/mobile.png', fullPage: true });
});

test('the GitHub action navigates to the OAuth start route without submitting credentials', async ({ page }) => {
  const requests = await signInScreen(page, () => ({ body: available }));
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/api\/auth\/github$/);
  expect(requests.filter((request) => request === 'GET /api/auth/github')).toHaveLength(1);
  expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  expect(requests.some((request) => /\/(login|setup|demo)$/.test(request))).toBe(false);
});

test('unavailable GitHub sign-in fails closed and can be checked again', async ({ page }) => {
  let unavailable = true;
  await signInScreen(page, () => ({
    body: unavailable ? { ...available, github: false } : available,
  }));
  await expect(page.getByRole('alert')).toHaveText(
    'GitHub sign-in is temporarily unavailable. Please try again in a moment.',
  );
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveCount(0);
  await noCredentialForm(page);
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
});

test('status failure shows a finite retry message without exposing provider errors', async ({ page }) => {
  let unavailable = true;
  await signInScreen(page, () =>
    unavailable
      ? { status: 503, body: { error: 'private-provider-error-marker' } }
      : { body: available },
  );
  await expect(page.getByRole('alert')).toHaveText(
    'We couldn’t check GitHub sign-in. Please try again.',
  );
  await expect(page.getByText('private-provider-error-marker')).toHaveCount(0);
  await noCredentialForm(page);
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
});

test('legacy setup, password, demo, and organization flags never expose alternate login', async ({ page }) => {
  await signInScreen(page, () => ({
    body: { github: true, setup: true, password: true, demo: true, oidc: true },
  }));
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
  await noCredentialForm(page);
  await expect(page.getByRole('link')).toHaveCount(1);
});

test('a failed GitHub callback offers a fixed, safe retry message', async ({ page }) => {
  await signInScreen(
    page,
    () => ({ body: available }),
    '/?signin=failed&error=private-callback-error-marker',
  );
  await expect(page.getByRole('alert')).toHaveText(
    'GitHub sign-in wasn’t completed. Please try again.',
  );
  await expect(page.getByText('private-callback-error-marker')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
    'href',
    '/api/auth/github',
  );
  await noCredentialForm(page);
});
