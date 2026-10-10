import { afterAll } from 'vitest';
import { playwright } from '../src/index.ts';
import { runDriverConformance } from '../../sdk/test/kit/driver-conformance.ts';
import { browserAvailable } from './browser.ts';

/**
 * Shared driver conformance kit (spec 11.2) against the real Acme app. Needs Chromium and a working `startAcmeApp`;
 * without the app the kit still runs its identity and policy tests (appUrl undefined), so a stub app skips only the
 * app-dependent cases (documented in the kit).
 */
type AcmeApp = { url: string; close(): Promise<void> };

async function tryStartAcme(): Promise<AcmeApp | undefined> {
  try {
    const mod = (await import('@ai-bdd/testing')) as { startAcmeApp: (o?: object) => Promise<AcmeApp> };
    return await mod.startAcmeApp({});
  } catch {
    return undefined;
  }
}

if (await browserAvailable()) {
  const app = await tryStartAcme();
  afterAll(async () => {
    await app?.close();
  });
  runDriverConformance('playwright', () => playwright({ actionTimeoutMs: 3000 }), app === undefined ? {} : { appUrl: app.url });
}
