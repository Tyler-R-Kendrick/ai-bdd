import { expect, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { browserOwnerEmail, signInBrowser } from './browser-fixture.ts';
const origin = 'http://127.0.0.1:8877';
type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
let bootstrap: { projectId: string; cookies: Cookies; previousActor: Cookies } | undefined;

/** Each actor is invited through the API, then signs in through real OAuth/PKCE. */
export async function signInAcceptanceActor(page: Page) {
  if (!bootstrap) {
    await signInBrowser(page, origin, browserOwnerEmail);
    const cookies = await page.context().cookies();
    const response = await page.request.post('/api/projects', {
      headers: { origin },
      data: { title: 'Acceptance actor admission', description: 'Internal test account admission project.', repository: '' },
    });
    expect(response.ok(), await response.text()).toBe(true);
    bootstrap = { projectId: (await response.json()).id, cookies, previousActor: cookies };
  }
  await page.context().addCookies(bootstrap.previousActor);
  const email = `acceptance-${randomUUID()}@example.test`;
  const invitation = await page.request.post(`/api/projects/${bootstrap.projectId}/members`, {
    headers: { origin, cookie: bootstrap.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') },
    data: { email, name: 'Alex Morgan', role: 'owner' },
  });
  expect(invitation.ok(), await invitation.text()).toBe(true);
  expect(await invitation.json()).not.toHaveProperty('temporaryPassword');
  await signInBrowser(page, origin, email);
  bootstrap.previousActor = await page.context().cookies();
}
