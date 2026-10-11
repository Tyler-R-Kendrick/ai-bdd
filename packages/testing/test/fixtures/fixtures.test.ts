import type { DriverSession, FixtureContext, JsonValue, Observation } from '@ai-bdd/sdk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../app/client.ts';
import { startAcmeApp } from '../../src/app/index.ts';
import { acmeFixtures } from '../../src/fixtures/index.ts';
import { click, goto, has, openSession } from '../fake-driver/helpers.ts';

const seedAccount = acmeFixtures.find((f) => f.name === 'seedAccount');
const resetAccount = acmeFixtures.find((f) => f.name === 'resetAccount');
const ctxFor = (session: DriverSession, logs: string[] = []): FixtureContext => ({
  session,
  baseURL: 'http://localhost:4173',
  signal: new AbortController().signal,
  log: (m) => logs.push(m),
});

describe('acmeFixtures (SPEC 13.2, R-FX1)', () => {
  it('R-FX1: exports seedAccount and resetAccount with the normative descriptor', () => {
    expect(acmeFixtures.map((f) => f.name)).toEqual(['seedAccount', 'resetAccount']);
    expect(seedAccount?.description).toBe('Create the Acme account on a given plan with a number of unpaid invoices');
    expect(seedAccount?.params).toEqual({
      plan: { type: 'string', enum: ['free', 'pro'], description: expect.any(String) },
      unpaid: { type: 'number', derived: true, description: expect.any(String) },
    });
    expect(resetAccount?.params).toEqual({});
    // descriptors must survive JSON round trips (they are shown to the extraction model)
    expect(JSON.parse(JSON.stringify(seedAccount?.params))).toEqual(seedAccount?.params);
  });

  it('R-FX1: seedAccount({plan:"pro", unpaid:2}) makes the downgrade alert appear (M14)', async () => {
    const s = await openSession();
    await seedAccount?.run({ plan: 'pro', unpaid: 2 }, ctxFor(s));
    await goto(s, '/settings/billing');
    const obs = await click(s, 'button', 'Downgrade to Free');
    expect(has(obs, 'alert', 'You have 2 unpaid invoices. Settle them before downgrading.')).toBe(true);
    expect(has(obs, 'status', 'Plan: Pro')).toBe(true);
    await s.close();
  });

  it('refreshes a page that was already open before seeding (real browsers would show stale data)', async () => {
    const s = await openSession();
    const stale = await goto(s, '/settings/billing');
    expect(has(stale, 'status', 'Plan: Free')).toBe(true);
    await seedAccount?.run({ plan: 'pro' }, ctxFor(s));
    expect(has(await s.observe(), 'status', 'Plan: Pro')).toBe(true);
    await s.close();
  });

  it('is idempotent and resets first: running twice, or with fewer params, leaves no residue', async () => {
    const s = await openSession();
    await seedAccount?.run({ plan: 'pro', unpaid: 3 }, ctxFor(s));
    await seedAccount?.run({ plan: 'pro', unpaid: 3 }, ctxFor(s));
    await goto(s, '/settings/billing');
    expect(has(await click(s, 'button', 'Downgrade to Free'), 'alert', 'You have 3 unpaid invoices. Settle them before downgrading.')).toBe(true);
    await seedAccount?.run({ plan: 'pro' }, ctxFor(s)); // unpaid goes back to 0
    await goto(s, '/settings/billing');
    expect(has(await click(s, 'button', 'Downgrade to Free'), 'status', 'Downgraded to Free')).toBe(true);
    await seedAccount?.run({}, ctxFor(s)); // free, nothing unpaid
    expect(has(await goto(s, '/settings/billing'), 'status', 'Plan: Free')).toBe(true);
    await s.close();
  });

  it('keeps the driver flags (reset restores them, seedAccount never touches them)', async () => {
    const s = await openSession({ flags: ['v2'] });
    await seedAccount?.run({ plan: 'free' }, ctxFor(s));
    expect(has(await goto(s, '/settings/billing'), 'button', 'Go Pro')).toBe(true);
    await s.close();
  });

  it('resetAccount clears plan, todos and unpaid invoices', async () => {
    const s = await openSession();
    await seedAccount?.run({ plan: 'pro', unpaid: 1 }, ctxFor(s));
    await resetAccount?.run({}, ctxFor(s));
    await resetAccount?.run({}, ctxFor(s)); // idempotent
    expect(has(await goto(s, '/settings/billing'), 'status', 'Plan: Free')).toBe(true);
    await s.close();
  });

  it('fails with FIXTURE_FAILED on bad arguments, missing request capability, and bad tokens', async () => {
    const s = await openSession();
    await expect(seedAccount?.run({ plan: 'gold' }, ctxFor(s))).rejects.toMatchObject({ code: 'FIXTURE_FAILED' });
    await expect(seedAccount?.run({ unpaid: -1 }, ctxFor(s))).rejects.toMatchObject({ code: 'FIXTURE_FAILED' });
    await expect(seedAccount?.run({ unpaid: 'two' }, ctxFor(s))).rejects.toMatchObject({ code: 'FIXTURE_FAILED' });
    const noRequest: DriverSession = { ...s, id: 'x', driverId: 'bare', driverVersion: '1', capabilities: s.capabilities, observe: () => s.observe(), perform: (a) => s.perform(a), close: () => s.close() };
    await expect(seedAccount?.run({ plan: 'pro' }, ctxFor(noRequest))).rejects.toMatchObject({ code: 'FIXTURE_FAILED' });
    const prev = process.env['ACME_TEST_TOKEN'];
    process.env['ACME_TEST_TOKEN'] = 'wrong-token';
    try {
      await expect(resetAccount?.run({}, ctxFor(s))).rejects.toMatchObject({ code: 'FIXTURE_FAILED', message: expect.stringContaining('401') });
    } finally {
      if (prev === undefined) delete process.env['ACME_TEST_TOKEN'];
      else process.env['ACME_TEST_TOKEN'] = prev;
    }
    await s.close();
  });
});

describe('acmeFixtures against the real HTTP server (cookies shared with the session)', () => {
  let app: Awaited<ReturnType<typeof startAcmeApp>>;
  beforeAll(async () => {
    app = await startAcmeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  /** A tiny HTTP-backed session: request() shares the cookie jar with page loads, like Playwright's context.request. */
  function httpSession(client: Client, base: string): { session: DriverSession; navigations: string[] } {
    const navigations: string[] = [];
    const session: DriverSession = {
      id: 'http',
      driverId: 'http-double',
      driverVersion: '1.0.0',
      capabilities: { verbs: ['navigate'], pixels: false, maskingProven: false, request: true, maxSessions: 1 },
      async observe(): Promise<Observation> {
        return { revision: 1, route: '/settings/billing', url: `${base}/settings/billing`, nodes: [], busy: false, tainted: false, treeText: '', treeHash: '0' };
      },
      async perform(action) {
        if (action.verb === 'navigate') navigations.push(action.url);
        return { ok: true };
      },
      async request(req) {
        const res = await client.req(req.method, req.path, { headers: { 'content-type': 'application/json', ...(req.headers ?? {}) }, ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }) });
        let body: JsonValue | string = res.text;
        try {
          body = JSON.parse(res.text) as JsonValue;
        } catch {
          // keep text
        }
        return { status: res.status, body };
      },
      async close() {},
    };
    return { session, navigations };
  }

  it('seeds the browser session via the test API and asks the page to reload', async () => {
    const client = new Client(app.url);
    await client.get('/settings/billing'); // the browser's session cookie
    const { session, navigations } = httpSession(client, app.url);
    await seedAccount?.run({ plan: 'pro', unpaid: 2 }, ctxFor(session));
    expect(navigations).toEqual([`${app.url}/settings/billing`]);
    const page = (await client.get('/settings/billing')).text;
    expect(page).toContain('Plan: Pro');
    const down = await client.post('/__act', { __route: '/settings/billing', __action: 'billing.downgrade' });
    expect(down.text).toContain('You have 2 unpaid invoices. Settle them before downgrading.');
    await resetAccount?.run({}, ctxFor(session));
    expect((await client.get('/settings/billing')).text).toContain('Plan: Free');
  });
});
