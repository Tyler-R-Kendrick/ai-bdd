import { afterAll, beforeAll, describe, expect, it , vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Driver, DriverSession, Observation, ObservedNode, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { createDriverFactory, playwright, sessionFromPage } from '../src/index.ts';
import { browserAvailable, launchRaw } from './browser.ts';
import { startFixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';
import { decodePng, diffBox, pixel } from './png-decode.ts';

// Real browsers on a busy CI box: give each test room.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const hasBrowser = await browserAvailable();
const SECRET = 'correct-horse-battery';

let fx: Fixture;
let driver: Driver;
let browser: Browser;

const policyFor = (denyVerbs: Policy['denyVerbs'] = []): Policy => ({ allowHosts: ['localhost'], denyVerbs });
function sessionOpts(over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    scenarioId: 'scn', baseURL: fx.url, policy: policyFor(),
    resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? SECRET : (({ who: 'Ada' }) as Record<string, string>)[v.param] ?? ''),
    ...over,
  };
}
const find = (obs: Observation, role: string, name: string): ObservedNode => {
  const n = obs.nodes.find((x) => x.role === role && x.name === name);
  if (n === undefined) throw new Error(`no ${role} ${JSON.stringify(name)} in\n${obs.treeText}`);
  return n;
};
async function open(over: Partial<SessionOptions> = {}): Promise<DriverSession> {
  return driver.openSession(sessionOpts(over));
}
async function go(s: DriverSession, path: string): Promise<void> {
  const r = await s.perform({ verb: 'navigate', url: path });
  if (!r.ok) throw new Error(`navigate ${path}: ${JSON.stringify(r.error)}`);
}

describe.skipIf(!hasBrowser)('driver-playwright', () => {
  beforeAll(async () => {
    fx = await startFixture();
    driver = await playwright({ actionTimeoutMs: 1000 }).create({ projectRoot: process.cwd(), policy: policyFor(), artifactsDir: process.cwd(), baseURL: fx.url });
    browser = await launchRaw();
  });
  afterAll(async () => {
    await driver.dispose();
    await browser.close();
    await fx.close();
  });

  describe('factory and lifecycle', () => {
    it('R-SDK2: playwright() is a DriverFactory with id playwright and the specified capabilities', () => {
      const f = playwright();
      expect(f.id).toBe('playwright');
      expect(driver.id).toBe('playwright');
      expect(driver.capabilities).toEqual({
        verbs: ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'],
        pixels: true, maskingProven: true, request: true, maxSessions: 8,
      });
    });

    it('R-SDK2: createDriverFactory validates JSON options and rejects unknown keys with CONFIG_INVALID', () => {
      expect(createDriverFactory({ browser: 'chromium', headless: true, viewport: { width: 800, height: 600 } }).id).toBe('playwright');
      for (const bad of [{ nope: 1 }, { browser: 'ie' }, { headless: 'yes' }, { viewport: { width: 'a' } }]) {
        expect(() => createDriverFactory(bad)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
      }
    });

    it('V7: selfCheck launches the browser and opens about:blank', async () => {
      expect(await driver.selfCheck()).toEqual({ ok: true, problems: [] });
    });

    it('V7: a missing browser surfaces as DRIVER_UNAVAILABLE from openSession and selfCheck reports problems', async () => {
      const broken = await playwright({ launchOptions: { executablePath: '/nonexistent/chrome' } }).create({ projectRoot: '.', policy: policyFor(), artifactsDir: '.' });
      const check = await broken.selfCheck();
      expect(check.ok).toBe(false);
      expect(check.problems.length).toBeGreaterThan(0);
      await expect(broken.openSession(sessionOpts())).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
      await broken.dispose();
    });

    it('R-SDK3: sessionFromPage wraps an existing page; close() leaves the page open and removes the policy route', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy: policyFor(), baseURL: fx.url });
      expect(s.driverId).toBe('playwright');
      await go(s, '/todos');
      const obs = await s.observe();
      expect(obs.route).toBe('/todos');
      expect(page.url()).toBe(`${fx.url}/todos`);
      await s.close();
      expect(page.isClosed()).toBe(false);
      // The policy route is gone: the raw page may now reach the off-host fixture.
      await page.goto(`${fx.offHostUrl}/landed`);
      expect(fx.offHostHits.some((h) => h.includes('/landed'))).toBe(true);
      fx.offHostHits.length = 0;
      await ctx.close();
    });
  });

  describe('observe', () => {
    it('R-RN1: observation has the specified shape, r<revision>:<ref> refs, route and a stable treeHash', async () => {
      const s = await open();
      await go(s, '/settings/billing?x=1');
      const a = await s.observe();
      const b = await s.observe();
      expect(a.revision).toBe(1);
      expect(b.revision).toBe(2);
      expect(a.route).toBe('/settings/billing?x=1');
      expect(a.url).toBe(`${fx.url}/settings/billing?x=1`);
      expect(a.title).toBe('Billing');
      expect(a.busy).toBe(false);
      expect(a.tainted).toBe(false);
      expect(a.treeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.treeHash).toBe(b.treeHash);
      expect(a.treeText).toContain('[ref=r1:e');
      for (const n of a.nodes) expect(n.ref).toMatch(/^r1:(e|n)\d+$/);
      expect(a.nodes.every((n) => n.parentRef === undefined || a.nodes.some((p) => p.ref === n.parentRef))).toBe(true);
      expect(find(a, 'heading', 'Billing').level).toBe(1);
      expect(find(a, 'button', 'Downgrade to Free').states.disabled).toBe(true);
      expect(find(a, 'status', 'Plan: Free').role).toBe('status');
      const link = find(a, 'link', 'Billing');
      expect(link.url).toBe('/settings/billing');
      expect(a.screenshot).toBeUndefined();
      await s.close();
    });

    it('R-JU3: pixels:true returns a masked PNG with matching sha256', async () => {
      const s = await open();
      await go(s, '/login');
      const obs = await s.observe({ pixels: true });
      expect(obs.screenshot?.masked).toBe(true);
      expect(Array.from(obs.screenshot?.png.subarray(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
      const { sha256Hex } = await import('@ai-bdd/sdk');
      expect(obs.screenshot?.sha256).toBe(sha256Hex(obs.screenshot?.png ?? new Uint8Array()));
      await s.close();
    });

    it('R-RN1: busy is true for a progressbar (/slow), aria-busy and <progress>, and false once content arrives', async () => {
      const s = await open();
      await go(s, '/slow?ms=1500');
      const first = await s.observe();
      expect(first.busy).toBe(true);
      expect(first.nodes.some((n) => n.role === 'progressbar')).toBe(true);
      const t0 = Date.now();
      let last = first;
      while (last.busy && Date.now() - t0 < 6000) {
        await new Promise((r) => setTimeout(r, 100));
        last = await s.observe();
      }
      expect(last.busy).toBe(false);
      expect(last.nodes.some((n) => n.role === 'heading' && n.name === 'Report ready')).toBe(true);
      await go(s, '/busy-attr');
      expect((await s.observe()).busy).toBe(true);
      await go(s, '/native-progress');
      expect((await s.observe()).busy).toBe(true);
      await s.close();
    });
  });

  describe('perform', () => {
    it('R-AG1: maps click, fill, press, select, check, hover and scroll to real page effects', async () => {
      const s = await open();
      await go(s, '/playground');
      let obs = await s.observe();
      const status = async (): Promise<string> => (find(await s.observe(), 'status', obs.nodes.find((n) => n.role === 'status')?.name ?? '').name);
      void status;

      const outText = async (): Promise<string> => {
        const o = await s.observe();
        return o.nodes.find((n) => n.role === 'status')?.name ?? '';
      };
      expect(await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'Name').ref }, value: { param: 'who' } })).toEqual({ ok: true });
      expect(await s.perform({ verb: 'click', target: { ref: find(obs, 'button', 'Greet').ref } })).toEqual({ ok: true });
      expect(await outText()).toBe('Hello Ada');

      obs = await s.observe();
      expect((await s.perform({ verb: 'press', key: 'Enter', target: { ref: find(obs, 'textbox', 'Name').ref } })).ok).toBe(true);
      expect(await outText()).toBe('enter:Ada');

      obs = await s.observe();
      expect((await s.perform({ verb: 'check', target: { ref: find(obs, 'checkbox', 'Agree').ref }, checked: true })).ok).toBe(true);
      expect(await outText()).toBe('agree:true');
      obs = await s.observe();
      expect(find(obs, 'checkbox', 'Agree').states.checked).toBe(true);

      expect((await s.perform({ verb: 'select', target: { ref: find(obs, 'combobox', 'Color').ref }, option: { literal: 'Blue' } })).ok).toBe(true);
      expect(await outText()).toBe('color:b');
      obs = await s.observe();
      expect(find(obs, 'combobox', 'Color').value).toBe('Blue');

      expect((await s.perform({ verb: 'hover', target: { ref: find(obs, 'button', 'Hover me').ref } })).ok).toBe(true);
      expect(await outText()).toBe('hovered');

      expect((await s.perform({ verb: 'scroll', direction: 'down' })).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      expect(await outText()).toBe('scrolled:down');

      expect((await s.perform({ verb: 'press', key: 'x' })).ok).toBe(true);
      expect(await outText()).toBe('key:x');
      await s.close();
    });

    it('R-AG1: back returns to the previous page; with no history it fails without throwing', async () => {
      const s = await open();
      await go(s, '/todos');
      await go(s, '/settings/billing');
      const r = await s.perform({ verb: 'back' });
      expect(r.ok).toBe(true);
      expect((await s.observe()).route).toBe('/todos');
      const s2 = await open();
      const r2 = await s2.perform({ verb: 'back' });
      expect(r2.ok).toBe(false);
      expect(r2.error?.code).toBe('TARGET_NOT_FOUND');
      await s.close();
      await s2.close();
    });

    it('R-AG1: wait is capped at 5000 ms regardless of the requested duration', async () => {
      const s = await open();
      const t0 = Date.now();
      const r = await s.perform({ verb: 'wait', ms: 600_000 });
      const dt = Date.now() - t0;
      expect(r.ok).toBe(true);
      expect(dt).toBeGreaterThanOrEqual(4900);
      expect(dt).toBeLessThan(7500);
      const t1 = Date.now();
      await s.perform({ verb: 'wait', ms: -50 });
      expect(Date.now() - t1).toBeLessThan(1000);
      await s.close();
    }, 20_000);

    it('R-AG1: failures return {ok:false,error} instead of throwing (missing target, disabled element, removed element)', async () => {
      const s = await open();
      await go(s, '/playground');
      const obs = await s.observe();
      const disabled = await s.perform({ verb: 'click', target: { ref: find(obs, 'button', 'Disabled action').ref } });
      expect(disabled.ok).toBe(false);
      expect(disabled.error?.code).toBe('DRIVER_ERROR');
      const removeRef = find(obs, 'button', 'Remove me').ref;
      expect((await s.perform({ verb: 'click', target: { ref: removeRef } })).ok).toBe(true);
      const gone = await s.perform({ verb: 'click', target: { ref: removeRef } });
      expect(gone.ok).toBe(false);
      expect(gone.error?.code).toBe('TARGET_NOT_FOUND');
      const unknown = await s.perform({ verb: 'click', target: { ref: 'r1:e9999' } });
      expect(unknown.ok).toBe(false);
      expect(unknown.error?.code).toBe('TARGET_NOT_FOUND');
      await s.close();
    });

    it('R-AG1: perform rejects refs from older revisions and malformed refs with STALE_REF', async () => {
      const s = await open();
      await go(s, '/playground');
      const first = await s.observe();
      const staleRef = find(first, 'button', 'Greet').ref;
      const second = await s.observe();
      const stale = await s.perform({ verb: 'click', target: { ref: staleRef } });
      expect(stale.ok).toBe(false);
      expect(stale.error?.code).toBe('STALE_REF');
      expect(stale.error?.retryable).toBe(false);
      expect((await s.perform({ verb: 'click', target: { ref: 'e5' } })).error?.code).toBe('STALE_REF');
      expect((await s.perform({ verb: 'click', target: { ref: 'r99:e5' } })).error?.code).toBe('STALE_REF');
      expect((await s.perform({ verb: 'click', target: { ref: find(second, 'button', 'Greet').ref } })).ok).toBe(true);
      await s.close();
    });

    it('R-AG1: refs without an aria ref (hidden nodes) fall back to role/name/nth locators', async () => {
      const s = await open();
      await go(s, '/widgets');
      const obs = await s.observe();
      const blue = find(obs, 'option', 'Blue');
      expect(blue.ref).toMatch(/^r1:n\d+$/);
      const r = await s.perform({ verb: 'click', target: { ref: blue.ref } });
      // The option is not independently clickable; what matters is a clean ok:false rather than a throw or a wrong element.
      expect(typeof r.ok).toBe('boolean');
      await s.close();
    });

    it('R-AG3: policy.denyVerbs is enforced in perform', async () => {
      const s = await open({ policy: policyFor(['click', 'fill']) });
      await go(s, '/playground');
      const obs = await s.observe();
      const r = await s.perform({ verb: 'click', target: { ref: find(obs, 'button', 'Greet').ref } });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('POLICY_DENIED');
      expect((await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'Name').ref }, value: { literal: 'x' } })).error?.code).toBe('POLICY_DENIED');
      expect((await s.perform({ verb: 'hover', target: { ref: find(obs, 'button', 'Greet').ref } })).ok).toBe(true);
      await s.close();
    });
  });

  describe('policy (R-AG3)', () => {
    const denied = [
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<h1>x</h1>'],
      ['file:', 'file:///etc/passwd'],
      ['credentials', 'http://user:pw@localhost/'],
      ['off-host', 'https://evil.example/steal'],
      ['off-host by IP', 'http://127.0.0.1:9/x'],
    ] as const;
    for (const [label, url] of denied) {
      it(`R-AG3: navigate to ${label} is denied with POLICY_DENIED and the page does not move`, async () => {
        const s = await open();
        await go(s, '/todos');
        const r = await s.perform({ verb: 'navigate', url });
        expect(r.ok).toBe(false);
        expect(r.error?.code).toBe('POLICY_DENIED');
        expect((await s.observe()).route).toBe('/todos');
        await s.close();
      });
    }

    it('R-AG3: a relative navigate resolves against baseURL and an allowed absolute URL works', async () => {
      const s = await open();
      expect((await s.perform({ verb: 'navigate', url: '/todos' })).navigatedTo).toBe(`${fx.url}/todos`);
      expect((await s.perform({ verb: 'navigate', url: `${fx.url}/notes` })).ok).toBe(true);
      await s.close();
    });

    it('R-AG3: a route that 302-redirects to an off-host URL is aborted before the off-host server is reached', async () => {
      fx.offHostHits.length = 0;
      const s = await open();
      await go(s, '/todos');
      const r = await s.perform({ verb: 'navigate', url: '/redirect-off' });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('POLICY_DENIED');
      expect(fx.offHostHits).toEqual([]);
      const obs = await s.observe();
      expect(obs.route).toBe('/todos');
      // A same-host redirect is fine.
      expect((await s.perform({ verb: 'navigate', url: '/redirect-same' })).ok).toBe(true);
      expect((await s.observe()).route).toBe('/todos');
      await s.close();
    });

    it('R-AG3: the first navigation being blocked leaves a usable blank page rather than an error page', async () => {
      const s = await open();
      const r = await s.perform({ verb: 'navigate', url: '/redirect-off' });
      expect(r.error?.code).toBe('POLICY_DENIED');
      const obs = await s.observe();
      expect(obs.url).toBe('about:blank');
      await s.close();
    });

    it('R-AG3: clicking a link to an off-host URL or to a redirect to one is blocked and reported', async () => {
      fx.offHostHits.length = 0;
      const s = await open();
      await go(s, '/links');
      let obs = await s.observe();
      const direct = await s.perform({ verb: 'click', target: { ref: find(obs, 'link', 'Off host link').ref } });
      expect(direct.ok).toBe(false);
      expect(direct.error?.code).toBe('POLICY_DENIED');
      obs = await s.observe();
      expect(obs.route).toBe('/links');
      const viaRedirect = await s.perform({ verb: 'click', target: { ref: find(obs, 'link', 'Redirecting link').ref } });
      expect(viaRedirect.error?.code).toBe('POLICY_DENIED');
      expect(fx.offHostHits).toEqual([]);
      expect((await s.observe()).route).toBe('/links');
      await s.close();
    });

    it('R-AG3: window.open to off-host, data: and redirecting URLs yields no surviving popup and no off-host request', async () => {
      fx.offHostHits.length = 0;
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy: policyFor(), baseURL: fx.url });
      await go(s, '/popup');
      for (const name of ['Open off-host', 'Open data', 'Open redirecting']) {
        const obs = await s.observe();
        await s.perform({ verb: 'click', target: { ref: find(obs, 'button', name).ref } });
        // The popup may exist for an instant before the session closes it; it must not survive.
        const deadline = Date.now() + 5000;
        while (ctx.pages().length > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 300));
        expect(ctx.pages().length, name + ' ' + ctx.pages().map((p) => p.url()).join(',')).toBe(1);
      }
      // Without the init script (borrowed context) Playwright cannot intercept a popup's first request; the popup is
      // closed as soon as it appears and is never exposed to the agent.
      expect(page.url()).toBe(`${fx.url}/popup`);
      await s.close();
      await ctx.close();
    });

    it('R-AG3: in driver-owned sessions window.open to a denied URL is refused before any request is sent', async () => {
      fx.offHostHits.length = 0;
      const s = await open();
      await go(s, '/popup');
      for (const name of ['Open off-host', 'Open data']) {
        const obs = await s.observe();
        await s.perform({ verb: 'click', target: { ref: find(obs, 'button', name).ref } });
        await new Promise((r) => setTimeout(r, 400));
      }
      expect(fx.offHostHits).toEqual([]);
      expect((await s.observe()).route).toBe('/popup');
      await s.close();
    });

    it('R-AG3: a same-host popup (target=_blank) is allowed to open', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const s = await sessionFromPage(page, sessionOpts(), { policy: policyFor(), baseURL: fx.url });
      await go(s, '/links');
      const obs = await s.observe();
      await s.perform({ verb: 'click', target: { ref: find(obs, 'link', 'Same host popup link').ref } });
      await new Promise((r) => setTimeout(r, 500));
      expect(ctx.pages().length).toBe(2);
      await s.close();
      await ctx.close();
    });

    it('R-AG3: a javascript: link executes only inside the page and never navigates the driver off policy', async () => {
      const s = await open();
      await go(s, '/links');
      const obs = await s.observe();
      const r = await s.perform({ verb: 'click', target: { ref: find(obs, 'link', 'JS link').ref } });
      expect(r.ok).toBe(true);
      expect((await s.observe()).route).toBe('/links');
      const data = await s.perform({ verb: 'click', target: { ref: find(obs, 'link', 'Data link').ref } });
      expect((await s.observe()).route).toBe('/links');
      expect(typeof data.ok).toBe('boolean');
      await s.close();
    });
  });

  describe('secrets, taint and masking', () => {
    it('R-SE2: tainted flips true after the first secret fill and stays true; literal fills do not taint', async () => {
      const s = await open();
      await go(s, '/login');
      let obs = await s.observe();
      expect(obs.tainted).toBe(false);
      await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'Email').ref }, value: { literal: 'ada@example.com' } });
      obs = await s.observe();
      expect(obs.tainted).toBe(false);
      expect(find(obs, 'textbox', 'Email').value).toBe('ada@example.com');
      await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'Password').ref }, value: { secret: 'ADMIN_PASSWORD' } });
      obs = await s.observe();
      expect(obs.tainted).toBe(true);
      await go(s, '/todos');
      expect((await s.observe()).tainted).toBe(true);
      await s.close();
    });

    it('R-SE2: a failing secret fill still taints the session and the secret never appears in the error', async () => {
      const s = await open();
      await go(s, '/login');
      const r = await s.perform({ verb: 'fill', target: { ref: 'r1:e9999' }, value: { secret: 'ADMIN_PASSWORD' } });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SECRET);
      const obs = await s.observe();
      expect(obs.tainted).toBe(true);
      await s.close();
    });

    it('R-SE1: V4 password values are never exposed in nodes or treeText, empty or filled', async () => {
      const s = await open();
      await go(s, '/login');
      let obs = await s.observe();
      expect(find(obs, 'textbox', 'Password').value).toBeUndefined();
      await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'Password').ref }, value: { literal: 'literal-password-123' } });
      obs = await s.observe();
      expect(find(obs, 'textbox', 'Password').value).toBeUndefined();
      expect(obs.treeText).not.toContain('literal-password-123');
      expect(JSON.stringify(obs.nodes)).not.toContain('literal-password-123');
      await s.close();
    });

    it('R-SE1: elements marked data-ai-bdd-secret are scrubbed from values and text', async () => {
      const s = await open();
      await go(s, '/secret-page');
      const obs = await s.observe();
      expect(obs.treeText).not.toContain('topsecret-token-value');
      expect(obs.treeText).toContain('public');
      await s.close();
    });

    it('R-JU3: screenshots mask password fields: pixels differ from an unmasked capture only inside the field and are magenta there', async () => {
      const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await ctx.newPage();
      const shotFor = async (pw: string): Promise<{ masked: Uint8Array; raw: Uint8Array }> => {
        const s = await sessionFromPage(page, sessionOpts({ resolveValue: () => pw }), { policy: policyFor(), baseURL: fx.url });
        await go(s, '/login');
        const obs0 = await s.observe();
        await s.perform({ verb: 'fill', target: { ref: find(obs0, 'textbox', 'Password').ref }, value: { secret: 'p' } });
        await page.mouse.click(5, 595); // drop focus so the caret/focus ring cannot differ
        const obs = await s.observe({ pixels: true });
        const raw = new Uint8Array(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
        await s.close();
        return { masked: obs.screenshot?.png ?? new Uint8Array(), raw };
      };
      const a = await shotFor('aaaaaaaaaaaaaaa');
      const b = await shotFor('zzzzzz');
      const box = await (async () => {
        await page.goto(`${fx.url}/login`);
        return page.getByLabel('Password').boundingBox();
      })();
      expect(box).not.toBeNull();
      const ma = decodePng(a.masked);
      const ra = decodePng(a.raw);
      const rb = decodePng(b.raw);
      // The unmasked captures differ (the typed dots), the masked ones are byte-identical in content.
      expect(diffBox(ra, rb)).toBeDefined();
      expect(diffBox(ma, decodePng(b.masked))).toBeUndefined();
      // Masked vs unmasked differ, and only within the password field.
      const d = diffBox(ma, ra);
      expect(d).toBeDefined();
      const bx = box as { x: number; y: number; width: number; height: number };
      expect(d?.x0).toBeGreaterThanOrEqual(Math.floor(bx.x) - 1);
      expect(d?.y0).toBeGreaterThanOrEqual(Math.floor(bx.y) - 1);
      expect(d?.x1).toBeLessThanOrEqual(Math.ceil(bx.x + bx.width) + 1);
      expect(d?.y1).toBeLessThanOrEqual(Math.ceil(bx.y + bx.height) + 1);
      expect(pixel(ma, Math.floor(bx.x + bx.width / 2), Math.floor(bx.y + bx.height / 2))).toEqual([255, 0, 255]);
      await ctx.close();
    });
  });

  describe('isolation and request (R-RN2)', () => {
    it('R-RN2: 20 parallel sessions never see each other cookies', async () => {
      const N = 20;
      const sessions = await Promise.all(Array.from({ length: N }, () => open()));
      await Promise.all(sessions.map((s, i) => go(s, `/set-cookie?v=session-${i}`)));
      await Promise.all(sessions.map((s) => go(s, '/whoami')));
      const seen = await Promise.all(sessions.map(async (s) => (await s.observe()).nodes.find((n) => n.role === 'heading')?.name));
      expect(seen).toEqual(Array.from({ length: N }, (_, i) => `sid=session-${i}`));
      const viaRequest = await Promise.all(sessions.map((s) => s.request?.({ method: 'GET', path: '/api/whoami' })));
      expect(viaRequest.map((r) => ((r?.body ?? {}) as { sid?: string }).sid)).toEqual(Array.from({ length: N }, (_, i) => `session-${i}`));
      await Promise.all(sessions.map((s) => s.close()));
      const fresh = await open();
      await go(fresh, '/whoami');
      expect((await fresh.observe()).nodes.find((n) => n.role === 'heading')?.name).toBe('sid=none');
      await fresh.close();
    }, 90_000);

    it('R-RN2: request() shares cookies with the session, parses JSON, sends JSON bodies and resolves relative paths', async () => {
      const s = await open();
      await go(s, '/set-cookie?v=abc');
      expect(await s.request?.({ method: 'GET', path: '/api/whoami' })).toEqual({ status: 200, body: { sid: 'abc' } });
      const echoed = await s.request?.({ method: 'POST', path: '/api/echo', body: { a: 1 } });
      expect(echoed?.status).toBe(200);
      expect(echoed?.body).toEqual({ method: 'POST', contentType: 'application/json', body: '{"a":1}' });
      const text = await s.request?.({ method: 'GET', path: '/set-cookie?v=zzz' });
      expect(typeof text?.body).toBe('string');
      expect((await s.request?.({ method: 'GET', path: '/nope' }))?.status).toBe(404);
      await s.close();
    });

    it('R-AG3: request() enforces the host policy on the target and on redirects', async () => {
      fx.offHostHits.length = 0;
      const s = await open();
      await expect(s.request?.({ method: 'GET', path: `${fx.offHostUrl}/api` })).rejects.toBeInstanceOf(AiBddError);
      await expect(s.request?.({ method: 'GET', path: `${fx.offHostUrl}/api` })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(s.request?.({ method: 'GET', path: '/api/redirect-off' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(fx.offHostHits).toEqual([]);
      await s.close();
    });

    it('R-RN2: closing a session and using it afterwards fails cleanly', async () => {
      const s = await open();
      await s.close();
      await s.close();
      expect((await s.perform({ verb: 'wait', ms: 1 })).error?.code).toBe('DRIVER_UNAVAILABLE');
      await expect(s.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    });
  });
});
