import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTargetedPublication } from '../server/runtime/targeted-publication.ts';
import { OutboxDispatchPendingError } from '../server/runtime/jobs.ts';

describe('bounded post-response targeted publication', () => {
  it('publishes only explicit unique IDs on the next event-loop turn and drains healthy queued follow-ups', async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID()),
      flushOutbox = vi.fn(async () => {}),
      publisher = createTargetedPublication({ runtime: { flushOutbox } });
    publisher.publish([...ids, ids[0]!]);
    expect(flushOutbox).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(flushOutbox).toHaveBeenCalledTimes(4));
    expect(flushOutbox.mock.calls).toEqual(ids.map((id) => [1, id]));
    await publisher.close();
  });
  it('bounds retained work and shutdown while never-resolving providers leave durable maintenance responsible', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }),
      flushOutbox = vi.fn(async () => gate),
      onError = vi.fn(),
      publisher = createTargetedPublication({ runtime: { flushOutbox }, onError, drainMs: 10 }),
      ids = Array.from({ length: 12 }, () => randomUUID());
    publisher.publish(ids);
    await vi.waitFor(() => expect(flushOutbox).toHaveBeenCalledTimes(2));
    await publisher.close();
    expect(onError.mock.calls).toEqual([['shutdown-timeout']]);
    publisher.publish([randomUUID()]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushOutbox).toHaveBeenCalledTimes(2);
  });
  it('logs finite categories and never forwards provider error contents or rejected logging callbacks', async () => {
    const categories: string[] = [],
      errors = [new OutboxDispatchPendingError(1), new Error('fixture-private-credential-detail')],
      flushOutbox = vi.fn(async () => { throw errors.shift(); }),
      publisher = createTargetedPublication({ runtime: { flushOutbox }, onError: (category) => { categories.push(category); throw new Error('logger rejected'); } });
    publisher.publish([randomUUID(), randomUUID()]);
    await vi.waitFor(() => expect(categories).toHaveLength(2));
    await publisher.close();
    expect(categories).toEqual(['outbox-pending', 'dispatch-failed']);
  });
});
