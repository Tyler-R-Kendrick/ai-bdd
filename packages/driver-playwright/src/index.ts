import type { DriverSession, Policy, SessionOptions } from '@ai-bdd/sdk/contracts';
import type { Page } from 'playwright-core';
import { PlaywrightSession } from './session.ts';

export { playwright, createDriverFactory, discoverChromium } from './driver.ts';
export type { PlaywrightOptions } from './driver.ts';
export { parseAriaSnapshot, pruneWrappers } from './aria.ts';
export { CAPABILITIES, DRIVER_ID, DRIVER_VERSION, MAX_WAIT_MS, SECRET_SELECTOR } from './session.ts';

/**
 * Wrap an existing Playwright `page` (for example the `page` fixture of `@playwright/test`) as a driver session.
 * The page's context gets the navigation-policy route for the lifetime of the session. `close()` removes it and
 * never closes the page or its context.
 */
export async function sessionFromPage(page: Page, sessionOpts: SessionOptions, ctx: { policy: Policy; baseURL?: string }): Promise<DriverSession> {
  const session = new PlaywrightSession(page, sessionOpts, ctx, { ownsContext: false });
  await session.install();
  return session;
}
