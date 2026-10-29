import { QueueClient, type VercelRegion } from '@vercel/queue';
import {
  MAINTENANCE_TOPIC,
  maintenanceEnvelope,
  type MaintenanceTick,
  type SchedulerDispatcher,
} from './scheduler.ts';
import type { QueueTransport } from './vercel-queue.ts';
export class VercelSchedulerDispatcher implements SchedulerDispatcher {
  readonly provider = 'vercel-queue';
  readonly #client: QueueTransport;
  constructor(options: { region: string; client?: QueueTransport }) {
    this.#client =
      options.client ??
      new QueueClient({ region: options.region as VercelRegion });
  }
  async publish(
    tick: MaintenanceTick,
    options: { dispatchId: string; delaySeconds: number },
  ) {
    maintenanceEnvelope.parse(tick);
    await this.#client.send(MAINTENANCE_TOPIC, tick, {
      idempotencyKey: 'studio-tick:' + options.dispatchId,
      retentionSeconds: 86400,
      delaySeconds: options.delaySeconds,
    });
  }
}
export function createMaintenanceCallback(options: {
  region: string;
  execute: (tick: MaintenanceTick) => Promise<void>;
  client?: QueueTransport;
}) {
  const client =
    options.client ??
    new QueueClient({ region: options.region as VercelRegion });
  return client.handleCallback(
    async (input: unknown, metadata) => {
      const tick = maintenanceEnvelope.safeParse(input);
      if (!tick.success || metadata.topicName !== MAINTENANCE_TOPIC) return;
      await options.execute(tick.data);
    },
    { visibilityTimeoutSeconds: 120, retry: () => ({ afterSeconds: 30 }) },
  );
}
