import { randomUUID } from 'node:crypto';
import type { JobDispatcher, JobExecutor } from './ports.ts';
/** Local transport only. SQL snapshots/outbox remain owned by the durable coordinator. */
export class LocalJobDispatcher implements JobDispatcher {
  readonly provider = 'local';
  private executor?: JobExecutor;
  private closed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly active = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  bind(executor: JobExecutor) {
    if (this.executor) throw new Error('Local job executor is already bound.');
    this.executor = executor;
    return this;
  }
  async publish(
    jobId: string,
    options: { delaySeconds?: number; dispatchId?: string } = {},
  ) {
    if (this.closed || !this.executor)
      throw new Error('Local job transport is unavailable.');
    const messageId = options.dispatchId ?? randomUUID(),
      delay = (options.delaySeconds ?? 0) * 1000;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 86_400_000)
      throw new Error('Invalid local dispatch delay.');
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      const running = this.executor!(jobId, {
        messageId,
        deliveryCount: 1,
        signal: this.abort.signal,
      })
        .catch(() => {
          /* Durable coordinator records retry/error; startup and maintenance reconcile it. */
        })
        .finally(() => this.active.delete(running));
      this.active.add(running);
    }, delay);
    timer.unref();
    this.timers.add(timer);
    return { provider: this.provider, messageId };
  }
  async close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.abort.abort(new Error('Local worker is stopping.'));
    await Promise.allSettled([...this.active]);
  }
}
