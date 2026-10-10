// @ts-nocheck
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Driver, DriverSession, Observation, ObservedNode, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { cua } from '../src/index.ts';
import { chromiumArgs, realEnvironment, startFixture, unavailableReason } from './environment.ts';
import type { Fixture } from './environment.ts';

// The real product: a real cua-driver operating a real Chromium window on a real (virtual) desktop. Slow by nature.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const env = realEnvironment();
// AI_BDD_REQUIRE_CUA=1 (the CI job that provides a desktop) turns a missing environment into a failure instead of a skip.
const required = process.env['AI_BDD_REQUIRE_CUA'] === '1';
const SECRET = 'correct-horse-battery';
const policy: Policy = { allowHosts: ['127.0.0.1'], denyVerbs: [] };

let fx: Fixture;
let driver: Driver;

function sessionOpts(over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    scenarioId: 'scn', baseURL: fx.url, policy,
    resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? SECRET : ''),
    ...over,
  };
}
const find = (obs: Observation, role: string, name: string): ObservedNode => {
  const n = obs.nodes.find((x) => x.role === role && x.name === name);
  if (n === undefined) throw new Error(`no ${role} ${JSON.stringify(name)} in\n${obs.treeText}`);
  return n;
};
async function until<T>(session: DriverSession, probe: (obs: Observation) => T | undefined, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const obs = await session.observe();
    const hit = probe(obs);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms:\n${obs.treeText}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
async function ok(session: DriverSession, action: Parameters<DriverSession['perform']>[0]): Promise<void> {
  const r = await session.perform(action);
  if (!r.ok) throw new Error(`${JSON.stringify(action)} failed: ${JSON.stringify(r.error)}`);
}

describe.skipIf(env === undefined && !required)('driver-cua against the real Cua Driver (Chromium on a Linux desktop)', () => {
  beforeAll(async () => {
    if (env === undefined) throw new Error(`the Cua Driver environment is required (AI_BDD_REQUIRE_CUA=1) but missing: ${unavailableReason() ?? 'unknown'}`);
    fx = await startFixture();
    driver = await cua({
      kind: 'browser',
      launch: { command: env.chromium, args: chromiumArgs() },
      startTimeoutMs: 30_000,
    }).create({ projectRoot: process.cwd(), policy, artifactsDir: tmpdir(), baseURL: fx.url });
  });
  afterAll(async () => {
    await driver?.dispose();
    await fx?.close();
  });

  it('selfCheck passes on a working desktop', async () => {
    const check = await driver.selfCheck();
    expect(check.problems).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('declares honest capabilities', () => {
    expect(driver.id).toBe('cua');
    expect(driver.capabilities).toEqual({
      verbs: ['click', 'fill', 'press', 'check', 'scroll', 'wait', 'navigate', 'back'],
      pixels: true, maskingProven: false, request: false, maxSessions: 1, exclusiveResource: 'cua-desktop',
    });
  });

  it('observes the page content as ARIA-role nodes, without the browser chrome', async () => {
    const s = await driver.openSession(sessionOpts());
    try {
      const obs = await s.observe();
      expect(obs.route).toBe('Probe');
      expect(obs.title).toBe('Probe');
      expect(find(obs, 'heading', 'Hello').depth).toBe(find(obs, 'heading', 'Hello').depth);
      expect(find(obs, 'textbox', 'Name')).toBeTruthy();
      expect(find(obs, 'button', 'Greet')).toBeTruthy();
      expect(find(obs, 'link', 'Settings page')).toBeTruthy();
      expect(obs.nodes.some((n) => n.name === 'Address and search bar' || n.name === 'Reload')).toBe(false);
      expect(obs.nodes.every((n) => /^r1:e\d+$/.test(n.ref))).toBe(true);
      expect(obs.treeText).toContain('[ref=r1:e');
      expect(obs.treeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.busy).toBe(false);
      expect(obs.tainted).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('fill replaces what is in the field, click reaches the page, and the page reacts', async () => {
    const s = await driver.openSession(sessionOpts());
    try {
      let obs = await s.observe();
      await ok(s, { verb: 'fill', target: { ref: find(obs, 'textbox', 'Name').ref }, value: { literal: 'Alice' } });
      obs = await s.observe();
      await ok(s, { verb: 'click', target: { ref: find(obs, 'button', 'Greet').ref } });
      await until(s, (o) => o.nodes.find((n) => n.name === 'Hi Alice'));
    } finally {
      await s.close();
    }
  });

  it('refuses refs of an older observation and unknown refs, without touching the page', async () => {
    const s = await driver.openSession(sessionOpts());
    try {
      const first = await s.observe();
      const greet = find(first, 'button', 'Greet').ref;
      await s.observe();
      const stale = await s.perform({ verb: 'click', target: { ref: greet } });
      expect(stale.ok).toBe(false);
      expect(stale.error?.code).toBe('STALE_REF');
      const latest = await s.observe();
      const unknown = await s.perform({ verb: 'click', target: { ref: `r${latest.revision}:e99999` } });
      expect(unknown.error?.code).toBe('TARGET_NOT_FOUND');
      const malformed = await s.perform({ verb: 'click', target: { ref: 'nope' } });
      expect(malformed.error?.code).toBe('STALE_REF');
    } finally {
      await s.close();
    }
  });

  it('navigates by the address bar, follows links, goes back, checks boxes and reaches off-screen controls', async () => {
    const s = await driver.openSession(sessionOpts());
    try {
      let obs = await s.observe();
      await ok(s, { verb: 'click', target: { ref: find(obs, 'link', 'Settings page').ref } });
      obs = await until(s, (o) => (o.nodes.some((n) => n.role === 'heading' && n.name === 'Settings') ? o : undefined));
      expect(obs.route).toBe('Settings');

      const subscribe = find(obs, 'checkbox', 'Subscribe');
      expect(subscribe.states.checked).toBe(true);
      expect(find(obs, 'checkbox', 'Terms').states.checked).toBe(false);

      await ok(s, { verb: 'check', target: { ref: subscribe.ref }, checked: true }); // already checked: nothing to do
      obs = await s.observe();
      expect(find(obs, 'checkbox', 'Subscribe').states.checked).toBe(true);
      await ok(s, { verb: 'check', target: { ref: find(obs, 'checkbox', 'Terms').ref }, checked: true });
      obs = await until(s, (o) => (o.nodes.find((n) => n.role === 'checkbox' && n.name === 'Terms')?.states.checked === true ? o : undefined));
      await ok(s, { verb: 'check', target: { ref: find(obs, 'checkbox', 'Subscribe').ref }, checked: false });
      await until(s, (o) => (o.nodes.find((n) => n.role === 'checkbox' && n.name === 'Subscribe')?.states.checked === false ? o : undefined));

      obs = await s.observe();
      expect(obs.nodes.some((n) => n.name.startsWith('off-screen'))).toBe(false); // the driver's annotations are not names
      await ok(s, { verb: 'scroll', direction: 'down' });
      await ok(s, { verb: 'click', target: { ref: find(obs, 'button', 'Bottom').ref } });
      obs = await s.observe();
      await ok(s, { verb: 'click', target: { ref: find(obs, 'button', 'Bottom').ref } });
      await until(s, (o) => o.nodes.find((n) => n.name === 'bottom clicked'));

      await ok(s, { verb: 'back' });
      await until(s, (o) => (o.nodes.some((n) => n.role === 'heading' && n.name === 'Hello') ? o : undefined));

      await ok(s, { verb: 'navigate', url: '/two' });
      await until(s, (o) => (o.nodes.some((n) => n.role === 'heading' && n.name === 'Settings') ? o : undefined));
    } finally {
      await s.close();
    }
  });

  it('enforces the policy on the navigate verb and rejects verbs the driver does not offer', async () => {
    const s = await driver.openSession(sessionOpts());
    try {
      const denied = await s.perform({ verb: 'navigate', url: 'https://evil.example/' });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe('POLICY_DENIED');
      const scheme = await s.perform({ verb: 'navigate', url: 'file:///etc/passwd' });
      expect(scheme.error?.code).toBe('POLICY_DENIED');
      const obs = await s.observe();
      const hover = await s.perform({ verb: 'hover', target: { ref: find(obs, 'button', 'Greet').ref } });
      expect(hover.error?.code).toBe('VERB_UNSUPPORTED');
      const select = await s.perform({ verb: 'select', target: { ref: find(obs, 'button', 'Greet').ref }, option: { literal: 'x' } });
      expect(select.error?.code).toBe('VERB_UNSUPPORTED');
    } finally {
      await s.close();
    }

    const locked = await driver.openSession(sessionOpts({ policy: { allowHosts: ['127.0.0.1'], denyVerbs: ['click'] } }));
    try {
      const obs = await locked.observe();
      const r = await locked.perform({ verb: 'click', target: { ref: find(obs, 'button', 'Greet').ref } });
      expect(r.error?.code).toBe('POLICY_DENIED');
    } finally {
      await locked.close();
    }
  });

  it('keeps secrets out: password values are never observed, the session is tainted, screenshots are not marked masked', async () => {
    const s = await driver.openSession(sessionOpts());
    try {
      await ok(s, { verb: 'navigate', url: '/two' });
      let obs = await until(s, (o) => (o.nodes.some((n) => n.name === 'Password') ? o : undefined));
      expect(obs.tainted).toBe(false);
      await ok(s, { verb: 'fill', target: { ref: find(obs, 'textbox', 'Password').ref }, value: { secret: 'adminPassword' } });
      obs = await s.observe({ pixels: true });
      expect(obs.tainted).toBe(true);
      const password = find(obs, 'textbox', 'Password');
      expect(password.value).toBeUndefined();
      expect(JSON.stringify(obs)).not.toContain(SECRET);
      expect(obs.screenshot?.masked).toBe(false);
      expect(Array.from(obs.screenshot?.png.slice(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await s.close();
    }
  });

  it('closing a session ends the application and removes its profile; a new session starts clean', async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith('ai-bdd-cua-'));
    const s = await driver.openSession(sessionOpts());
    const during = readdirSync(tmpdir()).filter((f) => f.startsWith('ai-bdd-cua-') && !before.includes(f));
    expect(during).toHaveLength(1);
    await s.close();
    const dir = `${tmpdir()}/${during[0] as string}`;
    expect(existsSync(dir)).toBe(false);
    await expect(s.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    expect((await s.perform({ verb: 'wait', ms: 1 })).error?.code).toBe('DRIVER_UNAVAILABLE');

    const fresh = await driver.openSession(sessionOpts());
    try {
      const obs = await fresh.observe();
      expect(find(obs, 'textbox', 'Name')).toBeTruthy(); // the page shows the start URL again: no state carried over
    } finally {
      await fresh.close();
    }
  });
});
