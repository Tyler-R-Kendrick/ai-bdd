import { describe, expect, it } from 'vitest';
import type { ScenarioTarget } from '../../src/contracts/index.ts';
import { createHarness, mkTarget, thenStep, when, type Harness } from './doubles/harness.ts';
import { FakeDriver, type FakeSession } from './doubles/world.ts';

const GO = 'the user clicks Upgrade to Pro';
const SEES = 'Plan: Pro';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Probe {
  active: number;
  max: number;
  log: string[];
  hooks: { onOpen(s: FakeSession): void; onClose(s: FakeSession): void };
}

function probe(): Probe {
  const p: Probe = {
    active: 0,
    max: 0,
    log: [],
    hooks: {
      onOpen: (s) => {
        p.active += 1;
        p.max = Math.max(p.max, p.active);
        p.log.push(`open ${s.options.scenarioId}`);
      },
      onClose: (s) => {
        p.active -= 1;
        p.log.push(`close ${s.options.scenarioId}`);
      },
    },
  };
  return p;
}

function targets(n: number, over: (i: number) => Partial<ScenarioTarget['scenario']> = () => ({})): ScenarioTarget[] {
  return Array.from({ length: n }, (_, i) =>
    mkTarget([when(GO), thenStep(SEES)], { id: `billing/scenario-${i}`, title: `Scenario ${i}`, ...over(i) }),
  );
}

function slowHarness(driverOpts: ConstructorParameters<typeof FakeDriver>[0] = {}, delay = 8): Harness {
  const h = createHarness({ steps: [when(GO), thenStep(SEES)], driver: driverOpts });
  h.effectShows(GO, SEES);
  const succeed = h.actor.handler;
  h.actor.handler = async (req, session, n, w) => {
    await sleep(delay);
    return succeed(req, session, n, w);
  };
  return h;
}

const baseOpts = { updateRecordings: false, strict: false, noAgent: false, audit: false };

describe('runAll scheduling (§9.8)', () => {
  it('R-RN2: results are in selection order regardless of completion order', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    const succeed = h.actor.handler;
    h.actor.handler = async (req, session, n, w) => {
      const idx = Number((session as FakeSession).options.scenarioId.split('-').pop());
      await sleep((3 - idx) * 15);
      return succeed(req, session, n, w);
    };
    const list = targets(4);
    const results = await h.runner.runAll(list, { ...baseOpts, workers: 4 });
    expect(results.map((r) => r.scenarioId)).toEqual(list.map((t) => t.scenario.id));
    const finished = h.events.filter((e) => e.type === 'scenario-end').map((e) => (e.type === 'scenario-end' ? e.result.scenarioId : ''));
    expect(finished).not.toEqual(list.map((t) => t.scenario.id)); // they really did overlap and finish out of order
    expect(results.every((r) => r.status === 'passed')).toBe(true);
  });

  it('R-RN2: at most `workers` scenarios run at once', async () => {
    const p = probe();
    const h = slowHarness(p.hooks);
    await h.runner.runAll(targets(6), { ...baseOpts, workers: 2 });
    expect(p.max).toBe(2);
  });

  it('R-RN2: workers <= 0, NaN or a lone scenario still run (as one worker)', async () => {
    const p = probe();
    const h = slowHarness(p.hooks);
    const res = await h.runner.runAll(targets(3), { ...baseOpts, workers: 0 });
    expect(res).toHaveLength(3);
    expect(p.max).toBe(1);
    expect(await h.runner.runAll([], { ...baseOpts, workers: 4 })).toEqual([]);
    expect((await h.runner.runAll(targets(1), { ...baseOpts, workers: Number.NaN })).length).toBe(1);
  });

  it('R-RN2: capabilities.maxSessions caps a driver below the worker count', async () => {
    const p = probe();
    const h = slowHarness({ ...p.hooks, maxSessions: 1 });
    await h.runner.runAll(targets(5), { ...baseOpts, workers: 5 });
    expect(p.max).toBe(1);
  });

  it('R-RN2: maxSessions 3 allows exactly three concurrent sessions', async () => {
    const p = probe();
    const h = slowHarness({ ...p.hooks, maxSessions: 3 });
    await h.runner.runAll(targets(8), { ...baseOpts, workers: 8 });
    expect(p.max).toBe(3);
  });

  it('R-RN2: without exclusiveResource the same workload overlaps (control for the next test)', async () => {
    const p = probe();
    const h = slowHarness(p.hooks);
    await h.runner.runAll(targets(4), { ...baseOpts, workers: 4 });
    expect(p.max).toBeGreaterThan(1);
  });

  it('R-RN2: sessions that declare the same exclusiveResource never overlap (timing log shows strict alternation)', async () => {
    const p = probe();
    const h = slowHarness({ ...p.hooks, exclusiveResource: 'sqlite-file' });
    const results = await h.runner.runAll(targets(4), { ...baseOpts, workers: 4 });
    expect(results.every((r) => r.status === 'passed')).toBe(true);
    expect(p.max).toBe(1);
    // every open is immediately followed by the close of the same session
    for (let i = 0; i < p.log.length; i += 2) {
      expect(p.log[i]?.startsWith('open ')).toBe(true);
      expect(p.log[i + 1]?.startsWith('close ')).toBe(true);
    }
  });

  it('R-RN2: a scenario holds the resource for its confirm run too (no other scenario slips in between)', async () => {
    const p = probe();
    const h = slowHarness({ ...p.hooks, exclusiveResource: 'db' });
    await h.runner.runAll(targets(3), { ...baseOpts, workers: 3 });
    // each scenario opens two sessions (characterize + confirm); the ids in the log come in adjacent pairs
    const opens = p.log.filter((l) => l.startsWith('open ')).map((l) => l.slice(5));
    for (let i = 0; i < opens.length; i += 2) expect(opens[i]).toBe(opens[i + 1]);
  });

  it('R-RN2: two drivers declaring the same resource string serialize jointly; different strings run in parallel', async () => {
    const p = probe();
    const a = new FakeDriver({ id: 'a', exclusiveResource: 'shared', ...p.hooks });
    const b = new FakeDriver({ id: 'b', exclusiveResource: 'shared', ...p.hooks });
    const h = slowHarness();
    (h.deps.drivers as Map<string, FakeDriver>).set('a', a);
    (h.deps.drivers as Map<string, FakeDriver>).set('b', b);
    await h.runner.runAll(targets(4, (i) => ({ driver: i % 2 === 0 ? 'a' : 'b' })), { ...baseOpts, workers: 4 });
    expect(p.max).toBe(1);

    const q = probe();
    const c = new FakeDriver({ id: 'c', exclusiveResource: 'one', ...q.hooks });
    const d = new FakeDriver({ id: 'd', exclusiveResource: 'two', ...q.hooks });
    const h2 = slowHarness();
    (h2.deps.drivers as Map<string, FakeDriver>).set('c', c);
    (h2.deps.drivers as Map<string, FakeDriver>).set('d', d);
    await h2.runner.runAll(targets(4, (i) => ({ driver: i % 2 === 0 ? 'c' : 'd' })), { ...baseOpts, workers: 4 });
    expect(q.max).toBe(2);
  });

  it('R-RN2: runScenario called concurrently on one runner honours the exclusive resource too', async () => {
    const p = probe();
    const h = slowHarness({ ...p.hooks, exclusiveResource: 'r' });
    const [t1, t2, t3] = targets(3);
    await Promise.all([h.runner.runScenario(t1!, baseOpts), h.runner.runScenario(t2!, baseOpts), h.runner.runScenario(t3!, baseOpts)]);
    expect(p.max).toBe(1);
  });

  it('R-RN2: every scenario gets its own session and its own page (no state leakage)', async () => {
    const h = slowHarness();
    await h.runner.runAll(targets(5), { ...baseOpts, workers: 5 });
    const ids = h.driver.sessions.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const worlds = new Set(h.driver.sessions.map((s) => s.world));
    expect(worlds.size).toBe(ids.length);
    const scenarios = h.driver.sessions.map((s) => s.options.scenarioId);
    for (const t of targets(5)) expect(scenarios.filter((s) => s === t.scenario.id).length).toBe(2); // characterize + confirm
  });

  it('R-RN2: a crashing scenario does not affect the others; its result is an error in place', async () => {
    const h = slowHarness();
    const succeed = h.actor.handler;
    h.actor.handler = (req, session, n, w) => {
      if ((session as FakeSession).options.scenarioId.endsWith('-1')) throw new Error('driver crashed');
      return succeed(req, session, n, w);
    };
    const results = await h.runner.runAll(targets(3), { ...baseOpts, workers: 3 });
    expect(results.map((r) => r.status)).toEqual(['passed', 'error', 'passed']);
    expect(results[1]?.error?.code).toBe('INTERNAL');
  });

  it('R-RN2: a driver that fails to open for one scenario leaves the rest running', async () => {
    const h = slowHarness();
    const original = h.driver.openSession.bind(h.driver);
    h.driver.openSession = (o) => (o.scenarioId.endsWith('-0') ? Promise.reject(new Error('no browser')) : original(o));
    const results = await h.runner.runAll(targets(3), { ...baseOpts, workers: 3 });
    expect(results.map((r) => r.status)).toEqual(['error', 'passed', 'passed']);
  });

  it('R-RN3: a pre-aborted signal yields an ABORTED error per scenario, in order, without opening sessions', async () => {
    const h = slowHarness();
    const c = new AbortController();
    c.abort();
    const list = targets(3);
    const results = await h.runner.runAll(list, { ...baseOpts, workers: 3, signal: c.signal });
    expect(results.map((r) => r.scenarioId)).toEqual(list.map((t) => t.scenario.id));
    expect(results.every((r) => r.status === 'error' && r.error?.code === 'ABORTED')).toBe(true);
    expect(h.driver.sessions).toHaveLength(0);
  });

  it('R-RN3: aborting while a scenario waits for an exclusive resource yields ABORTED for the waiter only', async () => {
    const h = slowHarness({ exclusiveResource: 'r' }, 40);
    const c = new AbortController();
    const [t1, t2] = targets(2);
    const first = h.runner.runScenario(t1!, baseOpts);
    await sleep(5);
    const second = h.runner.runScenario(t2!, { ...baseOpts, signal: c.signal });
    await sleep(5);
    c.abort();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe('passed');
    expect(r2.status).toBe('error');
    expect(r2.error?.code).toBe('ABORTED');
  });
});
