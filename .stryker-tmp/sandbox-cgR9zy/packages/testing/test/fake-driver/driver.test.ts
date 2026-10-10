// @ts-nocheck
import { createSettler } from '@ai-bdd/sdk';
import type { Clock } from '@ai-bdd/sdk/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeDriver, FAKE_EPOCH_MS } from '../../src/fake-driver/index.ts';
import { BASE, POLICY, click, fill, find, goto, has, openDriver, openSession, sessionOptions } from './helpers.ts';

const toClose: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(toClose.splice(0).map((c) => c.close()));
});
const track = async <T extends { close(): Promise<void> }>(p: Promise<T>): Promise<T> => {
  const v = await p;
  toClose.push(v);
  return v;
};

const virtualClock = (): Clock & { t: number } => {
  const c = {
    t: 0,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
};

describe('fakeDriver identity and capabilities (SPEC 13.2)', () => {
  it('has id fake, version 1.0.0 and the advertised capabilities', async () => {
    const factory = fakeDriver({ maxSessions: 3, exclusiveResource: 'acct' });
    expect(factory.id).toBe('fake');
    const driver = await factory.create({ projectRoot: '/tmp', policy: POLICY, artifactsDir: '/tmp' });
    expect(driver.id).toBe('fake');
    expect(driver.version).toBe('1.0.0');
    expect(driver.capabilities).toEqual({
      verbs: ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'],
      pixels: true,
      maskingProven: true,
      request: true,
      maxSessions: 3,
      exclusiveResource: 'acct',
    });
    expect(await driver.selfCheck()).toEqual({ ok: true, problems: [] });
    const s = await driver.openSession(sessionOptions());
    expect(s.driverId).toBe('fake');
    expect(s.driverVersion).toBe('1.0.0');
    expect(s.capabilities).toEqual(driver.capabilities);
    await driver.dispose();
  });

  it('omits exclusiveResource when none is given and rejects unknown flags eagerly', async () => {
    const d = await openDriver();
    expect('exclusiveResource' in d.capabilities).toBe(false);
    expect(d.capabilities.maxSessions).toBe(8);
    expect(() => fakeDriver({ flags: ['nope'] })).toThrow(/unknown Acme flag/);
  });
});

describe('observe', () => {
  it('produces refs r<revision>:e<n>, parent links, depth, levels, urls and rendered tree text', async () => {
    const s = await track(openSession());
    const blank = await s.observe();
    expect(blank.route).toBe('about:blank');
    expect(blank.nodes).toEqual([]);
    const obs = await goto(s, '/settings/billing');
    expect(obs.revision).toBe(2);
    expect(obs.route).toBe('/settings/billing');
    expect(obs.url).toBe(`${BASE}/settings/billing`);
    expect(obs.busy).toBe(false);
    expect(obs.tainted).toBe(false);
    expect(obs.nodes.every((n, i) => n.ref === `r2:e${i + 1}`)).toBe(true);
    const heading = find(obs, 'heading', 'Billing');
    expect(heading).toMatchObject({ level: 1, depth: 1 });
    expect(find(obs, 'main', '').depth).toBe(0);
    expect(heading.parentRef).toBe(find(obs, 'main', '').ref);
    const link = find(obs, 'link', 'Todos');
    expect(link).toMatchObject({ url: '/todos', depth: 1, parentRef: find(obs, 'navigation', 'Primary').ref });
    expect(obs.treeText).toContain('- heading "Billing" [level=1] [ref=r2:e');
    expect(obs.screenshot).toBeUndefined();
  });

  it('R-RN1: treeHash is stable across observations of an unchanged screen and changes with content', async () => {
    const s = await track(openSession());
    await goto(s, '/settings/billing');
    const a = await s.observe();
    const b = await s.observe();
    expect(a.treeHash).toBe(b.treeHash);
    expect(a.revision).not.toBe(b.revision);
    const c = await click(s, 'button', 'Upgrade to Pro');
    expect(c.treeHash).not.toBe(a.treeHash);
  });

  it('exposes the root heading levels, states and no node-level busy flag', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/slow?ms=1000');
    expect(obs.busy).toBe(true);
    expect(obs.nodes.every((n) => n.states.busy === undefined)).toBe(true);
  });
});

describe('perform: refs', () => {
  it('rejects refs from older revisions with STALE_REF and unknown refs with TARGET_NOT_FOUND', async () => {
    const s = await track(openSession());
    const first = await goto(s, '/settings/billing');
    const old = find(first, 'button', 'Upgrade to Pro').ref;
    await s.observe();
    const stale = await s.perform({ verb: 'click', target: { ref: old } });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('STALE_REF');
    const unknown = await s.perform({ verb: 'click', target: { ref: 'bogus' } });
    expect(unknown.error?.code).toBe('TARGET_NOT_FOUND');
    const beyond = await s.perform({ verb: 'click', target: { ref: 'r2:e999' } });
    expect(beyond.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('allows several actions from one observation (fill then click) while the targets still exist', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/todos');
    const box = find(obs, 'textbox', 'New todo').ref;
    const add = find(obs, 'button', 'Add').ref;
    expect((await s.perform({ verb: 'fill', target: { ref: box }, value: { literal: 'Buy milk' } })).ok).toBe(true);
    expect((await s.perform({ verb: 'click', target: { ref: add } })).ok).toBe(true);
    const after = await s.observe();
    expect(after.nodes.some((n) => n.role === 'listitem' && n.name.startsWith('Buy milk \u2014 added '))).toBe(true);
    // the textbox was cleared by the submit and its old ref still resolves
    expect((await s.perform({ verb: 'click', target: { ref: after.nodes.find((n) => n.role === 'textbox')?.ref ?? '' } })).ok).toBe(true);
  });

  it('reports TARGET_NOT_FOUND when the element disappeared since the observation', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/settings/billing');
    const upgrade = find(obs, 'button', 'Upgrade to Pro').ref;
    // same revision, but the page changed underneath (a second session handle is not needed: navigate away)
    await s.perform({ verb: 'navigate', url: '/todos' });
    const out = await s.perform({ verb: 'click', target: { ref: upgrade } });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('TARGET_NOT_FOUND');
  });
});

describe('billing flows (M5, M9, M10, M11 building blocks)', () => {
  it('upgrade: dialog, confirm, plan Pro, invoice preview and toast', async () => {
    const s = await track(openSession());
    await goto(s, '/settings/billing');
    const dialog = await click(s, 'button', 'Upgrade to Pro');
    expect(has(dialog, 'dialog', 'Confirm upgrade')).toBe(true);
    expect(has(dialog, 'paragraph', 'You will be charged a prorated amount of $12.50 today.')).toBe(true);
    const done = await click(s, 'button', 'Confirm');
    expect(has(done, 'status', 'Plan: Pro')).toBe(true);
    expect(has(done, 'status', 'Upgraded to Pro')).toBe(true);
    expect(has(done, 'paragraph', 'Next invoice: $12.50 (prorated)')).toBe(true);
    expect(has(done, 'dialog', 'Confirm upgrade')).toBe(false);
  });

  it('flag v2 renames the button (replay target-missing)', async () => {
    const s = await track(openSession({ flags: ['v2'] }));
    const obs = await goto(s, '/settings/billing');
    expect(has(obs, 'button', 'Go Pro')).toBe(true);
    expect(has(obs, 'button', 'Upgrade to Pro')).toBe(false);
  });

  it('flag bug-upgrade-noop closes the dialog without upgrading', async () => {
    const s = await track(openSession({ flags: ['bug-upgrade-noop'] }));
    await goto(s, '/settings/billing');
    await click(s, 'button', 'Upgrade to Pro');
    const done = await click(s, 'button', 'Confirm');
    expect(has(done, 'dialog', 'Confirm upgrade')).toBe(false);
    expect(has(done, 'status', 'Plan: Free')).toBe(true);
    expect(has(done, 'status', 'Upgraded to Pro')).toBe(false);
  });

  it('flags are per driver: a second driver without flags is unaffected', async () => {
    const flagged = await track(openSession({ flags: ['v2'] }));
    const plain = await track(openSession());
    expect(has(await goto(flagged, '/settings/billing'), 'button', 'Go Pro')).toBe(true);
    expect(has(await goto(plain, '/settings/billing'), 'button', 'Upgrade to Pro')).toBe(true);
  });

  it('downgrade is blocked with unpaid invoices (R-FX1 data precondition), allowed otherwise', async () => {
    const s = await track(openSession());
    const token = { 'x-acme-test-token': 'acme-test' };
    await s.request?.({ method: 'POST', path: '/__test/seed', headers: token, body: { plan: 'pro', unpaid: 2 } });
    await goto(s, '/settings/billing');
    const blocked = await click(s, 'button', 'Downgrade to Free');
    expect(has(blocked, 'alert', 'You have 2 unpaid invoices. Settle them before downgrading.')).toBe(true);
    expect(has(blocked, 'status', 'Plan: Pro')).toBe(true);
    await s.request?.({ method: 'POST', path: '/__test/seed', headers: token, body: { unpaid: 0 } });
    await goto(s, '/settings/billing');
    const ok = await click(s, 'button', 'Downgrade to Free');
    expect(has(ok, 'status', 'Plan: Free')).toBe(true);
    expect(has(ok, 'status', 'Downgraded to Free')).toBe(true);
  });
});

describe('forms, todos, login', () => {
  it('R-AG2: /forms/two has ambiguous Submit and Street nodes distinguished by region', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/forms/two');
    const submits = obs.nodes.filter((n) => n.role === 'button' && n.name === 'Submit');
    expect(submits).toHaveLength(2);
    const parentNames = submits.map((n) => obs.nodes.find((p) => p.ref === n.parentRef)?.name);
    expect(parentNames).toEqual(['Shipping', 'Billing address']);
    await fill(s, 'Street', { literal: '1 Main St' }, 0);
    const done = await click(s, 'button', 'Submit', 0);
    expect(has(done, 'status', 'Shipping saved')).toBe(true);
    expect(find(done, 'textbox', 'Street', 0).value).toBe('1 Main St');
    expect(find(done, 'textbox', 'Street', 1).value).toBeUndefined();
  });

  it('todos: Enter in the textbox submits; items carry an added time; the textbox clears', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/todos');
    await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'New todo').ref }, value: { literal: 'Walk dog' } });
    const mid = await s.observe();
    expect(find(mid, 'textbox', 'New todo').value).toBe('Walk dog');
    const out = await s.perform({ verb: 'press', key: 'Enter', target: { ref: find(mid, 'textbox', 'New todo').ref } });
    expect(out.ok).toBe(true);
    const after = await s.observe();
    expect(after.nodes.find((n) => n.role === 'listitem')?.name).toMatch(/^Walk dog \u2014 added \d\d:\d\d:\d\d$/);
    expect(find(after, 'textbox', 'New todo').value).toBeUndefined();
    expect(has(after, 'paragraph', 'No todos yet')).toBe(false);
  });

  it('R-SE2: a secret fill taints the session, hides the value and logs in with the admin password', async () => {
    const s = await track(openSession());
    await goto(s, '/login');
    await fill(s, 'Email', { literal: 'admin@acme.test' });
    expect((await s.observe()).tainted).toBe(false);
    await fill(s, 'Password', { secret: 'adminPassword' });
    const filled = await s.observe({ pixels: true });
    expect(filled.tainted).toBe(true);
    expect(filled.screenshot?.masked).toBe(true);
    expect(find(filled, 'textbox', 'Password').value).toBeUndefined();
    expect(JSON.stringify(filled.nodes)).not.toContain('correct-horse-battery');
    expect(filled.treeText).not.toContain('correct-horse-battery');
    const signed = await click(s, 'button', 'Sign in');
    expect(signed.route).toBe('/settings/billing');
    expect(signed.tainted).toBe(true);
    expect(has(signed, 'heading', 'Billing')).toBe(true);
  });

  it('a wrong password shows the alert and stays on /login; adminPassword is configurable', async () => {
    const s = await track(openSession({ adminPassword: 'another-password-1' }));
    await goto(s, '/login');
    await fill(s, 'Password', { secret: 'adminPassword' }); // resolves to the default, now wrong
    const failed = await click(s, 'button', 'Sign in');
    expect(failed.route).toBe('/login');
    expect(has(failed, 'alert', 'Invalid email or password')).toBe(true);
    await fill(s, 'Password', { literal: 'another-password-1' });
    expect((await click(s, 'button', 'Sign in')).route).toBe('/settings/billing');
  });

  it('a failing resolveValue (missing secret) is returned as an error outcome, not thrown, and does not taint', async () => {
    const { AiBddError } = await import('@ai-bdd/sdk/contracts');
    const s = await track(
      openSession({}, {
        resolveValue: () => {
          throw new AiBddError('SECRET_MISSING', 'no such secret');
        },
      }),
    );
    const obs = await goto(s, '/login');
    const out = await s.perform({ verb: 'fill', target: { ref: find(obs, 'textbox', 'Password').ref }, value: { secret: 'x' } });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('SECRET_MISSING');
    expect((await s.observe()).tainted).toBe(false);
  });
});

describe('navigation policy (R-AG3)', () => {
  const denied = ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'file:///etc/passwd', 'https://evil.example/steal', 'http://user:pw@localhost/x', 'ftp://localhost/x', 'http://[::2]/x'];
  for (const url of denied) {
    it(`denies navigate to ${url} with POLICY_DENIED and stays put`, async () => {
      const s = await track(openSession());
      await goto(s, '/todos');
      const out = await s.perform({ verb: 'navigate', url });
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe('POLICY_DENIED');
      expect(out.error?.retryable).toBe(false);
      expect((await s.observe()).route).toBe('/todos');
    });
  }

  it('R-AG4/M16: clicking the injected "Continue" link to evil.example is blocked', async () => {
    const s = await track(openSession());
    await goto(s, '/notes');
    const obs = await s.observe();
    const out = await s.perform({ verb: 'click', target: { ref: find(obs, 'link', 'Continue').ref } });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('POLICY_DENIED');
    expect((await s.observe()).route).toBe('/notes');
  });

  it('off-host redirects through /__redirect are blocked after policy re-check of the target', async () => {
    const s = await track(openSession());
    await goto(s, '/todos');
    const out = await s.perform({ verb: 'navigate', url: '/__redirect?to=https://evil.example/x' });
    expect(out.error?.code).toBe('POLICY_DENIED');
    expect((await s.observe()).route).toBe('/todos');
    const ok = await s.perform({ verb: 'navigate', url: '/__redirect?to=/notes' });
    expect(ok.ok).toBe(true);
    expect((await s.observe()).route).toBe('/notes');
  });

  it('allowed external hosts render a blank page with the heading External', async () => {
    const s = await track(openSession({}, { policy: { allowHosts: ['localhost', 'docs.example.org'], denyVerbs: [] } }));
    const out = await s.perform({ verb: 'navigate', url: 'https://docs.example.org/guide?x=1' });
    expect(out.ok).toBe(true);
    expect(out.navigatedTo).toBe('https://docs.example.org/guide?x=1');
    const obs = await s.observe();
    expect(obs.nodes.map((n) => [n.role, n.name, n.level])).toEqual([['heading', 'External', 1]]);
    expect(obs.route).toBe('/guide?x=1');
    expect(obs.url).toBe('https://docs.example.org/guide?x=1');
    const back = await s.perform({ verb: 'back' });
    expect(back.ok).toBe(true);
  });

  it('wildcard allow patterns work and host matching is case-insensitive', async () => {
    const s = await track(openSession({}, { policy: { allowHosts: ['localhost', '*.example.org'], denyVerbs: [] } }));
    expect((await s.perform({ verb: 'navigate', url: 'https://API.Example.ORG/x' })).ok).toBe(true);
    expect((await s.perform({ verb: 'navigate', url: 'https://example.com/x' })).ok).toBe(false);
  });

  it('denyVerbs is enforced by the driver', async () => {
    const s = await track(openSession({}, { policy: { ...POLICY, denyVerbs: ['navigate', 'fill'] } }));
    const out = await s.perform({ verb: 'navigate', url: '/todos' });
    expect(out.error?.code).toBe('POLICY_DENIED');
  });

  it('relative navigation without a baseURL resolves against http://localhost', async () => {
    const d = await openDriver();
    const s = await track(d.openSession({ scenarioId: 'x', policy: POLICY, resolveValue: () => '' }));
    expect((await s.perform({ verb: 'navigate', url: '/todos' })).ok).toBe(true);
    expect((await s.observe()).url).toBe('http://localhost/todos');
  });

  it('navigating to / redirects to billing and follows signed-in redirects from /login', async () => {
    const s = await track(openSession());
    expect((await goto(s, '/')).route).toBe('/settings/billing');
    await s.request?.({ method: 'POST', path: '/__test/seed', headers: { 'x-acme-test-token': 'acme-test' }, body: { signedIn: true } });
    expect((await goto(s, '/login')).route).toBe('/settings/billing');
  });

  it('back returns to the previous page; link clicks navigate in-app', async () => {
    const s = await track(openSession());
    await goto(s, '/todos');
    await click(s, 'link', 'Checkout');
    expect((await s.observe()).route).toBe('/forms/two');
    await s.perform({ verb: 'back' });
    expect((await s.observe()).route).toBe('/todos');
    expect((await s.perform({ verb: 'back' })).ok).toBe(true); // empty history is a no-op
  });
});

describe('other verbs', () => {
  it('select and check are not applicable to Acme elements and fail without throwing; hover/scroll succeed', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/settings/billing');
    const ref = find(obs, 'button', 'Upgrade to Pro').ref;
    expect((await s.perform({ verb: 'select', target: { ref }, option: { literal: 'x' } })).error?.code).toBe('TARGET_NOT_FOUND');
    expect((await s.perform({ verb: 'check', target: { ref }, checked: true })).error?.code).toBe('TARGET_NOT_FOUND');
    expect((await s.perform({ verb: 'hover', target: { ref } })).ok).toBe(true);
    expect((await s.perform({ verb: 'scroll', direction: 'down' })).ok).toBe(true);
    expect((await s.perform({ verb: 'press', key: 'Tab' })).ok).toBe(true);
  });

  it('fill rejects non-text targets', async () => {
    const s = await track(openSession());
    const obs = await goto(s, '/settings/billing');
    const out = await s.perform({ verb: 'fill', target: { ref: find(obs, 'button', 'Upgrade to Pro').ref }, value: { literal: 'x' } });
    expect(out.error?.code).toBe('TARGET_NOT_FOUND');
  });

  it('operations on a closed session fail loudly; close is idempotent', async () => {
    const s = await openSession();
    await s.close();
    await s.close();
    await expect(s.observe()).rejects.toMatchObject({ code: 'DRIVER_ERROR' });
  });
});

describe('fake clock: spinner and sync status', () => {
  it('R-RN1: /slow is busy with a progressbar until clockStepMs*observes reaches ms, then shows Report ready', async () => {
    const s = await track(openSession({ clockStepMs: 100 }));
    await goto(s, '/slow?ms=300'); // observation 1 at t=0 (inside goto)
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i += 1) seen.push((await s.observe()).busy);
    expect(seen).toEqual([true, true, false, false]); // t=100,200 busy; t=300 done
    const done = await s.observe();
    expect(has(done, 'heading', 'Report ready')).toBe(true);
    expect(has(done, 'progressbar', 'Loading')).toBe(false);
  });

  it('the spinner shows a progressbar while busy and the clock step is configurable', async () => {
    const s = await track(openSession({ clockStepMs: 1000 }));
    const first = await goto(s, '/slow?ms=2500');
    expect(first.busy).toBe(true);
    expect(has(first, 'progressbar', 'Loading')).toBe(true);
    expect((await s.observe()).busy).toBe(true); // t=1000
    expect((await s.observe()).busy).toBe(true); // t=2000
    expect((await s.observe()).busy).toBe(false); // t=3000
  });

  it('wait advances the fake clock without observing', async () => {
    const s = await track(openSession());
    await goto(s, '/slow?ms=5000');
    expect((await s.perform({ verb: 'wait', ms: 5000 })).ok).toBe(true);
    expect((await s.observe()).busy).toBe(false);
  });

  it('re-navigating to /slow restarts the spinner', async () => {
    const s = await track(openSession());
    await goto(s, '/slow?ms=200');
    await s.perform({ verb: 'wait', ms: 1000 });
    expect((await s.observe()).busy).toBe(false);
    expect((await goto(s, '/slow?ms=200')).busy).toBe(true);
  });

  it('the /todos sync status starts at the fixed epoch and moves forward with observes', async () => {
    const s = await track(openSession({ clockStepMs: 250 }));
    const a = await goto(s, '/todos');
    expect(find(a, 'status', 'Synced at 09:00:00.000')).toBeDefined();
    expect(FAKE_EPOCH_MS).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
    await s.observe(); // t=250
    await s.observe(); // t=500
    const d = await s.observe(); // t=750
    expect(d.nodes.find((n) => n.name.startsWith('Synced at'))?.name).toBe('Synced at 09:00:00.500');
    await s.perform({ verb: 'wait', ms: 5000 });
    const e = await s.observe();
    expect(e.nodes.find((n) => n.name.startsWith('Synced at'))?.name).toBe('Synced at 09:00:06.000');
  });

  it('todo added times follow the fake clock', async () => {
    const s = await track(openSession());
    await goto(s, '/todos');
    await s.perform({ verb: 'wait', ms: 65_000 });
    await fill(s, 'New todo', { literal: 'Late' });
    const after = await click(s, 'button', 'Add');
    expect(after.nodes.find((n) => n.role === 'listitem')?.name).toMatch(/^Late \u2014 added 09:01:0\d$/);
  });

  it('R-RN1 (with the real settler): /todos settles despite the volatile sync status, and probe observations differ', async () => {
    const s = await track(openSession());
    await goto(s, '/todos');
    const clock = virtualClock();
    const settler = createSettler({ clock });
    const opts = { quietMs: 300, intervalMs: 100, timeoutMs: 5000 };
    const first = await settler.settle(s, opts);
    expect(first.settled).toBe(true);
    await clock.sleep(500); // probe wait
    const probe = await settler.settle(s, opts);
    expect(probe.settled).toBe(true);
    expect(probe.observation.treeHash).not.toBe(first.observation.treeHash);
    const name = (o: typeof first): string | undefined => o.observation.nodes.find((n) => n.name.startsWith('Synced at'))?.name;
    expect(name(first)).not.toBe(name(probe));
  });

  it('R-RN1 (with the real settler): /slow?ms=10000 with a 500 ms timeout never settles; a short spinner does', async () => {
    const s = await track(openSession());
    await goto(s, '/slow?ms=10000');
    const unsettled = await createSettler({ clock: virtualClock() }).settle(s, { quietMs: 300, intervalMs: 100, timeoutMs: 500 });
    expect(unsettled.settled).toBe(false);
    expect(unsettled.observation.busy).toBe(true);

    const t = await track(openSession());
    await goto(t, '/slow?ms=1500');
    const ok = await createSettler({ clock: virtualClock() }).settle(t, { quietMs: 300, intervalMs: 100, timeoutMs: 5000 });
    expect(ok.settled).toBe(true);
    expect(has(ok.observation, 'heading', 'Report ready')).toBe(true);
  });
});

describe('session isolation and limits (R-RN2)', () => {
  it('state set in one session is invisible in another, including test API seeds', async () => {
    const driver = await openDriver();
    const a = await track(driver.openSession(sessionOptions({ scenarioId: 'a' })));
    const b = await track(driver.openSession(sessionOptions({ scenarioId: 'b' })));
    await goto(a, '/settings/billing');
    await goto(b, '/settings/billing');
    await click(a, 'button', 'Upgrade to Pro');
    await click(a, 'button', 'Confirm');
    const seen = await b.observe();
    expect(has(seen, 'status', 'Plan: Free')).toBe(true);
    expect(has(seen, 'dialog', 'Confirm upgrade')).toBe(false);
    await a.request?.({ method: 'POST', path: '/__test/seed', headers: { 'x-acme-test-token': 'acme-test' }, body: { plan: 'pro', unpaid: 5 } });
    expect(has(await goto(b, '/settings/billing'), 'status', 'Plan: Free')).toBe(true);
    // todos too
    await goto(a, '/todos');
    await fill(a, 'New todo', { literal: 'private' });
    await click(a, 'button', 'Add');
    expect((await goto(b, '/todos')).nodes.some((n) => n.role === 'listitem')).toBe(false);
  });

  it('20 parallel sessions on one driver (capped at 20) never leak state', async () => {
    const driver = await openDriver({ maxSessions: 20 });
    const sessions = await Promise.all(Array.from({ length: 20 }, (_, i) => driver.openSession(sessionOptions({ scenarioId: `s${i}` }))));
    toClose.push(...sessions);
    await Promise.all(
      sessions.map(async (s, i) => {
        await goto(s, '/todos');
        await fill(s, 'New todo', { literal: `item-${i}` });
        await click(s, 'button', 'Add');
      }),
    );
    for (const [i, s] of sessions.entries()) {
      const titles = (await s.observe()).nodes.filter((n) => n.role === 'listitem').map((n) => n.name.split(' \u2014 ')[0]);
      expect(titles).toEqual([`item-${i}`]);
    }
  });

  it('enforces maxSessions with SESSION_LIMIT and frees slots on close and dispose', async () => {
    const driver = await openDriver({ maxSessions: 2 });
    const a = await driver.openSession(sessionOptions());
    await driver.openSession(sessionOptions());
    await expect(driver.openSession(sessionOptions())).rejects.toMatchObject({ code: 'SESSION_LIMIT', retryable: false });
    await a.close();
    const c = await driver.openSession(sessionOptions());
    expect(c.id).not.toBe(a.id);
    await driver.dispose();
    await expect(c.observe()).rejects.toMatchObject({ code: 'DRIVER_ERROR' });
    const again = await driver.openSession(sessionOptions());
    await again.close();
  });

  it('every session starts at the same fake time (reproducible runs)', async () => {
    const driver = await openDriver();
    const names: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const s = await track(driver.openSession(sessionOptions()));
      await s.perform({ verb: 'wait', ms: 12_345 });
      names.push((await goto(s, '/todos')).nodes.find((n) => n.name.startsWith('Synced at'))?.name ?? '');
    }
    expect(names[0]).toBe(names[1]);
  });
});

describe('request (test API through the session)', () => {
  const token = { 'x-acme-test-token': 'acme-test' };

  it('enforces the token on every /__test route', async () => {
    const s = await track(openSession());
    for (const path of ['/__test/reset', '/__test/seed', '/__test/unknown']) {
      expect((await s.request?.({ method: 'POST', path }))?.status, path).toBe(401);
      expect((await s.request?.({ method: 'POST', path, headers: { 'x-acme-test-token': 'wrong' } }))?.status, path).toBe(401);
    }
    expect((await s.request?.({ method: 'POST', path: '/__test/reset', headers: token }))?.status).toBe(200);
    expect((await s.request?.({ method: 'POST', path: '/__test/reset', headers: { 'X-Acme-Test-Token': 'acme-test' } }))?.status).toBe(200);
  });

  it('honours a custom test token', async () => {
    const s = await track(openSession({ testToken: 's3cret' }));
    expect((await s.request?.({ method: 'POST', path: '/__test/reset', headers: token }))?.status).toBe(401);
    expect((await s.request?.({ method: 'POST', path: '/__test/reset', headers: { 'x-acme-test-token': 's3cret' } }))?.status).toBe(200);
  });

  it('validates seed bodies and methods', async () => {
    const s = await track(openSession());
    const seed = (body: unknown) => s.request?.({ method: 'POST', path: '/__test/seed', headers: token, body: body as never });
    expect((await seed({ plan: 'gold' }))?.status).toBe(400);
    expect((await seed({ unpaid: -1 }))?.status).toBe(400);
    expect((await seed({ unpaid: 1.5 }))?.status).toBe(400);
    expect((await seed({ flags: ['nope'] }))?.status).toBe(400);
    expect((await seed({ signedIn: 'yes' }))?.status).toBe(400);
    expect((await seed({ extra: 1 }))?.status).toBe(400);
    expect((await seed([1]))?.status).toBe(400);
    expect((await s.request?.({ method: 'GET', path: '/__test/seed', headers: token }))?.status).toBe(405);
    expect((await s.request?.({ method: 'POST', path: '/other', headers: token }))?.status).toBe(404);
    expect((await seed({ plan: 'pro', unpaid: 2, flags: ['v2'], signedIn: true }))).toEqual({
      status: 200,
      body: { ok: true, plan: 'pro', unpaid: 2, flags: ['v2'], signedIn: true },
    });
  });

  it('seed can switch flags per session and reset restores the driver flags', async () => {
    const s = await track(openSession({ flags: ['v2'] }));
    await s.request?.({ method: 'POST', path: '/__test/seed', headers: token, body: { flags: ['bug-upgrade-noop'] } });
    const a = await goto(s, '/settings/billing');
    expect(has(a, 'button', 'Upgrade to Pro')).toBe(true);
    await s.request?.({ method: 'POST', path: '/__test/reset', headers: token });
    expect(has(await goto(s, '/settings/billing'), 'button', 'Go Pro')).toBe(true);
  });

  it('refuses absolute request URLs to hosts outside the policy', async () => {
    const s = await track(openSession());
    await expect(s.request?.({ method: 'POST', path: 'https://evil.example/__test/reset', headers: token })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const ok = await s.request?.({ method: 'POST', path: `${BASE}/__test/reset`, headers: token });
    expect(ok?.status).toBe(200);
  });
});

describe('screenshots (R-JU3 / masking)', () => {
  it('only produces pixels on request, always masked, and the sha256 matches the bytes', async () => {
    const { sha256Hex } = await import('@ai-bdd/sdk');
    const s = await track(openSession());
    await goto(s, '/settings/billing');
    expect((await s.observe()).screenshot).toBeUndefined();
    expect((await s.observe({ pixels: false })).screenshot).toBeUndefined();
    const shot = (await s.observe({ pixels: true })).screenshot;
    expect(shot?.masked).toBe(true);
    expect(shot?.sha256).toBe(sha256Hex(shot?.png ?? new Uint8Array()));
  });
});
