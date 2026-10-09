/**
 * @ai-bdd/driver-playwright — a real-browser driver on playwright-core.
 *
 * One BrowserContext per session gives isolation; the tree comes from
 * `ariaSnapshot()`; screenshots mask password inputs and `[data-ai-bdd-secret]`
 * elements and report `maskingProven`; navigation is checked against
 * `policy.allowHosts`; and settle waits for `readyState === 'complete'` with no
 * in-flight requests (section 11.1).
 */
import type { Driver, DriverContext, DriverFactory, DriverSession } from '@ai-bdd/contracts';
import { PlaywrightBrowser, PlaywrightSession, type PlaywrightDriverOptions } from './session.js';

export function playwright(options: PlaywrightDriverOptions = {}): DriverFactory {
  return {
    id: 'playwright',
    target: options.baseURL ?? 'default',
    async create(ctx: DriverContext): Promise<Driver> {
      const allowHosts = readAllowHosts(ctx.config) ?? options.allowHosts;
      const effective: PlaywrightDriverOptions = { ...options, ...(allowHosts !== undefined ? { allowHosts } : {}) };
      return {
        id: 'playwright',
        major: 1,
        capabilities: {
          verbs: [
            'navigate',
            'back',
            'tap',
            'doubleTap',
            'longPress',
            'secondaryTap',
            'hover',
            'type',
            'typeSecret',
            'press',
            'select',
            'check',
            'scroll',
            'scrollTo',
            'upload',
          ],
          pixels: true,
          tree: true,
          video: effective.video === true,
          nativePredicates: false,
          maskingProven: true,
        },
        concurrency: { maxSessions: effective.maxSessions ?? 4 },
        async selfCheck() {
          const problems: string[] = [];
          const probe = new PlaywrightBrowser(effective);
          try {
            const browser = await probe.instance();
            if (!browser.isConnected()) problems.push('the browser did not report a connection');
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          } finally {
            await probe.close();
          }
          return { ok: problems.length === 0, driver: 'playwright', problems };
        },
        async openSession(openCtx: DriverContext): Promise<DriverSession> {
          return PlaywrightSession.open(effective, openCtx.sessionId);
        },
      };
    },
  };
}

function readAllowHosts(config: unknown): string[] | undefined {
  if (config && typeof config === 'object') {
    const value = (config as { allowHosts?: unknown }).allowHosts;
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[];
  }
  return undefined;
}

export { PlaywrightBrowser, PlaywrightSession, PLAYWRIGHT_VERBS } from './session.js';
export { parseAriaSnapshot, structuralTreeHash, type LocatorDescriptor, type ParsedTree } from './tree.js';
export type { PlaywrightDriverOptions } from './session.js';
