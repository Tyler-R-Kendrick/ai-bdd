// @ts-nocheck
import { AiBddError } from '../contracts/index.ts';

function abortError(): AiBddError {
  return new AiBddError('ABORTED', 'run aborted while waiting for a session slot');
}

/**
 * FIFO counting semaphore (in-process async mutex when `limit` is 1).
 * Waiters are served in arrival order; an abort signal removes a waiter from the queue.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: { grant(): void }[] = [];

  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortError());
      };
      const waiter = {
        grant: (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.makeRelease());
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.available += 1;
    };
  }
}
