import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { Driver, DriverAction, DriverSession, Observation, ObservedNode, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { playwright, sessionFromPage } from '../src/index.ts';
import { browserAvailable, launchRaw } from './browser.ts';
import { startEdgeServer } from './edge-server.ts';
import type { EdgeServer } from './edge-server.ts';
import { startFixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const hasBrowser = await browserAvailable();
const SECRET = 'sekret-value-1';
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };

let fx: Fixture;
let edge: EdgeServer;
let driver: Driver;
let browser: Browser;

function sessionOpts(over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    scenarioId: 'edge', baseURL: edge.url, policy,
    resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? SECRET : ''),
    ...over,
  };
}
const open = (over: Partial<SessionOptions> = {}): Promise<DriverSession> => driver.openSession(sessionOpts(over));
async function go(s: DriverSession, path: string): Promise<void> {
  const r = await s.perform({ verb: 'navigate', url: path });
  if (!r.ok) throw new Error(`navigate ${path}: ${JSON.stringify(r.error)}`);
}
/** An origin on localhost that nothing listens on (port 1 is "unsafe" to Chromium and fails differently). */
let dead: string;
const find = (obs: Observation, role: string, name: string): ObservedNode => {
  const n = obs.nodes.find((x) => x.role === role && x.name === name);
  if (n === undefined) throw new Error(`no ${role} ${JSON.stringify(name)} in\n${obs.treeText}`);
  return n;
};

describe.skipIf(!hasBrowser)('driver-playwright perform and observe edge cases', () => {
  beforeAll(async () => {
    fx = await startFixture();
    edge = await startEdgeServer();
    driver = await playwright({ actionTimeoutMs: 1500 }).create({ projectRoot: process.cwd(), policy, artifactsDir: process.cwd(), baseURL: edge.url });
    browser = await launchRaw();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, 'localhost', r));
    dead = `http://localhost:${(probe.address() as AddressInfo).port}`;
    await new Promise<void>((r) => probe.close(() => r()));
  });
  afterAll(async () => {
    await driver.dispose();
    await browser.close();
    await edge.close();
    await fx.close();
  });

  describe('perform()', () => {
    it('R-AG1: a verb outside the capability list is VERB_UNSUPPORTED and non-retryable', async () => {
      const s = await open();
      const r = await s.perform({ verb: 'teleport' } as unknown as DriverAction);
      expect(r).toEqual({ ok: false, error: { code: 'VERB_UNSUPPORTED', message: 'verb teleport is not supported', retryable: false } });
      await s.close();
    });

    it('R-SE2: select with a secret taints the session, and the chosen value is scrubbed from everything observed afterwards', async () => {
      const s = await open();
      await go(s, '/secret-select');
      const before = await s.observe();
      expect(before.tainted).toBe(false);
      expect(before.treeText).toContain(SECRET); // visible as an option label until it is known to be secret
      const picked = await s.perform({ verb: 'select', target: { ref: find(before, 'combobox', 'Token').ref }, option: { secret: 'token' } });
      expect(picked.ok).toBe(true);
      const after = await s.observe();
      expect(after.tainted).toBe(true);
      expect(after.treeText).not.toContain(SECRET);
      expect(JSON.stringify(after.nodes)).not.toContain(SECRET);
      expect(after.treeText).toContain('Chosen: [secret]');
      await s.close();
    });

    it('R-SE2: a literal select does not taint and is not scrubbed', async () => {
      const s = await open();
      await go(s, '/secret-select');
      const obs = await s.observe();
      const r = await s.perform({ verb: 'select', target: { ref: find(obs, 'combobox', 'Token').ref }, option: { literal: SECRET } });
      expect(r.ok).toBe(true);
      const after = await s.observe();
      expect(after.tainted).toBe(false);
      expect(after.treeText).toContain(`Chosen: ${SECRET}`);
      await s.close();
    });

    it('R-AG1: scroll with a target hovers it first and then scrolls in the requested direction', async () => {
      const s = await open({ baseURL: fx.url });
      await go(s, '/playground');
      const obs = await s.observe();
      expect(await s.perform({ verb: 'scroll', direction: 'down', target: { ref: find(obs, 'button', 'Hover me').ref } })).toEqual({ ok: true });
      const down = await s.observe();
      expect(find(down, 'status', 'scrolled:down').role).toBe('status');
      expect(await s.perform({ verb: 'scroll', direction: 'up', target: { ref: find(down, 'button', 'Hover me').ref } })).toEqual({ ok: true });
      expect(find(await s.observe(), 'status', 'scrolled:top').role).toBe('status');
      await s.close();
    });

    it('R-AG1: nodes without an aria ref are reachable through role/text locators: a text node, and an unnamed role found but not actionable', async () => {
      const s = await open();
      await go(s, '/mixed');
      const obs = await s.observe();
      const text = obs.nodes.find((n) => n.role === 'text' && n.text === 'Lonely');
      expect(text?.ref).toMatch(/^r\d+:n\d+$/);
      expect(await s.perform({ verb: 'hover', target: { ref: (text as ObservedNode).ref } })).toEqual({ ok: true });
      const hovered = await s.observe();
      expect(find(hovered, 'status', 'hover-text').role).toBe('status');

      // A zero-size progressbar has no aria ref and no name. The role locator finds exactly it (so this is a timeout, not
      // TARGET_NOT_FOUND), but it cannot be hovered.
      const unnamed = hovered.nodes.find((n) => n.role === 'progressbar');
      expect(unnamed).toMatchObject({ name: '' });
      expect(unnamed?.ref).toMatch(/^r\d+:n\d+$/);
      const r = await s.perform({ verb: 'hover', target: { ref: (unnamed as ObservedNode).ref } });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('DRIVER_ERROR');
      expect(r.error?.message).toMatch(/^timed out: .*Timeout 1500ms exceeded/);
      await s.close();
    });

    it('R-AG1: an action the browser rejects outright (fill on a button) is a DRIVER_ERROR with the first line of the cause', async () => {
      const s = await open();
      await go(s, '/plain');
      const obs = await s.observe();
      const r = await s.perform({ verb: 'fill', target: { ref: find(obs, 'button', 'Press me').ref }, value: { literal: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('DRIVER_ERROR');
      expect(r.error?.message).toContain('Element is not an <input>');
      expect(r.error?.message).not.toContain('\n');
      await s.close();
    });

    it('R-AG1: a navigation the network refuses is a DRIVER_ERROR (not POLICY_DENIED) and the session stays usable afterwards', async () => {
      const s = await open();
      await go(s, '/plain');
      const r = await s.perform({ verb: 'navigate', url: `${dead}/nothing` });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('DRIVER_ERROR');
      expect(r.error?.message).toContain('ERR_CONNECTION_REFUSED');
      // Chromium commits its error page asynchronously, so an immediate retry may collide with it: retry until it takes.
      await vi.waitFor(async () => expect((await s.perform({ verb: 'navigate', url: '/plain' })).ok).toBe(true), { timeout: 10_000, interval: 100 });
      expect((await s.observe()).title).toBe('Edge');
      await s.close();
    });

    it('R-SE1: secrets are redacted from error messages, and long messages are cut at 300 characters', async () => {
      const s = await open();
      await go(s, '/secret-select');
      const obs = await s.observe();
      expect((await s.perform({ verb: 'select', target: { ref: find(obs, 'combobox', 'Token').ref }, option: { secret: 'token' } })).ok).toBe(true);
      const leaked = await s.perform({ verb: 'navigate', url: `${dead}/${SECRET}/tail` });
      expect(leaked.ok).toBe(false);
      expect(leaked.error?.message).toContain('ERR_CONNECTION_REFUSED');
      expect(leaked.error?.message).toContain(`${dead}/***/tail`);
      expect(leaked.error?.message).not.toContain(SECRET);
      const long = await s.perform({ verb: 'navigate', url: `${dead}/${'x'.repeat(400)}` });
      expect(long.ok).toBe(false);
      expect(long.error?.message.length).toBe(303);
      expect(long.error?.message.endsWith('...')).toBe(true);
      await s.close();
    });

    it('R-AG1: a navigation that exceeds navigationTimeoutMs is a retryable DRIVER_ERROR "timed out"', async () => {
      const quick = await playwright({ navigationTimeoutMs: 400 }).create({ projectRoot: '.', policy, artifactsDir: process.cwd(), baseURL: edge.url });
      const s = await quick.openSession(sessionOpts());
      const r = await s.perform({ verb: 'navigate', url: '/hang' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatchObject({ code: 'DRIVER_ERROR', retryable: true });
      expect(r.error?.message).toMatch(/^timed out: .*Timeout 400ms exceeded/);
      await s.close();
      await quick.dispose();
    });

    it('R-AG1: actionTimeoutMs bounds element actions: a click on a disabled button times out with that limit', async () => {
      const quick = await playwright({ actionTimeoutMs: 300 }).create({ projectRoot: '.', policy, artifactsDir: process.cwd(), baseURL: fx.url });
      const s = await quick.openSession(sessionOpts({ baseURL: fx.url }));
      await go(s, '/settings/billing');
      const obs = await s.observe();
      const r = await s.perform({ verb: 'click', target: { ref: find(obs, 'button', 'Downgrade to Free').ref } });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('DRIVER_ERROR');
      expect(r.error?.message).toMatch(/^timed out: .*Timeout 300ms exceeded/);
      await s.close();
      await quick.dispose();
    });
  });

  describe('closed pages and contexts', () => {
    async function borrowed(): Promise<{ s: DriverSession; page: Page; close(): Promise<void> }> {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy, baseURL: edge.url });
      return { s, page, close: () => ctx.close() };
    }

    it('V7: once the browser context is gone, observe, perform and request fail with DRIVER_UNAVAILABLE and close() still resolves', async () => {
      const { s, close } = await borrowed();
      await go(s, '/plain');
      const obs = await s.observe();
      const button = find(obs, 'button', 'Press me');
      await close();
      await expect(s.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
      expect(button.ref).toMatch(/^r\d+:/);
      const r = await s.perform({ verb: 'press', key: 'a' });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('DRIVER_UNAVAILABLE');
      await expect(s.request?.({ method: 'GET', path: '/text' }) as Promise<unknown>).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
      await expect(s.close()).resolves.toBeUndefined();
      await expect(s.close()).resolves.toBeUndefined();
    });

    it('V7: sessionFromPage on a page that is already closed still returns a session; using it reports DRIVER_UNAVAILABLE', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.close();
      const s = await sessionFromPage(page, sessionOpts(), { policy, baseURL: edge.url });
      await expect(s.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
      await s.close();
      await ctx.close();
    });

    it('R-SDK3: close() does not hang behind a navigation that timed out and is still pending, for borrowed and owned pages', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy, baseURL: edge.url });
      void page.goto(`${edge.url}/hang`).catch(() => undefined);
      await vi.waitFor(() => expect(edge.hits).toContain('GET /hang'));
      await s.close();
      expect(page.isClosed()).toBe(false);
      await ctx.close();

      const owned = await playwright({ navigationTimeoutMs: 300 }).create({ projectRoot: '.', policy, artifactsDir: process.cwd(), baseURL: edge.url });
      const o = await owned.openSession(sessionOpts());
      expect((await o.perform({ verb: 'navigate', url: '/hang' })).error?.code).toBe('DRIVER_ERROR');
      await o.close();
      await owned.dispose();
    });

    it('R-SDK3: a borrowed page showing a browser error page can be wrapped, used and released', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(dead).catch(() => undefined);
      const s = await sessionFromPage(page, sessionOpts(), { policy, baseURL: edge.url });
      await go(s, '/plain');
      expect((await s.observe()).title).toBe('Edge');
      await s.close();
      expect(page.isClosed()).toBe(false);
      await ctx.close();
    });
  });
});
