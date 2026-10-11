import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { ActionOutcome, Driver, DriverSession, Observation, ObservedNode, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { playwright, sessionFromPage } from '../src/index.ts';
import { PlaywrightSession } from '../src/session.ts';
import { browserAvailable, launchRaw } from './browser.ts';
import { startEdgeServer } from './edge-server.ts';
import type { EdgeServer } from './edge-server.ts';
import { startFixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const hasBrowser = await browserAvailable();
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };

let fx: Fixture;
let edge: EdgeServer;
let driver: Driver;
let browser: Browser;

function sessionOpts(): SessionOptions {
  return { scenarioId: 'guards', baseURL: fx.url, policy, resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : '') };
}
async function go(s: DriverSession, path: string): Promise<void> {
  const r = await s.perform({ verb: 'navigate', url: path });
  if (!r.ok) throw new Error(`navigate ${path}: ${JSON.stringify(r.error)}`);
}
const find = (obs: Observation, role: string, name: string): ObservedNode => {
  const n = obs.nodes.find((x) => x.role === role && x.name === name);
  if (n === undefined) throw new Error(`no ${role} ${JSON.stringify(name)} in\n${obs.treeText}`);
  return n;
};
const clickByName = async (s: DriverSession, role: string, name: string): Promise<ActionOutcome> => s.perform({ verb: 'click', target: { ref: find(await s.observe(), role, name).ref } });

/**
 * A session on a borrowed page whose CDP Fetch guard is switched off, which is how the guard behaves where CDP is not
 * available (the class documents `routeHandler` plus `requestHandler` as the fallback). Everything else is real.
 */
async function sessionWithoutCdp(page: Page): Promise<PlaywrightSession> {
  const s = new PlaywrightSession(page, sessionOpts(), { policy, baseURL: fx.url }, { ownsContext: false });
  (s as unknown as { attachRedirectGuard: () => Promise<void> }).attachRedirectGuard = async () => undefined;
  await s.install();
  return s;
}

describe.skipIf(!hasBrowser)('driver-playwright navigation guards', () => {
  beforeAll(async () => {
    fx = await startFixture();
    edge = await startEdgeServer();
    driver = await playwright({ actionTimeoutMs: 1500 }).create({ projectRoot: process.cwd(), policy, artifactsDir: process.cwd(), baseURL: fx.url });
    browser = await launchRaw();
  });
  afterAll(async () => {
    await driver.dispose();
    await browser.close();
    await edge.close();
    await fx.close();
  });

  describe('without the CDP guard (route and request listeners only)', () => {
    it('R-AG3: a click on a link to an off-host URL is answered by the route handler: POLICY_DENIED, the page stays put and the host sees nothing', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionWithoutCdp(page);
      await go(s, '/links');
      const r = await clickByName(s, 'link', 'Off host link');
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('POLICY_DENIED');
      expect(r.error?.details).toMatchObject({ url: `${fx.offHostUrl}/landed` });
      expect(r.error?.message.startsWith('navigation blocked: ')).toBe(true);
      expect(page.url()).toBe(`${fx.url}/links`);
      expect(fx.offHostHits).toEqual([]);
      await s.close();
      await ctx.close();
    });

    it('R-AG3: a redirect hop to an off-host URL is cancelled by the request listener and reported as a redirect denial', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionWithoutCdp(page);
      const r = await s.perform({ verb: 'navigate', url: '/redirect-off' });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('POLICY_DENIED');
      expect(r.error?.message.startsWith('navigation blocked: ')).toBe(true);
      expect(r.error?.details).toMatchObject({ url: `${fx.offHostUrl}/landed` });
      // The request listener saw the hop (the main-frame guard may report it as well, and it is the last word).
      const denials = (s as unknown as { denials: { url: string; reason: string }[] }).denials;
      expect(denials).toContainEqual({ url: `${fx.offHostUrl}/landed`, reason: expect.stringMatching(/^redirect: /) });
      // Without CDP the hop can still start to render; the main-frame guard then sends the page back to a blank document.
      await vi.waitFor(() => expect(page.url()).toBe('about:blank'), { timeout: 15_000, interval: 100 });
      expect(await page.locator('h1').count()).toBe(0);
      await s.close();
      await ctx.close();
      fx.offHostHits.length = 0;
    });

    it('R-AG3: a popup that gets past the page guard is closed when its first request is routed', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionWithoutCdp(page);
      await go(s, '/popup');
      await page.evaluate('window.__aiBddGuardOff = true'); // pretend the popup came from a gesture the page guard does not cover
      expect(ctx.pages()).toHaveLength(1);
      await clickByName(s, 'button', 'Open off-host');
      await vi.waitFor(() => {
        expect(ctx.pages()).toEqual([page]);
      }, { timeout: 15_000, interval: 100 });
      await s.close();
      await ctx.close();
      fx.offHostHits.length = 0;
    });

    it('R-AG3: a popup whose redirect leaves the allowed hosts is closed by the request listener', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionWithoutCdp(page);
      await go(s, '/popup');
      await page.evaluate('window.__aiBddGuardOff = true');
      await clickByName(s, 'button', 'Open redirecting');
      await vi.waitFor(() => {
        expect(ctx.pages()).toEqual([page]);
      }, { timeout: 15_000, interval: 100 });
      await s.close();
      await ctx.close();
      fx.offHostHits.length = 0;
    });
  });

  describe('with the CDP guard', () => {
    it('R-AG3: a same-host popup that navigates away to an off-host URL is closed and the denial is reported', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy, baseURL: fx.url });
      await go(s, `${edge.url}/open?to=${encodeURIComponent(`/popup-next?to=${fx.offHostUrl}/landed`)}`);
      await clickByName(s, 'button', 'Open window');
      await vi.waitFor(() => {
        expect(edge.hits).toContain('GET /popup-next');
      }, { timeout: 15_000, interval: 50 });
      await vi.waitFor(() => {
        expect(ctx.pages()).toEqual([page]);
      }, { timeout: 15_000, interval: 100 });
      // A borrowed page cannot intercept the popup before it exists, so the redirect hop may already have been sent (documented
      // limit of sessionFromPage). What is guaranteed: the popup does not survive and the denial is reported.
      const denials = (s as unknown as { denials: { url: string; reason: string }[] }).denials;
      expect(denials.some((d) => d.url.startsWith(fx.offHostUrl))).toBe(true);
      await s.close();
      await ctx.close();
      fx.offHostHits.length = 0;
    });

    it('R-AG3: a page opened by someone else in the same context on a URL the route cannot see (data:) is closed by the popup vetting', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy, baseURL: fx.url });
      const other = await ctx.newPage();
      await other.goto('data:text/html,<h1>hello</h1>').catch(() => undefined);
      await vi.waitFor(() => expect(other.isClosed()).toBe(true), { timeout: 15_000, interval: 100 });
      expect(page.isClosed()).toBe(false);
      await s.close();
      await ctx.close();
    });

    it('R-AG3: a main frame that ends up on a URL outside the policy without any request (blob:) is sent back to about:blank', async () => {
      const s = await driver.openSession(sessionOpts());
      await go(s, `${edge.url}/blob`);
      await clickByName(s, 'button', 'Go blob');
      await vi.waitFor(async () => expect((await s.observe()).url).toBe('about:blank'), { timeout: 15_000, interval: 100 });
      expect((await s.observe()).nodes.some((n) => n.name === 'from blob')).toBe(false);
      await s.close();
    });

    it('R-AG3: documents loaded in a subframe, including a redirecting one, do not blank or deny the main page', async () => {
      const s = await driver.openSession(sessionOpts());
      for (const src of [`${fx.url}/todos`, `${fx.url}/redirect-same`, `${fx.url}/redirect-off`]) {
        await go(s, `${edge.url}/frames?src=${encodeURIComponent(src)}`);
        await vi.waitFor(async () => expect((await s.perform({ verb: 'wait', ms: 50 })).ok).toBe(true), { timeout: 5000 });
        const obs = await s.observe();
        expect(obs.url).toBe(`${edge.url}/frames?src=${encodeURIComponent(src)}`);
        expect(find(obs, 'heading', 'Frames').level).toBe(1);
      }
      fx.offHostHits.length = 0;
      await s.close();
    });
  });
});

