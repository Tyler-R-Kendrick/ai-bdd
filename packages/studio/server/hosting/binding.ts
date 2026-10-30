import { internalHeaders } from './internal-auth.ts';
import type { JobExecutor } from './ports.ts';
import type { MaintenanceTick } from './scheduler.ts';
export type BindingConfig = {
  backendUrl: string;
  secret: string;
  maxRequestSeconds: number;
};
export function bindingConfigFromEnv(env: NodeJS.ProcessEnv): BindingConfig {
  const backendUrl = env.STUDIO_BACKEND_URL,
    secret = env.STUDIO_JOB_SECRET;
  if (!backendUrl || !secret || secret.length < 32)
    throw new Error(
      'A private backend service binding and job secret are required.',
    );
  const url = new URL(backendUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid private backend binding.');
  const maxRequestSeconds = Number(env.STUDIO_REQUEST_SECONDS ?? 300);
  if (
    !Number.isInteger(maxRequestSeconds) ||
    maxRequestSeconds < 30 ||
    maxRequestSeconds > 800
  )
    throw new Error('Invalid service request budget.');
  return { backendUrl: url.origin, secret, maxRequestSeconds };
}
export async function forwardInternal(
  config: BindingConfig,
  path: string,
  value: unknown,
  signal?: AbortSignal,
) {
  if (
    !/^\/internal\/(jobs\/execute|maintenance\/(execute|activate))$/.test(path)
  )
    throw new Error('Unknown internal service operation.');
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 8192)
    throw new Error('Internal service envelope exceeds its bound.');
  const timeout = AbortSignal.timeout((config.maxRequestSeconds - 10) * 1000);
  const response = await fetch(new URL(path, config.backendUrl), {
    method: 'POST',
    headers: internalHeaders(config.secret, path, body),
    body,
    redirect: 'error',
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  // Never return a provider response body or trusted binding address to the queue/public caller.
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(
      `Internal durable operation failed with status ${response.status}.`,
    );
}
export function bindingJobExecutor(config: BindingConfig): JobExecutor {
  return async (jobId, context) =>
    forwardInternal(
      config,
      '/internal/jobs/execute',
      {
        jobId,
        delivery: {
          messageId: context.messageId,
          deliveryCount: context.deliveryCount,
          region: context.region,
          deadlineAt: context.deadlineAt,
        },
      },
      context.signal,
    );
}
export function bindingMaintenanceExecutor(config: BindingConfig) {
  return (tick: MaintenanceTick) =>
    forwardInternal(config, '/internal/maintenance/execute', tick);
}
