import { resolve } from 'node:path';

export const STUDIO_QUEUE_TOPIC = 'studio-jobs-v1';
export type HostingConfig = {
  provider: 'node' | 'vercel';
  origin: string;
  host: string;
  port: number;
  stagingDirectory: string;
  database:
    | { adapter: 'sqlite'; file: string }
    | { adapter: 'postgres'; url: string };
  objects:
    | { adapter: 'disk'; directory: string }
    | { adapter: 'vercel-blob'; token?: string; storeId?: string };
  jobs:
    | { adapter: 'local' }
    | {
        adapter: 'vercel-queue';
        region: string;
        topic: typeof STUDIO_QUEUE_TOPIC;
      };
  maxRequestSeconds: number;
};
function canonicalOrigin(value: string, cloud: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Studio requires a valid configured public origin.');
  }
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (cloud && url.protocol !== 'https:') ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new Error(
      'Studio origin must be a canonical HTTPS origin in Vercel, without credentials, a path, or a trailing slash.',
    );
  return value;
}
function postgresUrl(value: string | undefined) {
  if (!value)
    throw new Error(
      'Vercel Studio requires DATABASE_URL for external durable SQL storage.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === '/'
  )
    throw new Error(
      'Vercel Studio requires external PostgreSQL; ephemeral SQLite is not a cloud storage adapter.',
    );
  return value;
}
/** Read only at runtime, not module load/build; never return this object through health/log APIs. */
export function hostingConfigFromEnv(env: NodeJS.ProcessEnv): HostingConfig {
  const provider =
    env.STUDIO_HOSTING_PROVIDER ?? (env.VERCEL === '1' ? 'vercel' : 'node');
  if (provider !== 'node' && provider !== 'vercel')
    throw new Error(
      'Unknown Studio hosting provider. Install its adapter before selecting it.',
    );
  const cloud = provider === 'vercel';
  const inferredHost =
    env.VERCEL_ENV === 'preview'
      ? env.VERCEL_URL
      : (env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL);
  const origin = canonicalOrigin(
    (env.VERCEL_ENV === 'preview' && inferredHost
      ? `https://${inferredHost}`
      : env.STUDIO_ORIGIN) ??
      (cloud && inferredHost
        ? `https://${inferredHost}`
        : 'http://127.0.0.1:8787'),
    cloud,
  );
  const port = Number(env.STUDIO_PORT ?? env.PORT ?? (cloud ? '80' : '8787'));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('Studio HTTP port must be an integer between 1 and 65,535.');
  const maxRequestSeconds = Number(env.STUDIO_REQUEST_SECONDS ?? '300');
  if (
    !Number.isSafeInteger(maxRequestSeconds) ||
    maxRequestSeconds < 30 ||
    maxRequestSeconds > 1800
  )
    throw new Error(
      'Studio request budget must be between 30 and 1,800 seconds and supported by the configured plan.',
    );
  if (cloud) {
    if (env.STUDIO_DEMO === '1')
      throw new Error('Demo bootstrap is forbidden in Vercel deployments.');
    if (env.STUDIO_STORAGE_ADAPTER && env.STUDIO_STORAGE_ADAPTER !== 'postgres')
      throw new Error(
        'Vercel requires the external PostgreSQL storage adapter.',
      );
    if (
      env.VERCEL_BLOB_API_URL ||
      env.NEXT_PUBLIC_VERCEL_BLOB_API_URL ||
      env.VERCEL_QUEUE_BASE_URL
    )
      throw new Error(
        'Cloud runtime cannot override provider endpoints with development emulators.',
      );
    if (!env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID)
      throw new Error('Vercel Studio requires a connected private Blob store.');
    const region = env.STUDIO_QUEUE_REGION ?? env.VERCEL_REGION ?? 'iad1';
    if (!/^[a-z]{3}[0-9]$/.test(region))
      throw new Error(
        'Studio queue region must be a valid configured Vercel region code.',
      );
    return {
      provider,
      origin,
      host: '0.0.0.0',
      port,
      stagingDirectory: resolve('/tmp/studio-staging'),
      database: { adapter: 'postgres', url: postgresUrl(env.DATABASE_URL) },
      objects: {
        adapter: 'vercel-blob',
        ...(env.BLOB_READ_WRITE_TOKEN
          ? { token: env.BLOB_READ_WRITE_TOKEN }
          : {}),
        ...(env.BLOB_STORE_ID ? { storeId: env.BLOB_STORE_ID } : {}),
      },
      jobs: { adapter: 'vercel-queue', region, topic: STUDIO_QUEUE_TOPIC },
      maxRequestSeconds,
    };
  }
  const directory = resolve(env.STUDIO_DATA_DIR ?? '.studio');
  return {
    provider,
    origin,
    host: env.STUDIO_HOST ?? '127.0.0.1',
    port,
    stagingDirectory: resolve(directory, 'workspaces'),
    database: { adapter: 'sqlite', file: resolve(directory, 'studio.sqlite') },
    objects: { adapter: 'disk', directory: resolve(directory, 'objects') },
    jobs: { adapter: 'local' },
    maxRequestSeconds,
  };
}
export function hostingDiagnostics(config: HostingConfig) {
  return {
    provider: config.provider,
    database: config.database.adapter,
    objects: config.objects.adapter,
    jobs: config.jobs.adapter,
    ephemeralStaging: config.provider === 'vercel',
    ...(config.jobs.adapter === 'vercel-queue'
      ? { region: config.jobs.region }
      : {}),
  };
}
