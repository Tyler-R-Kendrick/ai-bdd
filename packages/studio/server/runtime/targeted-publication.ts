import { OutboxDispatchPendingError } from './jobs.ts';
import type { DurableJobRuntime } from './contracts.ts';

type Failure = 'outbox-pending' | 'dispatch-failed' | 'shutdown-timeout';
/** Best-effort latency improvement only: every ID already has a durable SQL outbox intent. */
export function createTargetedPublication(options: {
  runtime: Pick<DurableJobRuntime, 'flushOutbox'>;
  onError?: (category: Failure) => void;
  concurrency?: number;
  drainMs?: number;
}) {
  const concurrency = options.concurrency ?? 2,
    drainMs = options.drainMs ?? 2000,
    active = new Set<Promise<void>>(),
    queued: string[] = [],
    known = new Set<string>();
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Targeted dispatch concurrency must be between1 and8');
  if (!Number.isInteger(drainMs) || drainMs < 1 || drainMs > 5000)
    throw new Error('Targeted dispatch drain must be between1 and5000ms');
  let closing = false;
  const notify = (category: Failure) => {
    try {
      options.onError?.(category);
    } catch {}
  };
  const pump = () => {
    while (!closing && queued.length && active.size < concurrency) {
      const id = queued.shift()!;
      const pending = new Promise<void>((resolve) => {
        setImmediate(resolve);
      })
        .then(() => options.runtime.flushOutbox(1, id))
        .catch((error) =>
          notify(
            error instanceof OutboxDispatchPendingError
              ? 'outbox-pending'
              : 'dispatch-failed',
          ),
        )
        .finally(() => {
          active.delete(pending);
          known.delete(id);
          pump();
        });
      active.add(pending);
    }
  };
  return {
    publish(ids: readonly string[]) {
      if (closing) return;
      for (const id of [...new Set(ids)].slice(0, 8)) {
        if (known.has(id)) continue;
        if (known.size >= 8) break;
        if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
        known.add(id);
        queued.push(id);
      }
      pump();
    },
    async close() {
      closing = true;
      queued.length = 0;
      known.clear();
      if (!active.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        Promise.allSettled([...active]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), drainMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained) notify('shutdown-timeout');
      // A hung provider is not labelled cancelled. Its SQL dispatch lease expires
      // and another maintenance instance can reconcile the same stable intent.
    },
  };
}
