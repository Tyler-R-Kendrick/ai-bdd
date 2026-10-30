import { expect, type Page } from '@playwright/test';
import { createApp as createStudioApp } from '../server/app.ts';
import { githubSignInFixture } from './identity/github-signin-fixture.ts';

export const browserOwnerEmail = 'browser-owner@example.test';

/** Test composition only: the production application has no mock-provider flag. */
export async function createApp(...args: Parameters<typeof createStudioApp>) {
  const [settings, options] = args;
  const fixture = await githubSignInFixture();
  settings.githubSignInProvider = fixture.provider;
  settings.adminEmail ??= browserOwnerEmail;
  let studio: Awaited<ReturnType<typeof createStudioApp>>;
  try {
    studio = await createStudioApp(settings, options);
    // Existing admitted identities are fixture data; every browser session is
    // subsequently issued by the real OAuth callback and account-admission code.
    if (!(await studio.store.userByEmail(settings.adminEmail)))
      await studio.store.createUser(settings.adminEmail, 'Alex Morgan', null);
    studio.app.addHook('onClose', () => fixture.close());
    return studio;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export async function signInBrowser(
  page: Page,
  origin: string,
  email: string = browserOwnerEmail,
) {
  await page.goto(origin + '/api/auth/github');
  await expect(page.getByRole('heading', {
    name: 'Owned GitHub OAuth test provider', exact: true,
  })).toBeVisible();
  await page.getByLabel('Fixture GitHub email', { exact: true }).fill(email);
  await page.getByRole('button', {
    name: 'Continue fixture GitHub sign-in', exact: true,
  }).click();
  await expect.poll(async () => {
    const response = await page.request.get(origin + '/api/me');
    return response.status() === 200 ? (await response.json()).email : null;
  }).toBe(email.toLowerCase());
}
