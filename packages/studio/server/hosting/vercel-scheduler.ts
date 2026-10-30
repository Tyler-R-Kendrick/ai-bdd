import {
  reportProviderFailure,
  type ProviderFailureReporter,
} from './provider-diagnostics.ts';
import { dispatchDeadline } from './deadline.ts';
import {
  runWithIdentity,
  type IdentityExecutionContext,
} from './identity-context.ts';
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
  readonly #onFailure?: ProviderFailureReporter;
  readonly #identity?: IdentityExecutionContext;
  constructor(options: {
    region: string;
    client?: QueueTransport;
    onFailure?: ProviderFailureReporter;
    identityExecutionContext?: IdentityExecutionContext;
  }) {
    this.#onFailure = options.onFailure;
    this.#identity = options.identityExecutionContext;
    this.#client =
      options.client ??
      new QueueClient({ region: options.region as VercelRegion });
  }
  async publish(
    tick: MaintenanceTick,
    options: { dispatchId: string; delaySeconds: number },
  ) {
    maintenanceEnvelope.parse(tick);
    try {
      await dispatchDeadline(
        runWithIdentity(this.#identity, () =>
          this.#client.send(MAINTENANCE_TOPIC, tick, {
            idempotencyKey: 'studio-tick:' + options.dispatchId,
            retentionSeconds: 86400,
            delaySeconds: options.delaySeconds,
          }),
        ),
      );
    } catch (error) {
      reportProviderFailure(this.#onFailure, 'maintenance-publish', error);
      throw error;
    }
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
