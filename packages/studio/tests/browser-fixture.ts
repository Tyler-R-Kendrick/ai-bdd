import { expect, type Page } from '@playwright/test';
import { createApp as createStudioApp } from '../server/app.ts';
import { githubSignInFixture } from './identity/github-signin-fixture.ts';

export const browserOwnerEmail = 'browser-owner@example.test';

/** Test composition only: the production application has no mock-provider flag. */
export async function createApp(...args: Parameters<typeof createStudioApp>) {
  const [settings, options] = args;
  const fixture = await githubSignInFixture({ defaultName: 'Alex Morgan' });
  settings.githubSignInProvider = fixture.provider;
  settings.adminEmail ??= browserOwnerEmail;
  let studio: Awaited<ReturnType<typeof createStudioApp>>;
  try {
    studio = await createStudioApp(settings, options);
    // The owned provider supplies display metadata. Studio creates the
    // passwordless internal account only through the real OAuth callback.
    studio.app.addHook('onClose', () => fixture.close());
    return Object.assign(studio, { testGitHubAuthorizationOrigin: fixture.origin });
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

const browserActors = new Map<string, { selector: string; id: string; email: string }>();

export async function signInBrowser(
  page: Page,
  origin: string,
  email: string = browserOwnerEmail,
) {
  const actorKey = origin + '\0' + email.toLowerCase();
  const previous = browserActors.get(actorKey);
  const selector = previous?.selector ?? email;
  await page.goto(origin + '/api/auth/github');
  await expect(page.getByRole('heading', {
    name: 'Owned GitHub OAuth test provider', exact: true,
  })).toBeVisible();
  await page.getByLabel('Fixture GitHub email', { exact: true }).fill(selector);
  await page.getByRole('button', {
    name: 'Continue fixture GitHub sign-in', exact: true,
  }).click();
  let user: any;
  await expect.poll(async () => {
    const response = await page.request.get(origin + '/api/me');
    user = response.status() === 200 ? await response.json() : undefined;
    return user?.id ?? '';
  }).toMatch(/^[0-9a-f-]{36}$/);
  expect(user.email).toMatch(/^[0-9a-f-]+@identity\.invalid$/);
  if (previous) { expect(user.id).toBe(previous.id); expect(user.email).toBe(previous.email); }
  const actor = { selector, id: user.id, email: user.email };
  browserActors.set(origin + '\0' + selector.toLowerCase(), actor);
  browserActors.set(origin + '\0' + user.email.toLowerCase(), actor);
  return user;
}
