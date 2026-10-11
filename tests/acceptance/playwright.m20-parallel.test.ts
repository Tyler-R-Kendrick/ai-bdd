import { beforeAll, expect, it } from 'vitest';
import { statusSummary } from './helpers/engine.ts';
import { expectParallelPassed, flowParallel, type ParallelRuns } from './helpers/flows.ts';
import { describePlaywright } from './helpers/parity.ts';
import { fakeTarget, playwrightTarget } from './helpers/targets.ts';

describePlaywright('M20 [P] eight scenarios, --workers 8, real Chromium sessions', () => {
  let fake: ParallelRuns;
  let pw: ParallelRuns;
  beforeAll(async () => {
    fake = await flowParallel(fakeTarget, { workers: 8 });
    pw = await flowParallel(playwrightTarget, { workers: 8 });
  }, 400_000);

  it('M20 [P] R-RN2: eight isolated browser contexts run concurrently without cookie or state leakage; statuses equal the fake run', () => {
    expectParallelPassed(pw);
    expect(pw.maxConcurrentScenarios).toBeGreaterThan(1);
    expect(pw.results.map(statusSummary)).toEqual(fake.results.map(statusSummary));
  });
});
