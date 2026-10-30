import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DurableJobRuntime } from '../runtime/contracts.ts';
import type { DurableScheduler } from './scheduler.ts';
import { maintenanceEnvelope } from './scheduler.ts';
import { assertInternalRequest } from './internal-auth.ts';
import type { UploadAdmission } from './uploads.ts';
const jobRequest = z
  .object({
    jobId: z.string().uuid(),
    delivery: z
      .object({
        messageId: z.string().min(1).max(256),
        deliveryCount: z.number().int().min(1).max(1048576),
        region: z.string().max(32).optional(),
        deadlineAt: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
export async function registerInternalRoutes(
  app: FastifyInstance,
  options: {
    secret: string;
    runtime: DurableJobRuntime;
    scheduler: DurableScheduler;
    uploads?: UploadAdmission;
    requestSeconds: number;
    deploymentId: string;
  },
) {
  // Separate content parser preserves the exact signed bytes. Domain routes keep their normal JSON parser.
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 8192 },
      (_req, body, done) => done(null, body),
    );
    scope.addHook('preHandler', async (req) => {
      assertInternalRequest(
        options.secret,
        req.url,
        typeof req.body === 'string' ? req.body : '',
        {
          time:
            typeof req.headers['x-studio-time'] === 'string'
              ? req.headers['x-studio-time']
              : undefined,
          signature:
            typeof req.headers['x-studio-signature'] === 'string'
              ? req.headers['x-studio-signature']
              : undefined,
        },
      );
    });
    scope.post('/internal/jobs/execute', async (req) => {
      const input = jobRequest.parse(JSON.parse(req.body as string)),
        abort = new AbortController();
      req.raw.once('aborted', () =>
        abort.abort(new Error('Execution request disconnected.')),
      );
      const deadline = Math.min(
        input.delivery.deadlineAt ?? Infinity,
        Date.now() + (options.requestSeconds - 20) * 1000,
      );
      await options.runtime.executeJob(input.jobId, {
        ...input.delivery,
        deadlineAt: deadline,
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ]),
      });
      return { completed: true };
    });
    scope.post('/internal/maintenance/activate', async (req) => {
      const input = z
        .object({ deploymentId: z.string().max(150) })
        .strict()
        .parse(JSON.parse(req.body as string));
      if (input.deploymentId !== options.deploymentId)
        throw Object.assign(
          new Error('Deployment identity does not match the private binding.'),
          { statusCode: 409 },
        );
      await options.scheduler.activate(options.deploymentId);
      return { accepted: true };
    });
    scope.post('/internal/maintenance/execute', async (req) => {
      const tick = maintenanceEnvelope.parse(JSON.parse(req.body as string));
      await options.scheduler.execute(tick, async () => {
        await options.runtime.recover({ dispatchLimit: 5 });
        await options.uploads?.cleanup(2);
      });
      return { completed: true };
    });
  });
}
