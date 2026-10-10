/**
 * Driver conformance kit (§11.2), shared by every driver package and by tests/acceptance through a
 * relative import. It is vitest-compatible: call `runDriverConformance(...)` at module level of a
 * test file and it declares one `describe` block.
 *
 * The kit exercises a driver through the public SPI only (`DriverFactory` -> `Driver` -> `DriverSession`)
 * against the Acme fixture app routes of §13.1:
 *
 *   /login  /settings/billing  /todos  /forms/two  /slow?ms=N  /notes  and POST /__test/seed
 *
 * `appUrl` is the origin of an Acme app. For `startAcmeApp` that is its `url`. For a driver that does not
 * speak HTTP (the fake driver) pass any allowlisted http(s) origin, for example `http://localhost:4173`,
 * because the fake driver serves the Acme screens for its `baseURL`. Tests that need the app are skipped
 * when `appUrl` is absent; the capability, policy-denial and identity tests always run.
 */
// @ts-nocheck

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActionOutcome,
  Driver,
  DriverAction,
  DriverFactory,
  DriverSession,
  Observation,
  ObservedNode,
  Policy,
  SessionOptions,
  ValueSource,
} from '../../src/contracts/index.ts';
import { sha256Hex, treeHash } from '../../src/util/index.ts';

export interface ConformanceOptions {
  /** Origin of an Acme app (see file header). When absent the app-dependent tests are skipped. */
  appUrl?: string;
  /** Header value for the `/__test/*` API. Default `acme-test`. */
  testToken?: string;
  /** Value used for `{secret: 'adminPassword'}`. Default `correct-horse-battery`. */
  adminPassword?: string;
  /** Extra hosts to allow in the session policy. */
  allowHosts?: string[];
  /** Duration used for `/slow?ms=`. Default 1500. */
  slowMs?: number;
}

export interface FactoryEnv {
  appUrl: string | undefined;
}

export type MakeFactory = (env: FactoryEnv) => DriverFactory | Promise<DriverFactory>;

const SECRET_NAME = 'adminPassword';

// ───────────────────────── helpers

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 10_000, everyMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await sleep(everyMs);
  }
}

function find(obs: Observation, role: string, name: string): ObservedNode | undefined {
  return obs.nodes.find((n) => n.role === role && n.name === name);
}

function mustFind(obs: Observation, role: string, name: string): ObservedNode {
  const n = find(obs, role, name);
  if (n === undefined) {
    throw new Error(`no ${role} "${name}" in observation of ${obs.route}:\n${obs.treeText.slice(0, 1500)}`);
  }
  return n;
}

function ancestorNames(obs: Observation, node: ObservedNode): string[] {
  const byRef = new Map(obs.nodes.map((n) => [n.ref, n]));
  const out: string[] = [];
  let cur = node.parentRef === undefined ? undefined : byRef.get(node.parentRef);
  while (cur !== undefined) {
    if (cur.name !== '') out.push(cur.name);
    cur = cur.parentRef === undefined ? undefined : byRef.get(cur.parentRef);
  }
  return out;
}

/** Drivers return `{ok:false, error}`; a thrown AiBddError with the same code is accepted too. */
async function outcomeOf(run: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
  try {
    return await run();
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string') {
      return { ok: false, error: { code: e.code as never, message: String(e.message ?? ''), retryable: false } };
    }
    throw err;
  }
}

// ───────────────────────── the kit

export function runDriverConformance(name: string, makeFactory: MakeFactory, options: ConformanceOptions = {}): void {
  const appUrl = options.appUrl;
  const token = options.testToken ?? 'acme-test';
  const password = options.adminPassword ?? 'correct-horse-battery';
  const slowMs = options.slowMs ?? 1500;
  const needsApp = describe.skipIf(appUrl === undefined);

  let driver: Driver;
  const opened: DriverSession[] = [];
  let seq = 0;

  const hosts = ['localhost', '127.0.0.1', '[::1]', ...(appUrl === undefined ? [] : [new URL(appUrl).hostname]), ...(options.allowHosts ?? [])];
  const basePolicy: Policy = { allowHosts: [...new Set(hosts)], denyVerbs: [] };

  function resolveValue(v: ValueSource): string {
    if ('literal' in v) return v.literal;
    if ('param' in v) throw new Error(`conformance kit has no param "${v.param}"`);
    if (v.secret === SECRET_NAME) return password;
    throw new Error(`conformance kit has no secret "${v.secret}"`);
  }

  async function open(policy: Policy = basePolicy): Promise<DriverSession> {
    seq += 1;
    const opts: SessionOptions = { scenarioId: `conformance/${name}/${seq}`, policy, resolveValue };
    if (appUrl !== undefined) opts.baseURL = appUrl;
    const session = await driver.openSession(opts);
    opened.push(session);
    return session;
  }

  async function perform(session: DriverSession, action: DriverAction): Promise<ActionOutcome> {
    return outcomeOf(() => session.perform(action));
  }

  async function go(session: DriverSession, path: string): Promise<Observation> {
    if (appUrl === undefined) throw new Error('go() needs appUrl');
    const out = await perform(session, { verb: 'navigate', url: new URL(path, appUrl).toString() });
    if (!out.ok) throw new Error(`navigate ${path} failed: ${JSON.stringify(out.error)}`);
    return session.observe();
  }

  async function withSession<T>(fn: (s: DriverSession) => Promise<T>, policy?: Policy): Promise<T> {
    const s = await open(policy);
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  }

  describe(`driver conformance: ${name}`, () => {
    beforeAll(async () => {
      const factory = await makeFactory({ appUrl });
      const artifactsDir = await mkdtemp(join(tmpdir(), 'ai-bdd-conformance-'));
      const ctx = { projectRoot: process.cwd(), policy: basePolicy, artifactsDir, ...(appUrl === undefined ? {} : { baseURL: appUrl }) };
      driver = await factory.create(ctx);
    }, 60_000);

    afterAll(async () => {
      for (const s of opened) {
        try {
          await s.close();
        } catch {
          // already closed by the test
        }
      }
      await driver?.dispose();
    }, 60_000);

    describe('identity and capabilities', () => {
      it('declares id, version and well-formed capabilities', () => {
        expect(driver.id).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(driver.version).toMatch(/^\d+\.\d+\.\d+/);
        const caps = driver.capabilities;
        expect(Array.isArray(caps.verbs)).toBe(true);
        expect(caps.verbs.length).toBeGreaterThan(0);
        expect(typeof caps.pixels).toBe('boolean');
        expect(typeof caps.maskingProven).toBe('boolean');
        expect(typeof caps.request).toBe('boolean');
        expect(Number.isInteger(caps.maxSessions) && caps.maxSessions >= 1).toBe(true);
        if (caps.maskingProven) expect(caps.pixels).toBe(true);
      });

      it('passes its own selfCheck', async () => {
        const res = await driver.selfCheck();
        expect(res.problems).toEqual([]);
        expect(res.ok).toBe(true);
      }, 60_000);

      it('opens sessions that report the driver identity and unique ids', async () => {
        const a = await open();
        const b = await open();
        try {
          expect(a.driverId).toBe(driver.id);
          expect(a.driverVersion).toBe(driver.version);
          expect(a.capabilities.verbs).toEqual(driver.capabilities.verbs);
          expect(a.id).not.toBe(b.id);
        } finally {
          await a.close();
          await b.close();
        }
      });
    });

    describe('navigate policy (R-AG3)', () => {
      const denied: [string, string][] = [
        ['javascript: URL', 'javascript:alert(1)'],
        ['data: URL', 'data:text/html,<h1>owned</h1>'],
        ['file: URL', 'file:///etc/passwd'],
        ['off-host URL', 'http://evil.example/steal'],
        ['off-host URL with an uppercase host', 'http://EVIL.example/steal'],
        ['off-host URL with a trailing-dot host', 'http://evil.example./steal'],
        ['URL with credentials', 'http://user:secret@localhost/'],
      ];
      for (const [label, url] of denied) {
        it(`denies navigation to a ${label}`, async () => {
          if (!driver.capabilities.verbs.includes('navigate')) return;
          await withSession(async (s) => {
            const before = await s.observe();
            const out = await perform(s, { verb: 'navigate', url });
            expect(out.ok).toBe(false);
            expect(out.error?.code).toBe('POLICY_DENIED');
            // the session is unharmed and the page did not change
            const after = await s.observe();
            expect(after.route).toBe(before.route);
            expect(after.treeHash).toBe(before.treeHash);
          });
        });
      }

      needsApp('with the app', () => {
        it('allows navigation to an allowlisted host', async () => {
          await withSession(async (s) => {
            const obs = await go(s, '/todos');
            expect(obs.route).toBe('/todos');
          });
        });

        it('denies a verb listed in policy.denyVerbs', async () => {
          if (!driver.capabilities.verbs.includes('hover')) return;
          await withSession(
            async (s) => {
              const obs = await go(s, '/login');
              const out = await perform(s, { verb: 'hover', target: { ref: mustFind(obs, 'button', 'Sign in').ref } });
              expect(out.ok).toBe(false);
              expect(out.error?.code).toBe('POLICY_DENIED');
            },
            { ...basePolicy, denyVerbs: ['hover'] },
          );
        });
      });
    });

    needsApp('observe', () => {
      it('returns a well-formed observation of /login', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/login');
          expect(typeof obs.revision).toBe('number');
          expect(obs.route).toBe('/login');
          expect(obs.busy).toBe(false);
          expect(obs.tainted).toBe(false);
          expect(obs.treeText).toContain('Sign in');
          expect(obs.nodes.length).toBeGreaterThan(0);
          const refs = new Set(obs.nodes.map((n) => n.ref));
          expect(refs.size).toBe(obs.nodes.length);
          for (const n of obs.nodes) {
            expect(typeof n.ref).toBe('string');
            expect(typeof n.role).toBe('string');
            expect(typeof n.name).toBe('string');
            expect(typeof n.states).toBe('object');
            expect(Number.isInteger(n.depth) && n.depth >= 0).toBe(true);
            if (n.parentRef !== undefined) expect(refs.has(n.parentRef)).toBe(true);
          }
          const heading = mustFind(obs, 'heading', 'Sign in');
          expect(heading.level).toBe(1);
          mustFind(obs, 'textbox', 'Email');
          mustFind(obs, 'textbox', 'Password');
          mustFind(obs, 'button', 'Sign in');
        });
      });

      it('exposes the primary navigation on every screen', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/todos');
          const nav = mustFind(obs, 'navigation', 'Primary');
          for (const link of ['Billing', 'Todos', 'Checkout', 'Release notes']) {
            const node = mustFind(obs, 'link', link);
            expect(ancestorNames(obs, node)).toContain(nav.name);
          }
        });
      });

      it('treeHash is the util hash of the nodes and is stable across repeated observations', async () => {
        await withSession(async (s) => {
          await go(s, '/settings/billing');
          const a = await s.observe();
          const b = await s.observe();
          expect(a.treeHash).toMatch(/^[0-9a-f]{64}$/);
          expect(a.treeHash).toBe(treeHash(a.nodes));
          expect(b.treeHash).toBe(a.treeHash);
          expect(b.nodes.map((n) => `${n.role}|${n.name}`)).toEqual(a.nodes.map((n) => `${n.role}|${n.name}`));
          expect(b.revision).toBeGreaterThan(a.revision);
        });
      });

      it('treeHash changes when the page changes', async () => {
        await withSession(async (s) => {
          const a = await go(s, '/login');
          const b = await go(s, '/todos');
          expect(b.treeHash).not.toBe(a.treeHash);
        });
      });

      it('reports the ancestors that tell duplicate controls apart (/forms/two)', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/forms/two');
          const submits = obs.nodes.filter((n) => n.role === 'button' && n.name === 'Submit');
          expect(submits).toHaveLength(2);
          const regions = submits.map((n) => ancestorNames(obs, n).find((a) => a === 'Shipping' || a === 'Billing address'));
          expect(regions.sort()).toEqual(['Billing address', 'Shipping']);
        });
      });

      it('observes pixels only on request, as PNG bytes with a matching sha256 and a masked flag', async () => {
        await withSession(async (s) => {
          await go(s, '/login');
          const plain = await s.observe({ pixels: false });
          expect(plain.screenshot).toBeUndefined();
          if (!s.capabilities.pixels) return;
          const withShot = await s.observe({ pixels: true });
          const shot = withShot.screenshot;
          expect(shot).toBeDefined();
          if (shot === undefined) return;
          expect([...shot.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
          expect(shot.sha256).toBe(sha256Hex(shot.png));
          expect(typeof shot.masked).toBe('boolean');
        });
      });
    });

    needsApp('perform', () => {
      it('fill and click change the page (wrong password shows the alert)', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/login');
          const email = await perform(s, { verb: 'fill', target: { ref: mustFind(obs, 'textbox', 'Email').ref }, value: { literal: 'admin@acme.test' } });
          expect(email.ok).toBe(true);
          const obs2 = await s.observe();
          const pw = await perform(s, { verb: 'fill', target: { ref: mustFind(obs2, 'textbox', 'Password').ref }, value: { literal: 'definitely-wrong-password' } });
          expect(pw.ok).toBe(true);
          const obs3 = await s.observe();
          const click = await perform(s, { verb: 'click', target: { ref: mustFind(obs3, 'button', 'Sign in').ref } });
          expect(click.ok).toBe(true);
          const alert = await until(async () => find(await s.observe(), 'alert', 'Invalid email or password'));
          expect(alert.role).toBe('alert');
        });
      });

      it('adding a todo shows it in the list', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/todos');
          await perform(s, { verb: 'fill', target: { ref: mustFind(obs, 'textbox', 'New todo').ref }, value: { literal: 'buy conformance milk' } });
          const obs2 = await s.observe();
          const click = await perform(s, { verb: 'click', target: { ref: mustFind(obs2, 'button', 'Add').ref } });
          expect(click.ok).toBe(true);
          const item = await until(async () => (await s.observe()).nodes.find((n) => n.role === 'listitem' && n.name.includes('buy conformance milk')));
          expect(item.name).toContain('buy conformance milk');
        });
      });

      it('rejects refs from an older observation (STALE_REF) without acting', async () => {
        await withSession(async (s) => {
          const old = await go(s, '/login');
          const oldButton = mustFind(old, 'button', 'Sign in');
          const email = mustFind(old, 'textbox', 'Email');
          expect((await perform(s, { verb: 'fill', target: { ref: email.ref }, value: { literal: 'a@b.test' } })).ok).toBe(true);
          const fresh = await s.observe();
          expect(fresh.revision).toBeGreaterThan(old.revision);
          const out = await perform(s, { verb: 'click', target: { ref: oldButton.ref } });
          expect(out.ok).toBe(false);
          expect(out.error?.code).toBe('STALE_REF');
          // no side effect: still on the login screen with no alert
          const after = await s.observe();
          expect(after.route).toBe('/login');
          expect(find(after, 'alert', 'Invalid email or password')).toBeUndefined();
          // a ref from the current observation still works
          const ok = await perform(s, { verb: 'click', target: { ref: mustFind(after, 'button', 'Sign in').ref } });
          expect(ok.ok).toBe(true);
        });
      });

      it('rejects a ref that never existed', async () => {
        await withSession(async (s) => {
          await go(s, '/login');
          const out = await perform(s, { verb: 'click', target: { ref: 'r999999:e999999' } });
          expect(out.ok).toBe(false);
          expect(['STALE_REF', 'TARGET_NOT_FOUND']).toContain(out.error?.code);
        });
      });
    });

    needsApp('taint (R-SE2)', () => {
      it('marks the session tainted after a secret fill, never exposes the value, and keeps the taint', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/login');
          expect(obs.tainted).toBe(false);
          const out = await perform(s, { verb: 'fill', target: { ref: mustFind(obs, 'textbox', 'Password').ref }, value: { secret: SECRET_NAME } });
          expect(out.ok).toBe(true);
          const after = await s.observe({ pixels: s.capabilities.pixels });
          expect(after.tainted).toBe(true);
          expect(after.treeText).not.toContain(password);
          expect(JSON.stringify(after.nodes)).not.toContain(password);
          if (after.screenshot !== undefined) expect(after.screenshot.masked).toBe(true);
          // the taint outlives navigation
          const later = await go(s, '/todos');
          expect(later.tainted).toBe(true);
        });
      });

      it('does not taint a session that only filled literals', async () => {
        await withSession(async (s) => {
          const obs = await go(s, '/login');
          await perform(s, { verb: 'fill', target: { ref: mustFind(obs, 'textbox', 'Email').ref }, value: { literal: 'admin@acme.test' } });
          expect((await s.observe()).tainted).toBe(false);
        });
      });
    });

    needsApp('busy detection (R-RN1)', () => {
      it('reports busy while /slow is loading and a result after it completes', async () => {
        await withSession(async (s) => {
          const first = await go(s, `/slow?ms=${slowMs}`);
          expect(first.busy).toBe(true);
          expect(find(first, 'progressbar', 'Loading')).toBeDefined();
          const done = await until(async () => {
            const o = await s.observe();
            return !o.busy ? o : undefined;
          }, slowMs * 6 + 10_000);
          expect(find(done, 'heading', 'Report ready')?.level).toBe(1);
          expect(find(done, 'progressbar', 'Loading')).toBeUndefined();
        });
      }, 60_000);

      it('is not busy on ordinary screens', async () => {
        await withSession(async (s) => {
          expect((await go(s, '/settings/billing')).busy).toBe(false);
        });
      });
    });

    needsApp('session isolation (R-RN2)', () => {
      it('state set in one session is invisible in another', async () => {
        const a = await open();
        const b = await open();
        try {
          const todosA = await go(a, '/todos');
          await perform(a, { verb: 'fill', target: { ref: mustFind(todosA, 'textbox', 'New todo').ref }, value: { literal: 'isolation-marker-7f3a' } });
          const filledA = await a.observe();
          await perform(a, { verb: 'click', target: { ref: mustFind(filledA, 'button', 'Add').ref } });
          await until(async () => (await a.observe()).nodes.find((n) => n.name.includes('isolation-marker-7f3a')));

          const todosB = await go(b, '/todos');
          expect(todosB.nodes.some((n) => n.name.includes('isolation-marker-7f3a'))).toBe(false);
          // and A still has it
          expect((await a.observe()).nodes.some((n) => n.name.includes('isolation-marker-7f3a'))).toBe(true);
        } finally {
          await a.close();
          await b.close();
        }
      });

      it('a secret fill taints only its own session', async () => {
        const a = await open();
        const b = await open();
        try {
          const obsA = await go(a, '/login');
          await perform(a, { verb: 'fill', target: { ref: mustFind(obsA, 'textbox', 'Password').ref }, value: { secret: SECRET_NAME } });
          expect((await a.observe()).tainted).toBe(true);
          expect((await go(b, '/login')).tainted).toBe(false);
        } finally {
          await a.close();
          await b.close();
        }
      });

      it('supports at least two concurrent sessions when maxSessions allows it', async () => {
        if (driver.capabilities.maxSessions < 2) return;
        const sessions = await Promise.all([open(), open()]);
        try {
          const observations = await Promise.all(sessions.map((s) => go(s, '/login')));
          expect(observations.every((o) => o.route === '/login')).toBe(true);
        } finally {
          await Promise.all(sessions.map((s) => s.close()));
        }
      });
    });

    needsApp('request through the session', () => {
      it('shares state with the session: a seed through request() is visible on the next page', async () => {
        await withSession(async (s) => {
          if (!s.capabilities.request || s.request === undefined) return;
          const before = await go(s, '/settings/billing');
          expect(find(before, 'status', 'Plan: Free')).toBeDefined();
          const res = await s.request({ method: 'POST', path: '/__test/seed', headers: { 'x-acme-test-token': token }, body: { plan: 'pro' } });
          expect(res.status).toBeGreaterThanOrEqual(200);
          expect(res.status).toBeLessThan(300);
          const after = await until(async () => {
            const o = await go(s, '/settings/billing');
            return find(o, 'status', 'Plan: Pro') ? o : undefined;
          });
          expect(find(after, 'status', 'Plan: Pro')).toBeDefined();
        });
      });

      it('does not leak seeded state into another session', async () => {
        const a = await open();
        const b = await open();
        try {
          if (!a.capabilities.request || a.request === undefined) return;
          await a.request({ method: 'POST', path: '/__test/seed', headers: { 'x-acme-test-token': token }, body: { plan: 'pro' } });
          const obsB = await go(b, '/settings/billing');
          expect(find(obsB, 'status', 'Plan: Free')).toBeDefined();
        } finally {
          await a.close();
          await b.close();
        }
      });

      it('rejects test API calls without the token', async () => {
        await withSession(async (s) => {
          if (!s.capabilities.request || s.request === undefined) return;
          const res = await s.request({ method: 'POST', path: '/__test/seed', body: { plan: 'pro' } });
          expect(res.status).toBeGreaterThanOrEqual(400);
        });
      });
    });
  });
}
