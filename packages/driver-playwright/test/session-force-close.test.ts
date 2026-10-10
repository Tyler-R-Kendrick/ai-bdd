import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, CDPSession, Page } from 'playwright-core';
import type { Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { PlaywrightSession } from '../src/session.ts';
import { browserAvailable, launchRaw } from './browser.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const hasBrowser = await browserAvailable();
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const opts: SessionOptions = { scenarioId: 'force-close', policy, resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : '') };

interface Internals {
  forceClose(page: Page): Promise<void>;
  condemned: Set<Page>;
  context: { newCDPSession(page: Page): Promise<CDPSession> };
}

/** A page whose `close()` never settles: what a popup in the middle of a (cancelled) download can do on a slow machine. */
function stuckPage(): { page: Page; sent: string[]; state: { closed: boolean } } {
  const state = { closed: false };
  const sent: string[] = [];
  const page = { isClosed: () => state.closed, close: () => new Promise<void>(() => undefined) } as unknown as Page;
  return { page, sent, state };
}

describe.skipIf(!hasBrowser)('driver-playwright forceClose', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchRaw();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function session(): Promise<{ s: PlaywrightSession; internals: Internals; close: () => Promise<void> }> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const s = new PlaywrightSession(page, opts, { policy }, { ownsContext: false });
    await s.install();
    return { s, internals: s as unknown as Internals, close: async () => { await s.close(); await ctx.close(); } };
  }

  it('R-AG3: a page whose close() hangs is closed through a CDP session of its own', async () => {
    const { internals, close } = await session();
    try {
      const { page, sent, state } = stuckPage();
      internals.context.newCDPSession = async () => ({ send: async (method: string) => { sent.push(method); state.closed = true; } }) as unknown as CDPSession;
      await internals.forceClose(page);
      expect(sent).toEqual(['Page.close']);
      expect(page.isClosed()).toBe(true);
    } finally {
      await close();
    }
  });

  it('R-AG3: a condemned page stays condemned until it is gone, and the sweeper then forgets it', async () => {
    const { internals, close } = await session();
    try {
      const { page, state } = stuckPage();
      internals.context.newCDPSession = async () => { throw new Error('no CDP'); };
      await internals.forceClose(page);
      expect(page.isClosed()).toBe(false);
      expect(internals.condemned.has(page)).toBe(true); // still on the list: the sweeper will try again
      state.closed = true;
      await vi.waitFor(() => expect(internals.condemned.has(page)).toBe(false), { timeout: 5000, interval: 50 });
    } finally {
      await close();
    }
  });

  it('R-AG3: a CDP session that never opens does not block forceClose for long', async () => {
    const { internals, close } = await session();
    try {
      const { page } = stuckPage();
      internals.context.newCDPSession = () => new Promise<CDPSession>(() => undefined);
      const t0 = Date.now();
      await internals.forceClose(page);
      expect(Date.now() - t0).toBeLessThan(6000);
      expect(internals.condemned.has(page)).toBe(true);
    } finally {
      await close();
    }
  });

  it('R-AG3: an already closed page is not condemned', async () => {
    const { internals, close } = await session();
    try {
      const { page, state } = stuckPage();
      state.closed = true;
      await internals.forceClose(page);
      expect(internals.condemned.has(page)).toBe(false);
    } finally {
      await close();
    }
  });
});
