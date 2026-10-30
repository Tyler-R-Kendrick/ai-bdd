import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import {
  DurableScheduler,
  type MaintenanceTick,
  type SchedulerDispatcher,
} from '../server/hosting/scheduler.ts';
import {
  assertInternalRequest,
  internalHeaders,
  assertCronSecret,
} from '../server/hosting/internal-auth.ts';
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture(postgres = false) {
  const schema = 'schedule_' + randomUUID().replaceAll('-', '');
  const store = await Store.open(
    postgres
      ? await openDatabase({
          adapter: 'postgres',
          url: process.env.STUDIO_TEST_POSTGRES_URL!,
          schema,
        })
      : ':memory:',
  );
  closers.push(() => store.close());
  let clock = Date.now();
  const deliveries: {
    tick: MaintenanceTick;
    dispatchId: string;
    delay: number;
  }[] = [];
  let offline = false;
  const dispatcher: SchedulerDispatcher = {
    provider: 'fixture',
    publish: async (tick, options) => {
      if (offline) throw new Error('network failed');
      deliveries.push({
        tick,
        dispatchId: options.dispatchId,
        delay: options.delaySeconds,
      });
    },
  };
  const scheduler = await new DurableScheduler(
    store,
    dispatcher,
    () => clock,
  ).initialize();
  return {
    store,
    scheduler,
    schema,
    dispatcher,
    deliveries,
    advance: () => (clock += 60_000),
    offline: (value: boolean) => (offline = value),
    clock: () => clock,
  };
}
describe('durable maintenance scheduling', () => {
  it('persists one successor before work and repeated delivery cannot fork a tick chain', async () => {
    const f = await fixture();
    await f.scheduler.activate('dpl_first');
    const first = f.deliveries[0]!;
    let work = 0;
    await f.scheduler.execute(first.tick, async () => {
      work++;
      expect(
        Number(
          (await f.store.one('SELECT count(*) AS n FROM studio_schedule_ticks'))
            .n,
        ),
      ).toBe(2);
    });
    await f.scheduler.execute(first.tick, async () => {
      work++;
    });
    expect(work).toBe(1);
    expect(f.deliveries).toHaveLength(2);
    expect(f.deliveries[1]!.delay).toBeGreaterThan(0);
    expect(f.deliveries[1]!.delay).toBeLessThanOrEqual(60);
  });
  it('recovers a publication after process loss and retires old deployment chains', async () => {
    const f = await fixture();
    f.offline(true);
    await expect(f.scheduler.activate('dpl_old')).rejects.toThrow(
      'temporarily',
    );
    const row = await f.store.one('SELECT id FROM studio_schedule_ticks');
    f.offline(false);
    const fresh = await new DurableScheduler(
      f.store,
      f.dispatcher,
      f.clock,
    ).initialize();
    await fresh.flush();
    expect(f.deliveries[0]!.dispatchId).toBe(row.id);
    await fresh.activate('dpl_new');
    let oldWork = 0;
    await fresh.execute(f.deliveries[0]!.tick, async () => {
      oldWork++;
    });
    expect(oldWork).toBe(0);
    await fresh.execute(f.deliveries[1]!.tick, async () => {});
    expect(
      Number(
        (await f.store.one('SELECT count(*) AS n FROM studio_schedule')).n,
      ),
    ).toBe(1);
  });
  it('retries failed maintenance with the same successor intent', async () => {
    const f = await fixture();
    await f.scheduler.activate('dpl_current');
    const first = f.deliveries[0]!.tick;
    await expect(
      f.scheduler.execute(first, async () => {
        throw new Error('database unavailable');
      }),
    ).rejects.toThrow();
    await f.scheduler.execute(first, async () => {});
    expect(f.deliveries).toHaveLength(2);
    expect(
      Number(
        (await f.store.one('SELECT count(*) AS n FROM studio_schedule_ticks'))
          .n,
      ),
    ).toBe(2);
  });
  it.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL)(
    'claims a single tick across independent PostgreSQL instances',
    async () => {
      const f = await fixture(true),
        second = await Store.open(
          await openDatabase({
            adapter: 'postgres',
            url: process.env.STUDIO_TEST_POSTGRES_URL!,
            schema: f.schema,
          }),
        );
      closers.push(() => second.close());
      const scheduler = await new DurableScheduler(
        second,
        f.dispatcher,
        f.clock,
      ).initialize();
      await Promise.all([
        f.scheduler.activate('dpl_same'),
        scheduler.activate('dpl_same'),
      ]);
      expect(f.deliveries).toHaveLength(1);
      let calls = 0,
        release!: () => void,
        entered!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve)),
        ready = new Promise<void>((resolve) => (entered = resolve));
      const running = f.scheduler.execute(f.deliveries[0]!.tick, async () => {
        calls++;
        entered();
        await gate;
      });
      await ready;
      await expect(
        scheduler.execute(f.deliveries[0]!.tick, async () => {
          calls++;
        }),
      ).rejects.toThrow('leased');
      release();
      await running;
      expect(calls).toBe(1);
    },
  );
});
describe('internal service request authorization', () => {
  it('binds method/path/timestamp/body and rejects stale/mutated/public calls', () => {
    const secret = 'fixture-32-character-job-secret-123456789',
      path = '/internal/jobs/execute',
      body = '{"jobId":"a"}',
      now = Date.now(),
      headers = internalHeaders(secret, path, body, now),
      values = {
        time: headers['x-studio-time'],
        signature: headers['x-studio-signature'],
      };
    expect(() =>
      assertInternalRequest(secret, path, body, values, now),
    ).not.toThrow();
    for (const [p, b, t] of [
      [path, body + 'x', now],
      [path + 'x', body, now],
      [path, body, now + 61_000],
    ] as const)
      expect(() => assertInternalRequest(secret, p, b, values, t)).toThrow(
        'authorization',
      );
    expect(() => assertCronSecret(secret, 'Bearer ' + secret)).not.toThrow();
    expect(() => assertCronSecret(secret, 'Bearer nope')).toThrow(
      'authorization',
    );
    expect(() => assertInternalRequest(secret, path, body, {}, now)).toThrow();
  });
});
