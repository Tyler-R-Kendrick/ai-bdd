import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/evidence/index.ts';

describe('systemClock (R-RN1)', () => {
  it('R-RN1 now() tracks wall time and sleep resolves', async () => {
    const t0 = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(t0);
  });

  it('R-RN1 sleep rejects with ABORTED for an already-aborted signal and when aborted mid-sleep', async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(systemClock.sleep(1000, pre.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    const mid = new AbortController();
    const p = systemClock.sleep(10_000, mid.signal);
    mid.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
