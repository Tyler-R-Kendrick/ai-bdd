import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { z } from 'zod';
export const MAINTENANCE_TOPIC = 'studio-maintenance-v1';
export const maintenanceEnvelope = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.string().uuid(),
    bucket: z.number().int().nonnegative(),
  })
  .strict();
export type MaintenanceTick = z.infer<typeof maintenanceEnvelope>;
export interface SchedulerDispatcher {
  readonly provider: string;
  publish(
    tick: MaintenanceTick,
    options: { dispatchId: string; delaySeconds: number },
  ): Promise<void>;
}
/** SQL holds the one active deployment generation and every next-tick publication intent. */
export class DurableScheduler {
  constructor(
    readonly store: Store,
    readonly dispatcher: SchedulerDispatcher,
    readonly clock: () => number = Date.now,
  ) {}
  async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:hosting-scheduler');
      await this.store.db.exec(
        `CREATE TABLE IF NOT EXISTS studio_schedule(id TEXT PRIMARY KEY,deployment_id TEXT NOT NULL,generation TEXT NOT NULL);CREATE TABLE IF NOT EXISTS studio_schedule_ticks(id TEXT PRIMARY KEY,generation TEXT NOT NULL,bucket BIGINT NOT NULL,status TEXT NOT NULL,lease_until BIGINT NOT NULL DEFAULT 0,dispatched INTEGER NOT NULL DEFAULT 0,UNIQUE(generation,bucket));`,
      );
    });
    return this;
  }
  private async insert(generation: string, bucket: number) {
    const existing = await this.store.one(
      'SELECT id FROM studio_schedule_ticks WHERE generation=? AND bucket=?',
      generation,
      bucket,
    );
    if (!existing)
      await this.store.exec(
        'INSERT INTO studio_schedule_ticks(id,generation,bucket,status,lease_until,dispatched) VALUES(?,?,?,?,?,?)',
        randomUUID(),
        generation,
        bucket,
        'pending',
        0,
        0,
      );
  }
  async activate(deploymentId: string) {
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(deploymentId))
      throw new Error(
        'A trusted deployment identity is required for maintenance.',
      );
    await this.store.tx(async () => {
      await this.store.db.lock('hosting:schedule');
      const current = await this.store.one(
        'SELECT * FROM studio_schedule WHERE id=?',
        'maintenance',
      );
      const generation =
        current?.deployment_id === deploymentId
          ? current.generation
          : randomUUID();
      if (!current)
        await this.store.exec(
          'INSERT INTO studio_schedule(id,deployment_id,generation) VALUES(?,?,?)',
          'maintenance',
          deploymentId,
          generation,
        );
      else if (current.generation !== generation)
        await this.store.exec(
          'UPDATE studio_schedule SET deployment_id=?,generation=? WHERE id=?',
          deploymentId,
          generation,
          'maintenance',
        );
      await this.insert(generation, Math.floor(this.clock() / 60_000));
    });
    await this.flush(1);
  }
  async flush(limit = 5) {
    // Re-publish uncertain intents after a bounded lease using their same provider idempotency key.
    const rows = await this.store.all(
      'SELECT t.* FROM studio_schedule_ticks t JOIN studio_schedule s ON s.generation=t.generation WHERE t.dispatched=0 AND t.lease_until<? ORDER BY t.bucket LIMIT ?',
      this.clock(),
      Math.min(20, Math.max(1, limit)),
    );
    for (const row of rows) {
      const lease = this.clock() + 30_000;
      const claimed = await this.store.tx(async () => {
        await this.store.db.lock('hosting:schedule');
        const result = await this.store.db.run(
          'UPDATE studio_schedule_ticks SET lease_until=? WHERE id=? AND dispatched=0 AND lease_until<? AND generation=(SELECT generation FROM studio_schedule WHERE id=?)',
          [lease, row.id, this.clock(), 'maintenance'],
        );
        return result.changes === 1;
      });
      if (!claimed) continue;
      try {
        await this.dispatcher.publish(
          {
            schemaVersion: 1,
            generation: row.generation,
            bucket: Number(row.bucket),
          },
          {
            dispatchId: row.id,
            delaySeconds: Math.max(
              0,
              Math.min(
                60,
                Math.ceil((Number(row.bucket) * 60_000 - this.clock()) / 1000),
              ),
            ),
          },
        );
        await this.store.exec(
          'UPDATE studio_schedule_ticks SET dispatched=1,lease_until=0 WHERE id=? AND lease_until=?',
          row.id,
          lease,
        );
      } catch {
        await this.store.exec(
          'UPDATE studio_schedule_ticks SET lease_until=0 WHERE id=? AND lease_until=?',
          row.id,
          lease,
        );
        throw new Error('Maintenance dispatch is temporarily unavailable.');
      }
    }
  }
  async execute(input: unknown, maintenance: () => Promise<void>) {
    const tick = maintenanceEnvelope.parse(input),
      now = this.clock();
    if (tick.bucket > Math.floor(now / 60_000) + 1)
      throw new Error('Maintenance tick arrived before its bounded schedule.');
    const claim = await this.store.tx(async () => {
      await this.store.db.lock('hosting:schedule');
      const active = await this.store.one(
        'SELECT generation FROM studio_schedule WHERE id=?',
        'maintenance',
      );
      if (active?.generation !== tick.generation) return null;
      const row = await this.store.one(
        'SELECT * FROM studio_schedule_ticks WHERE generation=? AND bucket=?',
        tick.generation,
        tick.bucket,
      );
      if (!row || row.status === 'complete') return null;
      if (Number(row.lease_until) > now)
        throw new Error('Maintenance tick is already leased.');
      const lease = now + 120_000;
      await this.store.exec(
        "UPDATE studio_schedule_ticks SET status='running',lease_until=? WHERE id=?",
        lease,
        row.id,
      );
      // Persist the sole successor before acknowledging or doing any domain work. Catch-up skips missed minutes.
      await this.insert(
        tick.generation,
        Math.max(tick.bucket + 1, Math.floor(now / 60_000) + 1),
      );
      return { id: row.id, lease };
    });
    if (!claim) return;
    try {
      await this.flush(1);
      await maintenance();
      await this.store.exec(
        "UPDATE studio_schedule_ticks SET status='complete',lease_until=0 WHERE id=? AND lease_until=?",
        claim.id,
        claim.lease,
      );
      await this.store.exec(
        'DELETE FROM studio_schedule_ticks WHERE bucket<? AND (status=? OR generation<>(SELECT generation FROM studio_schedule WHERE id=?))',
        Math.floor(this.clock() / 60_000) - 2 * 24 * 60,
        'complete',
        'maintenance',
      );
    } catch (error) {
      await this.store.exec(
        "UPDATE studio_schedule_ticks SET status='pending',lease_until=0 WHERE id=? AND lease_until=?",
        claim.id,
        claim.lease,
      );
      throw error;
    }
  }
}
