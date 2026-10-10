import { describe, expect, it } from 'vitest';
import { AiBddError, type Driver, type DriverSession, type Observation } from '@ai-bdd/sdk/contracts';
import { renderTree, treeHash } from '@ai-bdd/sdk';
import { chaosDriver, fakeDriver, garbleObservation, seededRandom, type ChaosDriverFactory, type DriverRule } from '@ai-bdd/testing';
import { BASE, POLICY, sessionOptions } from '../fake-driver/helpers.ts';

const CTX = { projectRoot: '/tmp', baseURL: BASE, policy: POLICY, artifactsDir: '/tmp/artifacts' };

const make = (rules: DriverRule[], seed: number | string = 'unit', maxSessions?: number): ChaosDriverFactory =>
  chaosDriver(fakeDriver(maxSessions === undefined ? {} : { maxSessions }), { seed, rules });

async function open(chaos: ChaosDriverFactory): Promise<{ driver: Driver; session: DriverSession }> {
  const driver = await chaos.create(CTX);
  const session = await driver.openSession(sessionOptions());
  return { driver, session };
}

async function toBilling(session: DriverSession): Promise<Observation> {
  const out = await session.perform({ verb: 'navigate', url: '/settings/billing' });
  expect(out.ok).toBe(true);
  return session.observe();
}

const rejection = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('chaosDriver passthrough', () => {
  it('with no rules it behaves like the wrapped driver and keeps its identity', async () => {
    const inner = fakeDriver();
    const chaos = chaosDriver(inner, { seed: 1, rules: [] });
    expect(chaos.id).toBe(inner.id);
    expect(chaos.seed).toBe('1');
    const a = await open(chaos);
    const b = await (await inner.create(CTX)).openSession(sessionOptions());
    const [oa, ob] = [await toBilling(a.session), await toBilling(b)];
    expect(oa.treeHash).toBe(ob.treeHash);
    expect(oa.treeText).toBe(ob.treeText);
    expect(a.driver.id).toBe('fake');
    expect(a.driver.version).toBe('1.0.0');
    expect(a.driver.capabilities.verbs).toContain('click');
    expect(a.session.driverId).toBe('fake');
    expect(a.session.capabilities).toBe(a.driver.capabilities);
    expect(await a.driver.selfCheck()).toEqual({ ok: true, problems: [] });
    expect(chaos.events).toEqual([]);
  });

  it('exposes request() only when the wrapped session does, and passes it through', async () => {
    const { session } = await open(make([]));
    const res = await session.request?.({ method: 'GET', path: '/__test/state', headers: { 'x-test-token': 'acme-test' } });
    expect(res?.status).toBeGreaterThan(0);

    const bare: DriverSession = {
      id: 's',
      driverId: 'bare',
      driverVersion: '1.0.0',
      capabilities: { verbs: [], pixels: false, maskingProven: false, request: false, maxSessions: 1 },
      observe: async () => ({ revision: 1, route: '/', nodes: [], busy: false, tainted: false, treeText: '', treeHash: 'h' }),
      perform: async () => ({ ok: true }),
      close: async () => {},
    };
    const wrapped = chaosDriver(
      { id: 'bare', create: async () => ({ id: 'bare', version: '1.0.0', capabilities: bare.capabilities, openSession: async () => bare, selfCheck: async () => ({ ok: true, problems: [] }), dispose: async () => {} }) },
      { seed: 1, rules: [] },
    );
    const s = await (await wrapped.create(CTX)).openSession(sessionOptions());
    expect(s.request).toBeUndefined();
  });

  it('rejects an invalid plan at construction', () => {
    expect(() => chaosDriver(fakeDriver(), { seed: 1, rules: [{ at: 'observe', fault: { kind: 'fail' } }] })).toThrow(/cannot strike "observe"/);
  });
});

describe('throwing faults', () => {
  it.each([
    ['DRIVER_ERROR', true],
    ['DRIVER_UNAVAILABLE', true],
    ['SESSION_LIMIT', false],
  ] as const)('throw %s at perform gives an AiBddError with the documented retryable flag (%s)', async (code, retryable) => {
    const chaos = make([{ at: 'perform', fault: { kind: 'throw', code } }]);
    const { session } = await open(chaos);
    const err = await rejection(session.perform({ verb: 'navigate', url: '/' }));
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe(code);
    expect((err as AiBddError).retryable).toBe(code === 'SESSION_LIMIT' ? false : retryable);
    expect((err as AiBddError).message).toContain('chaos: injected');
    expect(chaos.stats.faults.perform).toBe(1);
  });

  it('retryable and message can be overridden', async () => {
    const chaos = make([{ at: 'observe', fault: { kind: 'throw', code: 'DRIVER_ERROR', retryable: false, message: 'boom 42' } }]);
    const { session } = await open(chaos);
    const err = (await rejection(session.observe())) as AiBddError;
    expect(err.message).toBe('boom 42');
    expect(err.retryable).toBe(false);
  });

  it('throw-raw throws a plain Error, not an AiBddError', async () => {
    const chaos = make([{ at: 'observe', fault: { kind: 'throw-raw', message: 'segfault' } }]);
    const { session } = await open(chaos);
    const err = await rejection(session.observe());
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AiBddError);
    expect((err as Error).message).toBe('segfault');
  });

  it('strikes create, openSession and dispose', async () => {
    const onCreate = make([{ at: 'create', fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } }]);
    expect(((await rejection(onCreate.create(CTX))) as AiBddError).code).toBe('DRIVER_UNAVAILABLE');
    expect(onCreate.stats.driversCreated).toBe(0);

    const onOpen = make([{ at: 'openSession', nth: 1, fault: { kind: 'throw', code: 'SESSION_LIMIT' } }]);
    const driver = await onOpen.create(CTX);
    expect(((await rejection(driver.openSession(sessionOptions()))) as AiBddError).code).toBe('SESSION_LIMIT');
    expect(onOpen.stats.sessionsOpened).toEqual([]);
    await driver.openSession(sessionOptions()); // second call is not faulted
    expect(onOpen.stats.sessionsOpened).toHaveLength(1);

    const onDispose = make([{ at: 'dispose', fault: { kind: 'throw-raw', message: 'dispose broke' } }]);
    const d = await onDispose.create(CTX);
    const s = await d.openSession(sessionOptions());
    expect(((await rejection(d.dispose())) as Error).message).toBe('dispose broke');
    expect(onDispose.stats.driversDisposed).toBe(1);
    // the real dispose ran before the injected failure: the wrapped driver closed its session
    await expect(s.observe()).rejects.toThrow(/closed/);
  });

  it('close faults strike after the real close, so the wrapped driver never leaks a session', async () => {
    const chaos = make([{ at: 'close', fault: { kind: 'throw', code: 'DRIVER_ERROR' } }], 'x', 1);
    const driver = await chaos.create(CTX);
    const s1 = await driver.openSession(sessionOptions());
    expect(await rejection(s1.close())).toBeInstanceOf(AiBddError);
    expect(chaos.stats.sessionsClosed).toEqual([s1.id]);
    expect(chaos.stats.openSessions()).toEqual([]);
    // maxSessions is 1: the slot was released despite the injected error
    await expect(driver.openSession(sessionOptions())).resolves.toBeDefined();
  });
});

describe('outcome failures', () => {
  it('fail at perform returns { ok: false } with the code and retryable flag, without touching the page', async () => {
    const chaos = make([{ at: 'perform', verb: 'click', fault: { kind: 'fail', code: 'STALE_REF', message: 'old ref' } }]);
    const { session } = await open(chaos);
    const obs = await toBilling(session);
    const out = await session.perform({ verb: 'click', target: { ref: obs.nodes[0]?.ref ?? 'x' } });
    expect(out).toEqual({ ok: false, error: { code: 'STALE_REF', message: 'old ref', retryable: false } });
    const again = await session.observe();
    expect(again.treeHash).toBe(obs.treeHash);
  });

  it('fail defaults to a retryable DRIVER_ERROR and can be marked non-retryable', async () => {
    const { session } = await open(make([{ at: 'perform', fault: { kind: 'fail' } }]));
    const out = await session.perform({ verb: 'back' });
    expect(out.error?.code).toBe('DRIVER_ERROR');
    expect(out.error?.retryable).toBe(true);
    const { session: s2 } = await open(make([{ at: 'perform', fault: { kind: 'fail', retryable: false } }]));
    expect((await s2.perform({ verb: 'back' })).error?.retryable).toBe(false);
  });

  it('fail at request returns a status/body pair; at selfCheck an ok:false report', async () => {
    const chaos = make([
      { at: 'request', fault: { kind: 'fail', status: 502, message: 'bad gateway' } },
      { at: 'selfCheck', fault: { kind: 'fail', message: 'no browser' } },
    ]);
    const { driver, session } = await open(chaos);
    expect(await session.request?.({ method: 'GET', path: '/x' })).toEqual({ status: 502, body: 'bad gateway' });
    expect(await driver.selfCheck()).toEqual({ ok: false, problems: ['no browser'] });
    const dflt = make([{ at: 'request', fault: { kind: 'fail' } }]);
    const r = await (await open(dflt)).session.request?.({ method: 'GET', path: '/x' });
    expect(r?.status).toBe(503);
  });
});

describe('latency and hangs', () => {
  it('latency is virtual by default: no real waiting, the delay is accounted for, the real call still happens', async () => {
    const chaos = make([{ at: 'observe', fault: { kind: 'latency', ms: 120_000 } }]);
    const { session } = await open(chaos);
    const t0 = Date.now();
    const obs = await session.observe();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(obs.route).toBe('about:blank');
    expect(chaos.stats.virtualDelayMs()).toBe(120_000);
    expect(chaos.events).toEqual([{ seq: 1, at: 'observe', rule: 0, fault: 'latency', session: session.id, detail: '120000 ms' }]);
  });

  it('latency uses the injected sleep when one is given', async () => {
    const waits: number[] = [];
    const chaos = chaosDriver(fakeDriver(), { seed: 1, rules: [{ at: 'perform', fault: { kind: 'latency', ms: 250 } }] }, { sleep: async (ms) => void waits.push(ms) });
    const { session } = await open(chaos);
    expect((await session.perform({ verb: 'navigate', url: '/' })).ok).toBe(true);
    expect(waits).toEqual([250]);
    expect(chaos.stats.virtualDelayMs()).toBe(0);
  });

  it('latency combines with a terminal fault: delay first, then fail', async () => {
    const chaos = make([
      { at: 'observe', fault: { kind: 'latency', ms: 30 } },
      { at: 'observe', fault: { kind: 'throw', code: 'DRIVER_ERROR' } },
    ]);
    const { session } = await open(chaos);
    expect(await rejection(session.observe())).toBeInstanceOf(AiBddError);
    expect(chaos.events.map((e) => e.fault)).toEqual(['latency', 'throw']);
  });

  it('hang never settles; the other calls are unaffected', async () => {
    const chaos = make([{ at: 'observe', nth: 1, fault: { kind: 'hang' } }]);
    const { session } = await open(chaos);
    const first = await Promise.race([session.observe().then(() => 'settled'), new Promise<string>((r) => setTimeout(() => r('pending'), 40))]);
    expect(first).toBe('pending');
    expect((await session.observe()).route).toBe('about:blank');
    expect(chaos.stats.faults.observe).toBe(1);
  });
});

describe('garbled observations', () => {
  const garbled = async (mode: Parameters<typeof garbleObservation>[1] | 'stale', seed: number | string = 'g'): Promise<{ real: Observation; got: Observation }> => {
    const chaos = make([{ at: 'observe', nth: 3, fault: { kind: 'garble', mode } }], seed);
    const { session } = await open(chaos);
    const real = await toBilling(session); // observe #1
    await session.perform({ verb: 'navigate', url: '/todos' });
    await session.observe(); // observe #2 (todos)
    const got = await session.observe(); // observe #3 (garbled)
    return { real, got };
  };

  it('shuffle keeps the same nodes in another order, with consistent text and hash', async () => {
    const chaos = make([{ at: 'observe', nth: 2, fault: { kind: 'garble', mode: 'shuffle' } }], 'sh');
    const { session } = await open(chaos);
    const real = await toBilling(session);
    const got = await session.observe();
    const label = (n: { role: string; name: string }): string => `${n.role}:${n.name}`;
    expect(got.nodes.map(label).sort()).toEqual(real.nodes.map(label).sort());
    expect(got.nodes.map(label)).not.toEqual(real.nodes.map(label));
    expect(got.treeHash).toBe(treeHash(got.nodes));
    expect(got.treeText).toBe(renderTree(got.nodes, { refs: true }));
  });

  it('duplicate-refs leaves at least one ref shared by two nodes', async () => {
    const { got } = await garbled('duplicate-refs');
    const refs = got.nodes.map((n) => n.ref);
    expect(new Set(refs).size).toBeLessThan(refs.length);
  });

  it('drop-fields removes a required field from at least the first node', async () => {
    const { got } = await garbled('drop-fields');
    const first = got.nodes[0] as unknown as Record<string, unknown>;
    expect(['role', 'name', 'states', 'depth', 'ref'].some((f) => !(f in first))).toBe(true);
  });

  it('wrong-types puts a value of the wrong type into at least the first node', async () => {
    const { got } = await garbled('wrong-types');
    const first = got.nodes[0] as unknown as Record<string, unknown>;
    expect(typeof first['name'] !== 'string' || first['states'] === null || typeof first['depth'] !== 'number' || typeof first['role'] !== 'string').toBe(true);
    expect(typeof got.treeHash).toBe('string');
  });

  it('drop-nodes removes the first node and about half of the rest; empty removes all', async () => {
    const { real, got } = await garbled('drop-nodes');
    expect(got.nodes.length).toBeLessThan(real.nodes.length);
    expect(got.nodes.some((n) => n.ref === real.nodes[0]?.ref)).toBe(false);
    const empty = await garbled('empty');
    expect(empty.got.nodes).toEqual([]);
    expect(empty.got.treeHash).toBe(treeHash([]));
  });

  it('stale replays the previous real observation (same revision and refs) even though the page moved on', async () => {
    const { got } = await garbled('stale');
    expect(got.route).toBe('/todos');
    const chaos = make([{ at: 'observe', nth: 2, fault: { kind: 'garble', mode: 'stale' } }]);
    const { session } = await open(chaos);
    const first = await toBilling(session);
    await session.perform({ verb: 'navigate', url: '/todos' });
    const stale = await session.observe();
    expect(stale).toEqual(first);
    expect(stale).not.toBe(first);
    expect((await session.observe()).route).toBe('/todos');
  });

  it('stale with nothing to replay yet passes the real observation through', async () => {
    const chaos = make([{ at: 'observe', nth: 1, fault: { kind: 'garble', mode: 'stale' } }]);
    const { session } = await open(chaos);
    expect((await session.observe()).route).toBe('about:blank');
    expect(chaos.events[0]?.detail).toBe('stale (nothing to replay yet)');
  });

  it('garbling is reproducible by seed and differs across seeds', async () => {
    const same = [await garbled('shuffle', 7), await garbled('shuffle', 7)].map((r) => r.got.nodes.map((n) => n.ref));
    expect(same[0]).toEqual(same[1]);
    const orders = new Set<string>();
    for (let s = 0; s < 6; s += 1) orders.add((await garbled('shuffle', s)).got.nodes.map((n) => n.ref).join());
    expect(orders.size).toBeGreaterThan(1);
  });

  it('garbleObservation falls back to a stable hash when the damaged nodes cannot be rendered', () => {
    const base: Observation = {
      revision: 1,
      route: '/',
      nodes: [{ ref: 'a', role: 'button', name: 'x', states: {}, depth: 0 }],
      busy: false,
      tainted: false,
      treeText: '',
      treeHash: 'h',
    };
    // the first node loses a field, the other tree is fine; rendering a node without `states` throws inside renderTree
    let sawFallback = false;
    for (let seed = 0; seed < 40 && !sawFallback; seed += 1) {
      const out = garbleObservation(base, 'drop-fields', seededRandom(seed));
      sawFallback = out.treeText.startsWith('<garbled');
    }
    expect(sawFallback).toBe(true);
  });
});

describe('session loss', () => {
  it('drop-session fails this call and every later observe/perform/request on that session, but not other sessions', async () => {
    const chaos = make([{ at: 'perform', nth: 2, fault: { kind: 'drop-session', message: 'browser crashed' } }]);
    const driver = await chaos.create(CTX);
    const s1 = await driver.openSession(sessionOptions());
    const s2 = await driver.openSession(sessionOptions());
    expect((await s1.perform({ verb: 'navigate', url: '/' })).ok).toBe(true);
    const lost = (await rejection(s1.perform({ verb: 'back' }))) as AiBddError;
    expect(lost.code).toBe('DRIVER_ERROR');
    expect(lost.message).toBe('browser crashed');
    for (const call of [() => s1.observe(), () => s1.perform({ verb: 'back' }), () => s1.request?.({ method: 'GET', path: '/' }) ?? Promise.reject(new Error('no request'))]) {
      expect(((await rejection(call())) as AiBddError).message).toBe('browser crashed');
    }
    expect((await s2.observe()).route).toBe('about:blank');
    await s1.close(); // closing a lost session still releases the wrapped session
    expect(chaos.stats.openSessions()).toEqual([s2.id]);
    expect(chaos.stats.calls.observe).toBe(2);
  });

  it('drop-session at observe and request, with DRIVER_UNAVAILABLE', async () => {
    const onObserve = make([{ at: 'observe', fault: { kind: 'drop-session', code: 'DRIVER_UNAVAILABLE' } }]);
    const { session } = await open(onObserve);
    expect(((await rejection(session.observe())) as AiBddError).code).toBe('DRIVER_UNAVAILABLE');
    expect(((await rejection(session.perform({ verb: 'back' }))) as AiBddError).code).toBe('DRIVER_UNAVAILABLE');
    const onRequest = make([{ at: 'request', fault: { kind: 'drop-session' } }]);
    const { session: s2 } = await open(onRequest);
    expect(((await rejection(s2.request?.({ method: 'GET', path: '/' }) ?? Promise.reject(new Error('x')))) as AiBddError).code).toBe('DRIVER_ERROR');
    expect(((await rejection(s2.observe())) as AiBddError).code).toBe('DRIVER_ERROR');
  });
});

describe('rule matching and bookkeeping', () => {
  it('session and verb filters select calls; counters are per rule', async () => {
    const chaos = make([
      { at: 'observe', session: 2, fault: { kind: 'throw', code: 'DRIVER_ERROR', message: 'only session 2' } },
      { at: 'perform', verb: 'back', fault: { kind: 'fail', message: 'no back' } },
    ]);
    const driver = await chaos.create(CTX);
    const s1 = await driver.openSession(sessionOptions());
    const s2 = await driver.openSession(sessionOptions());
    await s1.observe();
    expect(((await rejection(s2.observe())) as AiBddError).message).toBe('only session 2');
    expect((await s1.perform({ verb: 'navigate', url: '/' })).ok).toBe(true);
    expect((await s1.perform({ verb: 'back' })).ok).toBe(false);
  });

  it('N consecutive failures, then success (from + times)', async () => {
    const chaos = make([{ at: 'openSession', from: 1, times: 3, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } }]);
    const driver = await chaos.create(CTX);
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await driver.openSession(sessionOptions()).then(() => 'ok', () => 'fail'));
    expect(outcomes).toEqual(['fail', 'fail', 'fail', 'ok', 'ok']);
  });

  it('is deterministic by seed: same plan, same events; another seed, other events', async () => {
    const run = async (seed: number | string): Promise<string> => {
      const chaos = make([{ at: 'observe', probability: 0.4, fault: { kind: 'throw', code: 'DRIVER_ERROR' } }], seed);
      const { session } = await open(chaos);
      const outcomes: string[] = [];
      for (let i = 0; i < 40; i += 1) outcomes.push(await session.observe().then(() => '.', () => 'x'));
      return outcomes.join('');
    };
    const a = await run('seed-a');
    expect(await run('seed-a')).toBe(a);
    expect(await run('seed-b')).not.toBe(a);
    expect(a).toContain('x');
    expect(a).toContain('.');
  });

  it('tracks sessions: opened, closed (even when close throws) and leaked', async () => {
    const chaos = make([{ at: 'close', session: 2, fault: { kind: 'throw-raw' } }]);
    const driver = await chaos.create(CTX);
    const [a, b, c] = [await driver.openSession(sessionOptions()), await driver.openSession(sessionOptions()), await driver.openSession(sessionOptions())];
    await a.close();
    await rejection(b.close());
    expect(chaos.stats.sessionsOpened).toEqual([a.id, b.id, c.id]);
    expect(chaos.stats.sessionsClosed).toEqual([a.id, b.id]);
    expect(chaos.stats.openSessions()).toEqual([c.id]);
    expect(chaos.stats.calls.close).toBe(2);
    expect(chaos.stats.driversCreated).toBe(1);
    await driver.dispose();
    expect(chaos.stats.driversDisposed).toBe(1);
  });

  it('onEvent sees every injected fault in order, with the rule index', async () => {
    const seen: string[] = [];
    const chaos = chaosDriver(
      fakeDriver(),
      { seed: 1, rules: [{ at: 'observe', nth: 2, fault: { kind: 'throw', code: 'DRIVER_ERROR' } }, { at: 'perform', fault: { kind: 'fail' } }] },
      { onEvent: (e) => seen.push(`${e.seq}:${e.at}:${e.rule}:${e.fault}`) },
    );
    const { session } = await open(chaos);
    await session.observe();
    await session.perform({ verb: 'back' });
    await rejection(session.observe());
    expect(seen).toEqual(['1:perform:1:fail', '2:observe:0:throw']);
  });
});
