import type { DriverFactory, DriverSession } from '@ai-bdd/sdk/contracts';
import { realSleep } from './clock.ts';

export interface SessionInterval {
  scenarioId: string;
  start: number;
  end: number;
}

/**
 * Wraps a driver factory and logs when each session is opened and closed. Every observe/perform yields ~2 ms of real
 * time so that scenarios that are allowed to run concurrently really do overlap.
 */
export function timingLog(opts: { delayMs?: number } = {}): { wrap(inner: DriverFactory): DriverFactory; intervals: SessionInterval[]; maxConcurrentScenarios(): number; maxConcurrentSessions(): number } {
  const intervals: SessionInterval[] = [];
  const delay = opts.delayMs ?? 2;
  const now = (): number => performance.now();

  function wrapSession(s: DriverSession, rec: SessionInterval): DriverSession {
    return {
      id: s.id,
      driverId: s.driverId,
      driverVersion: s.driverVersion,
      capabilities: s.capabilities,
      async observe(o) {
        await realSleep(delay);
        return s.observe(o);
      },
      async perform(a) {
        await realSleep(delay);
        return s.perform(a);
      },
      ...(s.request === undefined ? {} : { request: (r: Parameters<NonNullable<DriverSession['request']>>[0]) => (s.request as NonNullable<DriverSession['request']>)(r) }),
      async close() {
        try {
          await s.close();
        } finally {
          rec.end = now();
        }
      },
    };
  }

  function maxOverlap(keyOf: (i: SessionInterval, idx: number) => string): number {
    const points: { t: number; d: 1 | -1; k: string }[] = [];
    intervals.forEach((i, idx) => {
      const end = i.end === 0 ? now() : i.end;
      points.push({ t: i.start, d: 1, k: keyOf(i, idx) }, { t: end, d: -1, k: keyOf(i, idx) });
    });
    // closes sort before opens at equal timestamps
    points.sort((a, b) => a.t - b.t || a.d - b.d);
    const active = new Map<string, number>();
    let max = 0;
    for (const p of points) {
      active.set(p.k, (active.get(p.k) ?? 0) + p.d);
      if ((active.get(p.k) ?? 0) === 0) active.delete(p.k);
      max = Math.max(max, active.size);
    }
    return max;
  }

  return {
    intervals,
    /** how many distinct scenarios held a session at the same time (sessions of one scenario, e.g. a confirm run, count once) */
    maxConcurrentScenarios: () => maxOverlap((i) => i.scenarioId),
    /** how many sessions were open at the same time */
    maxConcurrentSessions: () => maxOverlap((_i, idx) => String(idx)),
    wrap(inner) {
      return {
        id: inner.id,
        async create(ctx) {
          const driver = await inner.create(ctx);
          return {
            id: driver.id,
            version: driver.version,
            capabilities: driver.capabilities,
            selfCheck: () => driver.selfCheck(),
            dispose: () => driver.dispose(),
            async openSession(o) {
              const rec: SessionInterval = { scenarioId: o.scenarioId, start: now(), end: 0 };
              intervals.push(rec);
              const s = await driver.openSession(o);
              return wrapSession(s, rec);
            },
          };
        },
      };
    },
  };
}
