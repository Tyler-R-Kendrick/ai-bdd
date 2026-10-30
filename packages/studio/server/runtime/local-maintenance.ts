import type { DurableJobRuntime } from './contracts.ts';

/** Long-lived Node scheduling only; hosted runtimes use their authenticated platform scheduler. */
export function createLocalMaintenance(options: {
  maintenance: () => Promise<void>;
  runtime: Pick<DurableJobRuntime, 'recover' | 'flushOutbox'>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const interval = options.intervalMs ?? 15000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60000)
    throw new Error(
      'Local maintenance interval must be between 1 and 60000 ms',
    );
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let closing = false;
  const run = () => {
    if (closing) return Promise.resolve();
    if (inFlight) return inFlight;
    const cycle = async () => {
      for (const operation of [
        options.maintenance,
        () => options.runtime.recover({ dispatchLimit: 5 }),
        () => options.runtime.flushOutbox(5),
      ]) {
        if (closing) break;
        try {
          await operation();
        } catch (error) {
          // A domain cleanup failure must not starve durable recovery or create an unhandled timer rejection.
          try {
            options.onError?.(error);
          } catch {}
        }
      }
    };
    inFlight = cycle().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  return {
    run,
    start() {
      if (closing) throw new Error('Local maintenance is closed');
      if (timer) return;
      timer = setInterval(() => {
        void run();
      }, interval);
      timer.unref();
      void run();
    },
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
