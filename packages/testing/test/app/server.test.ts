import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAcmeApp } from '../../src/app/index.ts';
import { Client } from './client.ts';
import { toAxNodes } from './html-parse.ts';

const TOKEN = { 'x-acme-test-token': 'acme-test' };
const names = (html: string): string[] => toAxNodes(html).map((n) => `${n.role}:${n.name}`);

describe('startAcmeApp', () => {
  let app: Awaited<ReturnType<typeof startAcmeApp>>;
  beforeAll(async () => {
    app = await startAcmeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('listens on an ephemeral loopback port and serves HTML with a session cookie', async () => {
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const c = new Client(app.url);
    const res = await c.get('/todos');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('set-cookie')).toMatch(/^acme_sid=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(c.sid).toMatch(/^acme_sid=/);
  });

  it('R-RN2: state is per session cookie and invisible to other sessions', async () => {
    const a = new Client(app.url);
    const b = new Client(app.url);
    await a.get('/settings/billing');
    await b.get('/settings/billing');
    await a.post('/__act', { __route: '/settings/billing', __action: 'billing.upgrade' });
    await a.post('/__act', { __route: '/settings/billing', __action: 'billing.confirm' });
    expect(names((await a.get('/settings/billing')).text)).toContain('status:Plan: Pro');
    expect(names((await b.get('/settings/billing')).text)).toContain('status:Plan: Free');
    expect(a.sid).not.toBe(b.sid);
  });

  it('ignores forged session ids (unknown sid gets a fresh session)', async () => {
    const forged = await fetch(`${app.url}/todos`, { headers: { cookie: 'acme_sid=attacker-chosen' } });
    expect(forged.headers.get('set-cookie')).toMatch(/^acme_sid=(?!attacker-chosen)/);
  });

  it('GET / and GET /login (signed in) redirect; unknown routes are 404 pages with the nav', async () => {
    const c = new Client(app.url);
    const root = await c.get('/', false);
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/settings/billing');
    const nf = await c.get('/does-not-exist');
    expect(nf.status).toBe(404);
    expect(names(nf.text)).toContain('heading:Not found');
    expect(names(nf.text)).toContain('navigation:Primary');
  });

  it('only POST /__act accepts form posts; the redirect target cannot leave the origin', async () => {
    const c = new Client(app.url);
    expect((await c.get('/__act', false)).status).toBe(405);
    const evil = await c.post('/__act', { __route: '//evil.example/x', __action: 'nope' }, false);
    expect(evil.status).toBe(303);
    expect(evil.headers.get('location')).toBe('/settings/billing');
    const evil2 = await c.post('/__act', { __route: 'https://evil.example/x' }, false);
    expect(evil2.headers.get('location')).toBe('/settings/billing');
    const ok = await c.post('/__act', { __route: '/todos?x=1', __action: 'unknown.action' }, false);
    expect(ok.headers.get('location')).toBe('/todos?x=1');
  });

  it('rejects huge bodies without crashing the server', async () => {
    const c = new Client(app.url);
    const res = await c.req('POST', '/__act', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `x=${'a'.repeat(200_000)}` }).catch(() => undefined);
    expect(res === undefined || res.status >= 400).toBe(true);
    expect((await c.get('/todos')).status).toBe(200);
  });

  it('serves the /slow swap script with the correct delay and finished markup', async () => {
    const c = new Client(app.url);
    const res = await c.get('/slow?ms=1234');
    expect(res.text).toContain('aria-busy="true"');
    expect(res.text).toMatch(/setTimeout\(function\(\)\{[^}]*\},\d+\)/);
    expect(res.text).toContain('Report ready');
    const quick = await c.get('/slow?ms=0');
    expect(names(quick.text)).toContain('heading:Report ready');
    expect(quick.text).not.toContain('<script>');
  });

  it('sets a restrictive content-security-policy', async () => {
    const res = await new Client(app.url).get('/login');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  describe('test API (token enforced)', () => {
    it('rejects missing and wrong tokens on every /__test route with 401', async () => {
      const c = new Client(app.url);
      for (const path of ['/__test/reset', '/__test/seed', '/__test/anything']) {
        expect((await c.json(path, {})).status, path).toBe(401);
        expect((await c.json(path, {}, { 'x-acme-test-token': 'wrong' })).status, path).toBe(401);
        expect((await c.json(path, {}, { 'x-acme-test-token': '' })).status, path).toBe(401);
      }
    });

    it('seed configures the cookie session (plan, unpaid, signedIn) and reset undoes it', async () => {
      const c = new Client(app.url);
      await c.get('/settings/billing');
      const seeded = await c.json('/__test/seed', { plan: 'pro', unpaid: 2, signedIn: true }, TOKEN);
      expect(seeded.status).toBe(200);
      expect(JSON.parse(seeded.text)).toEqual({ ok: true, plan: 'pro', unpaid: 2, flags: [], signedIn: true });
      const down = await c.post('/__act', { __route: '/settings/billing', __action: 'billing.downgrade' });
      expect(names(down.text)).toContain('alert:You have 2 unpaid invoices. Settle them before downgrading.');
      expect((await c.get('/login', false)).status).toBe(302);
      expect((await c.json('/__test/reset', {}, TOKEN)).status).toBe(200);
      const after = names((await c.get('/settings/billing')).text);
      expect(after).toContain('status:Plan: Free');
      expect((await c.get('/login', false)).status).toBe(200);
    });

    it('a seed in one session does not touch another session', async () => {
      const a = new Client(app.url);
      const b = new Client(app.url);
      await a.json('/__test/seed', { plan: 'pro' }, TOKEN);
      expect(names((await a.get('/settings/billing')).text)).toContain('status:Plan: Pro');
      expect(names((await b.get('/settings/billing')).text)).toContain('status:Plan: Free');
    });

    it('validates input and methods', async () => {
      const c = new Client(app.url);
      expect((await c.json('/__test/seed', { plan: 'gold' }, TOKEN)).status).toBe(400);
      expect((await c.json('/__test/seed', { flags: ['bogus'] }, TOKEN)).status).toBe(400);
      expect((await c.req('POST', '/__test/seed', { headers: { ...TOKEN, 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
      expect((await c.req('GET', '/__test/seed', { headers: TOKEN })).status).toBe(405);
      expect((await c.json('/__test/unknown', {}, TOKEN)).status).toBe(404);
      expect((await c.req('POST', '/__test/seed', { headers: TOKEN })).status).toBe(200); // empty body = no-op seed
    });

    it('a custom test token and admin password are honoured', async () => {
      const custom = await startAcmeApp({ testToken: 'tok-123', adminPassword: 'my-admin-pass' });
      try {
        const c = new Client(custom.url);
        expect((await c.json('/__test/reset', {}, TOKEN)).status).toBe(401);
        expect((await c.json('/__test/reset', {}, { 'x-acme-test-token': 'tok-123' })).status).toBe(200);
        await c.post('/__act', { __route: '/login', __action: 'login.submit', password: 'correct-horse-battery' });
        expect(names((await c.get('/login')).text)).toContain('alert:Invalid email or password');
        const ok = await c.post('/__act', { __route: '/login', __action: 'login.submit', password: 'my-admin-pass' });
        expect(new URL(ok.url).pathname).toBe('/settings/billing');
      } finally {
        await custom.close();
      }
    });
  });

  describe('flags (startAcmeApp({flags}))', () => {
    it('v2 renames the upgrade button', async () => {
      const v2 = await startAcmeApp({ flags: ['v2'] });
      try {
        const c = new Client(v2.url);
        const n = names((await c.get('/settings/billing')).text);
        expect(n).toContain('button:Go Pro');
        expect(n).not.toContain('button:Upgrade to Pro');
      } finally {
        await v2.close();
      }
    });

    it('bug-upgrade-noop makes Confirm a no-op, and reset keeps the startup flags', async () => {
      const buggy = await startAcmeApp({ flags: ['bug-upgrade-noop'] });
      try {
        const c = new Client(buggy.url);
        await c.get('/settings/billing');
        await c.post('/__act', { __route: '/settings/billing', __action: 'billing.upgrade' });
        const res = await c.post('/__act', { __route: '/settings/billing', __action: 'billing.confirm' });
        const n = names(res.text);
        expect(n).toContain('status:Plan: Free');
        expect(n).not.toContain('status:Upgraded to Pro');
        expect(n.some((x) => x.startsWith('dialog:'))).toBe(false);
        await c.json('/__test/reset', {}, TOKEN);
        await c.post('/__act', { __route: '/settings/billing', __action: 'billing.upgrade' });
        const again = await c.post('/__act', { __route: '/settings/billing', __action: 'billing.confirm' });
        expect(names(again.text)).toContain('status:Plan: Free');
      } finally {
        await buggy.close();
      }
    });

    it('seed can switch flags for one session', async () => {
      const c = new Client(app.url);
      await c.json('/__test/seed', { flags: ['v2'] }, TOKEN);
      expect(names((await c.get('/settings/billing')).text)).toContain('button:Go Pro');
      const other = new Client(app.url);
      expect(names((await other.get('/settings/billing')).text)).toContain('button:Upgrade to Pro');
    });

    it('unknown startup flags fail fast', async () => {
      await expect(startAcmeApp({ flags: ['nope'] })).rejects.toThrow(/unknown Acme flag/);
    });
  });

  it('/__redirect bounces to the requested URL (driver policy fixture)', async () => {
    const c = new Client(app.url);
    const res = await c.get('/__redirect?to=https://evil.example/x', false);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://evil.example/x');
  });

  it('close() stops the server', async () => {
    const tmp = await startAcmeApp();
    await tmp.close();
    await expect(fetch(`${tmp.url}/todos`)).rejects.toThrow();
  });
});
