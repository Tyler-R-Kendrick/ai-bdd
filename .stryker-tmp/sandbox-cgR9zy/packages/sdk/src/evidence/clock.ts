// @ts-nocheck
import { AiBddError, type Clock } from '../contracts/index.ts';

/** Real wall clock. `sleep` rejects with ABORTED when the signal fires (or already fired). */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new AiBddError('ABORTED', 'aborted'));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new AiBddError('ABORTED', 'aborted'));
      };
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
