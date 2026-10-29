import {
  QueueClient,
  type MessageMetadata,
  type VercelRegion,
} from '@vercel/queue';
import { z } from 'zod';
import { STUDIO_QUEUE_TOPIC } from './config.ts';
import type { DispatchReceipt, JobDispatcher, JobExecutor } from './ports.ts';

const jobIdSchema = z.string().uuid();
export const jobEnvelopeSchema = z
  .object({ schemaVersion: z.literal(1), jobId: jobIdSchema })
  .strict();
export class InvalidQueueEnvelope extends Error {}
export type QueueTransport = Pick<QueueClient, 'send' | 'handleCallback'>;
export class VercelQueueDispatcher implements JobDispatcher {
  readonly provider = 'vercel-queue';
  readonly #client: QueueTransport;
  constructor(options: { region: string; client?: QueueTransport }) {
    this.#client =
      options.client ??
      new QueueClient({ region: options.region as VercelRegion });
  }
  async publish(
    jobId: string,
    options: { delaySeconds?: number; dispatchId?: string } = {},
  ): Promise<DispatchReceipt> {
    jobIdSchema.parse(jobId);
    if (options.dispatchId) jobIdSchema.parse(options.dispatchId);
    const delay = options.delaySeconds ?? 0;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 86400)
      throw new Error(
        'Job dispatch delay must be between 0 and 86,400 seconds.',
      );
    const receipt = await this.#client.send(
      STUDIO_QUEUE_TOPIC,
      { schemaVersion: 1, jobId },
      {
        idempotencyKey: `studio-dispatch:${options.dispatchId ?? jobId}`,
        retentionSeconds: 86400,
        delaySeconds: delay,
      },
    );
    return {
      provider: this.provider,
      ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
    };
  }
}
export function createVercelJobCallback(options: {
  region: string;
  executor: JobExecutor;
  maxRequestSeconds?: number;
  client?: QueueTransport;
}) {
  const client =
    options.client ??
    new QueueClient({ region: options.region as VercelRegion });
  return (request: Request) =>
    client.handleCallback(
      async (input: unknown, metadata: MessageMetadata) => {
        const parsed = jobEnvelopeSchema.safeParse(input);
        if (!parsed.success || metadata.topicName !== STUDIO_QUEUE_TOPIC)
          throw new InvalidQueueEnvelope('Unexpected durable job envelope.');
        const budget = Math.max(
          1000,
          ((options.maxRequestSeconds ?? 300) - 15) * 1000,
        );
        await options.executor(parsed.data.jobId, {
          messageId: metadata.messageId,
          deliveryCount: metadata.deliveryCount,
          region: metadata.region,
          deadlineAt: Date.now() + budget,
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(budget),
          ]),
        });
      },
      {
        visibilityTimeoutSeconds: 300,
        retry: (error, metadata) =>
          error instanceof InvalidQueueEnvelope
            ? { acknowledge: true }
            : {
                afterSeconds: Math.min(
                  300,
                  5 * 2 ** Math.min(metadata.deliveryCount, 6),
                ),
              },
      },
    )(request);
}
