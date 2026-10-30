import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createApp } from '../app.ts';
import { settingsFromEnv } from '../auth.ts';
import { Store } from '../store.ts';
import { openDatabase, type SqlDatabase } from '../persistence/index.ts';
import { createDurableJobRuntime } from '../runtime/jobs.ts';
import { hostingConfigFromEnv, hostingDiagnostics } from './config.ts';
import { DiskObjectStore } from './disk-objects.ts';
import { VercelBlobObjectStore } from './vercel-objects.ts';
import { VercelQueueDispatcher } from './vercel-queue.ts';
import { LocalJobDispatcher } from './local-queue.ts';
import { ObjectWorkspaceStore } from './workspaces.ts';
import { UploadAdmission } from './uploads.ts';
import { DurableScheduler } from './scheduler.ts';
import { VercelSchedulerDispatcher } from './vercel-scheduler.ts';
import { registerInternalRoutes } from './internal-routes.ts';
import type { HostingServices } from './ports.ts';
import {
  VercelSandboxMediaRuntime,
  mediaSandboxConfigFromEnv,
} from '../media/vercel-sandbox.ts';
import { CachedAudioSourceProbe } from '../media/probe-cache.ts';
import { decisionSettingsFromEnv } from '../decisions/settings.ts';
import {
  identityScopeFromEnv,
  PrivateIdentityLeaseClient,
} from './identity-lease.ts';
import { NativeIdentityExecutionContext } from './native-identity-context.ts';
/** The provider selection exists only here. Domain services receive replaceable ports. */
export async function createHostingApplication(
  env: NodeJS.ProcessEnv,
  options: {
    logger?: boolean;
    clientDir?: string;
    database?: SqlDatabase;
  } = {},
) {
  const config = hostingConfigFromEnv(env);
  const identityClient =
    config.provider === 'vercel' && env.STUDIO_IDENTITY_URL
      ? new PrivateIdentityLeaseClient({
          bindingUrl: env.STUDIO_IDENTITY_URL,
          secret: env.STUDIO_JOB_SECRET ?? '',
          scope: identityScopeFromEnv(env),
        })
      : undefined;
  const identityExecutionContext = identityClient
    ? new NativeIdentityExecutionContext({
        acquire: () => identityClient.acquire(),
      })
    : undefined;
  if (
    env.STUDIO_MEDIA_RUNTIME &&
    !['local-cpu', 'vercel-sandbox'].includes(env.STUDIO_MEDIA_RUNTIME)
  )
    throw new Error('Unknown media runtime adapter');
  if (
    config.provider === 'vercel' &&
    env.STUDIO_MEDIA_RUNTIME === 'local-cpu'
  )
    throw new Error(
      'Vercel media requires the isolated Sandbox adapter; local system binaries are not a cloud runtime',
    );
  const media =
    config.provider === 'vercel' ||
    env.STUDIO_MEDIA_RUNTIME === 'vercel-sandbox'
      ? new VercelSandboxMediaRuntime(
          mediaSandboxConfigFromEnv(env),
          undefined,
          (code) => console.warn(code),
          identityExecutionContext,
        )
      : null;
  if (
    config.provider === 'vercel' &&
    (!env.STUDIO_JOB_SECRET ||
      env.STUDIO_JOB_SECRET.length < 32 ||
      !env.VERCEL_DEPLOYMENT_ID ||
      !/^[a-zA-Z0-9_-]{1,150}$/.test(env.VERCEL_DEPLOYMENT_ID))
  )
    throw new Error(
      'Cloud execution requires a stable job secret and trusted deployment identity.',
    );
  if (
    options.database &&
    options.database.dialect !== config.database.adapter
  )
    throw new Error(
      'Injected SQL adapter must match the selected hosting provider.',
    );
  await mkdir(config.stagingDirectory, { recursive: true, mode: 0o700 });
  if (config.database.adapter === 'sqlite')
    await mkdir(dirname(config.database.file), {
      recursive: true,
      mode: 0o700,
    });
  const store = await Store.open(
    options.database ?? (await openDatabase(config.database)),
  );
  try {
    const probe = media
      ? new CachedAudioSourceProbe({
          store,
          fingerprint: 'studio-media-v1:' + media.config.image,
          probe: media.audioSourceProbe,
        })
      : null;
    if (probe) await probe.ready;
    const objects =
      config.objects.adapter === 'disk'
        ? new DiskObjectStore(config.objects.directory)
        : new VercelBlobObjectStore(config.objects);
    const jobs =
      config.jobs.adapter === 'local'
        ? new LocalJobDispatcher()
        : new VercelQueueDispatcher({
            region: config.jobs.region,
            onFailure: (diagnostic) => console.warn(JSON.stringify(diagnostic)),
            identityExecutionContext,
          });
    const hosting: HostingServices = {
      objects,
      jobs,
      workspaces: new ObjectWorkspaceStore(objects),
    };
    if (config.objects.adapter === 'vercel-blob')
      hosting.uploads = await new UploadAdmission(
        store,
        objects,
        config.objects.token!,
      ).initialize();
    const runtime = await createDurableJobRuntime({
      store,
      dispatcher: jobs,
    });
    if (jobs instanceof LocalJobDispatcher) jobs.bind(runtime.executeJob);
    const settings = settingsFromEnv({
      ...env,
      NODE_ENV: config.provider === 'vercel' ? 'production' : env.NODE_ENV,
      STUDIO_ORIGIN: config.origin,
      STUDIO_DATA_DIR: config.stagingDirectory,
    });
    const result = await createApp(settings, {
      ...options,
      store,
      runtime,
      hosting,
      identityExecutionContext,
      decisionSettings: decisionSettingsFromEnv(env, settings.production),
      ...(media
        ? {
            audioRenderDriver: media.audioRenderDriver,
            videoRenderDriver: media.videoRenderDriver,
            audioSourceProbe: probe!.probe,
          }
        : {}),
    });
    let draining = false;
    if (config.jobs.adapter === 'vercel-queue') {
      if (
        !env.STUDIO_JOB_SECRET ||
        env.STUDIO_JOB_SECRET.length < 32 ||
        !env.VERCEL_DEPLOYMENT_ID
      )
        throw new Error(
          'Cloud execution requires a stable job secret and trusted deployment identity.',
        );
      const scheduler = await new DurableScheduler(
        store,
        new VercelSchedulerDispatcher({
          region: config.jobs.region,
          onFailure: (diagnostic) => console.warn(JSON.stringify(diagnostic)),
          identityExecutionContext,
        }),
      ).initialize();
      await registerInternalRoutes(result.app, {
        secret: env.STUDIO_JOB_SECRET,
        runtime,
        scheduler,
        uploads: hosting.uploads,
        maintenance: async () => {
          await result.maintenance?.();
          await probe?.cleanup();
        },
        requestSeconds: config.maxRequestSeconds,
        deploymentId: env.VERCEL_DEPLOYMENT_ID,
      });
      // Do not rotate active generation on cold starts of old queue-pinned deployments. Only authenticated bootstrap activates it.
    }
    const verifiedAt = new Date().toISOString();
    await store.one('SELECT 1 AS alive');
    result.app.get('/api/hosting/readiness', async (_req, reply) => {
      try {
        await store.one('SELECT 1 AS alive');
      } catch {
        return reply
          .code(503)
          .send({ ready: false, reason: 'database-unavailable' });
      }
      return reply.code(draining ? 503 : 200).send({
        ready: !draining,
        draining,
        ...hostingDiagnostics(config),
        services: {
          database: { state: 'verified', verifiedAt },
          objects: { state: 'configured' },
          media: media?.diagnostics() ?? {
            adapter: 'local-cpu',
            state: 'configured',
          },
          jobs: {
            ...(await result.executionReadiness()),
            semantics: 'at-least-once; fenced SQL publication',
          },
        },
      });
    });
    const close = async () => {
      draining = true;
      await runtime.close();
      if (jobs instanceof LocalJobDispatcher) await jobs.close();
      await result.app.close();
    };
    return {
      ...result,
      config,
      hosting,
      runtime,
      close,
      beginDrain: () => {
        draining = true;
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
