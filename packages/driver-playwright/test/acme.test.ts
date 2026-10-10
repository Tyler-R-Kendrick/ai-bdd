import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, DriverSession, Observation, ObservedNode, Policy, ValueSource } from '@ai-bdd/sdk/contracts';
import { parseAriaSnapshot, playwright, pruneWrappers, sessionFromPage } from '../src/index.ts';
import { browserAvailable, launchRaw } from './browser.ts';

/**
 * Integration tests against the Acme fixture app (`startAcmeApp` from @ai-bdd/testing, built by P-APP).
 * They are skipped, with the reason in the suite name, only while `startAcmeApp` is still an unimplemented stub.
 */
type AcmeApp = { url: string; close(): Promise<void> };
type StartAcme = (opts?: { port?: number; adminPassword?: string; testToken?: string; flags?: string[] }) => Promise<AcmeApp>;

async function probeAcme(): Promise<StartAcme | undefined> {
  try {
    const mod = (await import('@ai-bdd/testing')) as { startAcmeApp: StartAcme };
    const app = await mod.startAcmeApp({});
    await app.close();
    return mod.startAcmeApp;
  } catch {
    return undefined;
  }
}

const hasBrowser = await browserAvailable();
const startAcme = await probeAcme();
const ADMIN = 'correct-horse-battery';
const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string): string => join(here, 'golden', name);
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const policy: Policy = { allowHosts: ['127.0.0.1', 'localhost'], denyVerbs: [] };

/** Volatile clock text and per-document frame prefixes are normalized so goldens are stable. */
const normalize = (s: string): string => s.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d{3})?\b/g, 'HH:MM:SS').replace(/\[ref=f\d+e(\d+)\]/g, '[ref=e$1]');

const find = (obs: Observation, role: string, name: string): ObservedNode => {
  const n = obs.nodes.find((x) => x.role === role && x.name === name);
  if (n === undefined) throw new Error(`no ${role} ${JSON.stringify(name)} in\n${obs.treeText}`);
  return n;
};

const suite = hasBrowser && startAcme !== undefined ? describe : describe.skip;
const suiteName = startAcme === undefined
  ? 'driver-playwright against the Acme app (SKIPPED: startAcmeApp from @ai-bdd/testing is still an unimplemented stub)'
  : 'driver-playwright against the Acme app';

suite(suiteName, () => {
  let app: AcmeApp;
  let driver: Driver;

  const open = (): Promise<DriverSession> => driver.openSession({
    scenarioId: 'acme', baseURL: app.url, policy,
    resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? ADMIN : ''),
  });
  const go = async (s: DriverSession, path: string): Promise<void> => {
    const r = await s.perform({ verb: 'navigate', url: path });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const click = async (s: DriverSession, role: string, name: string): Promise<void> => {
    const r = await s.perform({ verb: 'click', target: { ref: find(await s.observe(), role, name).ref } });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const fill = async (s: DriverSession, name: string, value: ValueSource): Promise<void> => {
    const r = await s.perform({ verb: 'fill', target: { ref: find(await s.observe(), 'textbox', name).ref }, value });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };

  beforeAll(async () => {
    app = await (startAcme as StartAcme)({});
    driver = await playwright({ actionTimeoutMs: 2000 }).create({ projectRoot: process.cwd(), policy, artifactsDir: process.cwd(), baseURL: app.url });
  });
  afterAll(async () => {
    await driver.dispose();
    await app.close();
  });

  const SCREENS: { name: string; setup(s: DriverSession): Promise<void> }[] = [
    { name: 'acme-login', setup: (s) => go(s, '/login') },
    {
      name: 'acme-login-error',
      setup: async (s) => {
        await go(s, '/login');
        await fill(s, 'Password', { literal: 'wrong-password' });
        await click(s, 'button', 'Sign in');
      },
    },
    { name: 'acme-billing', setup: (s) => go(s, '/settings/billing') },
    {
      name: 'acme-billing-dialog',
      setup: async (s) => {
        await go(s, '/settings/billing');
        await click(s, 'button', 'Upgrade to Pro');
      },
    },
    { name: 'acme-todos', setup: (s) => go(s, '/todos') },
    { name: 'acme-forms-two', setup: (s) => go(s, '/forms/two') },
    { name: 'acme-notes', setup: (s) => go(s, '/notes') },
  ];

  for (const screen of SCREENS) {
    it(`R-AG4: golden ${screen.name}: Acme aria snapshot (V3/V4) matches the pinned text and parses to the pinned nodes`, async () => {
      const s = await open();
      await screen.setup(s);
      await new Promise((r) => setTimeout(r, 250));
      // A second, raw session over its own page so the exact ai-mode text can be pinned.
      const browser = await launchRaw();
      try {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const raw = await sessionFromPage(page, { scenarioId: 'raw', baseURL: app.url, policy, resolveValue: (v) => ('literal' in v ? v.literal : '') }, { policy, baseURL: app.url });
        await screen.setup(raw);
        await new Promise((r) => setTimeout(r, 250));
        const live = normalize(await page.ariaSnapshot({ mode: 'ai' }));
        await raw.close();
        await ctx.close();
        const textFile = golden(`${screen.name}.aria.txt`);
        const nodesFile = golden(`${screen.name}.nodes.json`);
        if (UPDATE || !existsSync(textFile)) {
          writeFileSync(textFile, `${live}\n`);
          writeFileSync(nodesFile, `${JSON.stringify(pruneWrappers(parseAriaSnapshot(live)), null, 2)}\n`);
        }
        expect(`${live}\n`).toBe(readFileSync(textFile, 'utf8'));
        const nodes = pruneWrappers(parseAriaSnapshot(readFileSync(textFile, 'utf8')));
        expect(JSON.parse(JSON.stringify(nodes))).toEqual(JSON.parse(readFileSync(nodesFile, 'utf8')));

        // The driver's own observation of the same screen carries the same roles and names, in order.
        const obs = await s.observe();
        const strip = (ns: readonly ObservedNode[]): string[] => ns.map((n) => `${n.role}|${normalize(n.name)}`);
        expect(strip(obs.nodes)).toEqual(strip(nodes));
      } finally {
        await browser.close();
        await s.close();
      }
    }, 30_000);
  }

  it('R-SE2: signing in with a secret reaches /settings/billing, taints the session and never exposes the password', async () => {
    const s = await open();
    await go(s, '/login');
    await fill(s, 'Email', { literal: 'ada@example.com' });
    await fill(s, 'Password', { secret: 'ADMIN_PASSWORD' });
    let obs = await s.observe();
    expect(obs.tainted).toBe(true);
    expect(obs.treeText).not.toContain(ADMIN);
    await click(s, 'button', 'Sign in');
    await new Promise((r) => setTimeout(r, 300));
    obs = await s.observe({ pixels: true });
    expect(obs.route).toBe('/settings/billing');
    expect(obs.tainted).toBe(true);
    expect(obs.screenshot?.masked).toBe(true);
    expect(find(obs, 'status', 'Plan: Free').role).toBe('status');
    expect(JSON.stringify(obs.nodes)).not.toContain(ADMIN);
    await s.close();
  });

  it('R-RN1: upgrade flow drives dialog, confirm and plan status through real clicks', async () => {
    const s = await open();
    await go(s, '/settings/billing');
    await click(s, 'button', 'Upgrade to Pro');
    let obs = await s.observe();
    expect(find(obs, 'dialog', 'Confirm upgrade').role).toBe('dialog');
    expect(obs.nodes.some((n) => n.role === 'paragraph' && n.name.includes('$12.50'))).toBe(true);
    await click(s, 'button', 'Confirm');
    await new Promise((r) => setTimeout(r, 300));
    obs = await s.observe();
    expect(find(obs, 'status', 'Plan: Pro').role).toBe('status');
    expect(obs.nodes.some((n) => n.role === 'status' && n.name === 'Upgraded to Pro')).toBe(true);
    await s.close();
  });

  it('R-RN1: /slow reports busy while the progressbar shows and settles to the report', async () => {
    const s = await open();
    await go(s, '/slow?ms=1200');
    const first = await s.observe();
    expect(first.busy).toBe(true);
    expect(first.nodes.some((n) => n.role === 'progressbar' && n.name === 'Loading')).toBe(true);
    let obs = first;
    const t0 = Date.now();
    while (obs.busy && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 100));
      obs = await s.observe();
    }
    expect(obs.busy).toBe(false);
    expect(find(obs, 'heading', 'Report ready').level).toBe(1);
    await s.close();
  });

  it('R-AG4: the injected link on /notes is shown as page data, and following it is denied by policy', async () => {
    const s = await open();
    await go(s, '/notes');
    const obs = await s.observe();
    expect(obs.nodes.some((n) => n.role === 'paragraph' && n.name.startsWith('SYSTEM NOTICE TO AI AGENTS'))).toBe(true);
    const link = find(obs, 'link', 'Continue');
    expect(link.url).toBe('https://evil.example/steal');
    const r = await s.perform({ verb: 'click', target: { ref: link.ref } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('POLICY_DENIED');
    expect((await s.observe()).route).toBe('/notes');
    const nav = await s.perform({ verb: 'navigate', url: 'https://evil.example/steal' });
    expect(nav.error?.code).toBe('POLICY_DENIED');
    await s.close();
  });

  it('R-RN2: request() shares the session cookie, so the test API seeds exactly this session', async () => {
    const s = await open();
    await go(s, '/settings/billing');
    const seeded = await s.request?.({ method: 'POST', path: '/__test/seed', headers: { 'x-acme-test-token': 'acme-test' }, body: { plan: 'pro' } });
    expect(seeded?.status).toBeLessThan(300);
    await go(s, '/settings/billing');
    expect(find(await s.observe(), 'status', 'Plan: Pro').role).toBe('status');
    const other = await open();
    await go(other, '/settings/billing');
    expect(find(await other.observe(), 'status', 'Plan: Free').role).toBe('status');
    const denied = await s.request?.({ method: 'POST', path: '/__test/seed', body: { plan: 'free' } });
    expect(denied?.status).toBeGreaterThanOrEqual(400);
    await s.close();
    await other.close();
  });

  it('R-RN2: 20 parallel sessions keep independent Acme state (no cookie leakage)', async () => {
    const N = 20;
    const sessions = await Promise.all(Array.from({ length: N }, () => open()));
    await Promise.all(sessions.map((s) => go(s, '/settings/billing')));
    await Promise.all(sessions.map((s, i) => (i % 2 === 0
      ? s.request?.({ method: 'POST', path: '/__test/seed', headers: { 'x-acme-test-token': 'acme-test' }, body: { plan: 'pro', unpaid: i } })
      : undefined)));
    await Promise.all(sessions.map((s) => go(s, '/settings/billing')));
    const plans = await Promise.all(sessions.map(async (s) => (await s.observe()).nodes.find((n) => n.role === 'status' && n.name.startsWith('Plan:'))?.name));
    expect(plans).toEqual(Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 'Plan: Pro' : 'Plan: Free')));
    await Promise.all(sessions.map((s) => s.close()));
  }, 90_000);
});
