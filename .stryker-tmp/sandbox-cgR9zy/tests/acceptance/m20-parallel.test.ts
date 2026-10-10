// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { expectParallelPassed, flowParallel } from './helpers/flows.ts';
import { fakeTarget } from './helpers/targets.ts';

describe('M20 eight scenarios, --workers 8 (fake driver)', () => {
  it('M20 R-RN2: eight scenarios run concurrently in isolated sessions without state leakage and are reported in selection order', async () => {
    const res = await flowParallel(fakeTarget, { workers: 8 });
    expectParallelPassed(res);
    expect(res.maxConcurrentScenarios).toBeGreaterThan(1);
  });

  it('M20 R-RN2: sessions that declare the same exclusiveResource never overlap (timing log)', async () => {
    const res = await flowParallel(fakeTarget, { workers: 8, exclusiveResource: 'acme-database' });
    expectParallelPassed(res);
    expect(res.maxConcurrentScenarios).toBe(1);
  });

  it('M20 R-RN2: maxSessions caps the number of simultaneously open sessions', { timeout: 90_000 }, async () => {
    const res = await flowParallel(fakeTarget, { workers: 8, maxSessions: 2 });
    expectParallelPassed(res);
    expect(res.maxConcurrentSessions).toBeLessThanOrEqual(2);
  });
});
