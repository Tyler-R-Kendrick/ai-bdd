import { AiBddError, type Clock } from '@ai-bdd/sdk/contracts';

/**
 * A virtual clock: `sleep(ms)` advances `now()` by `ms` and returns after yielding one macrotask, so settle windows,
 * probe waits and the fake driver's 100 ms-per-observe clock all run at full speed and deterministically.
 */
export function virtualClock(start = Date.UTC(2026, 9, 10, 12, 0, 0)): Clock & { elapsed(): number } {
  let t = start;
  return {
    now: () => t,
    elapsed: () => t - start,
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted === true) throw new AiBddError('ABORTED', 'aborted');
      t += Math.max(0, ms);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
