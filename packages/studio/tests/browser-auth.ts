import { expect, type Page, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:8877';
type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
let bootstrap:
  | { projectId: string; cookies: Cookies; previousActor: Cookies }
  | undefined;

/** Each test exercises the real invitation and sign-in flow with its own user. */
export async function signInAcceptanceActor(page: Page) {
  if (!bootstrap) {
    const demo = await page.request.post('/api/auth/demo', {
      headers: { origin },
    });
    expect(demo.ok(), await demo.text()).toBe(true);
    const cookies = await page.context().cookies();
    const response = await page.request.post('/api/projects', {
      headers: { origin },
      data: {
        title: 'Acceptance actor admission',
        description: 'Internal test account admission project.',
        repository: '',
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    bootstrap = {
      projectId: (await response.json()).id,
      cookies,
      previousActor: cookies,
    };
  }
  // Continue the preceding actor's authenticated browser session while changing
  // accounts. The invitation owner and each legitimate sign-in retain their real
  // production rate limits; no limiter or request identity is spoofed for tests.
  await page.context().addCookies(bootstrap.previousActor);
  const email = `acceptance-${randomUUID()}@example.test`;
  const invitation = await page.request.post(
    `/api/projects/${bootstrap.projectId}/members`,
    {
      headers: {
        origin,
        cookie: bootstrap.cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join('; '),
      },
      data: { email, name: 'Alex Morgan', role: 'owner' },
    },
  );
  expect(invitation.ok(), await invitation.text()).toBe(true);
  const credentials = await invitation.json();
  const login = await page.request.post('/api/auth/login', {
    headers: { origin },
    data: { email, password: credentials.temporaryPassword },
  });
  expect(login.ok(), await login.text()).toBe(true);
  bootstrap.previousActor = await page.context().cookies();
}
