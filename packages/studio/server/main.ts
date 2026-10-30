import { createApp } from './app.ts';
import { settingsFromEnv } from './auth.ts';
import { resolve } from 'node:path';
import { createLocalMaintenance } from './runtime/local-maintenance.ts';
// The image and `pnpm start` use this entrypoint. Cloud startup must select its
// canonical preview origin and durable adapters before local settings are read.
const provider =
  process.env.STUDIO_HOSTING_PROVIDER ??
  (process.env.VERCEL === '1' ? 'vercel' : 'node');
if (provider === 'vercel') {
  // Keep this a source import so esbuild includes the existing cloud entrypoint
  // in main.js; no second relative bundle has to be present at runtime.
  await import('./hosting/vercel-main.ts');
} else {
  const settings = settingsFromEnv(process.env);
  // The bundle is dist/server/main.js; source development uses a separately served Vite client.
  const clientDir = resolve(import.meta.dirname, '../client');
  const studio = await createApp(settings, { logger: true, clientDir });
  const { app } = studio;
  const maintenance = createLocalMaintenance({
    maintenance: studio.maintenance,
    runtime: studio.runtime,
    onError: () =>
      app.log.error(
        'Local lifecycle maintenance failed; the next cycle will retry',
      ),
  });
  app.addHook('onClose', () => maintenance.close());
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      await maintenance.close();
      await app.close();
    })());
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  try {
    await app.listen({
      port: Number(process.env.STUDIO_PORT ?? 8787),
      host: process.env.STUDIO_HOST ?? '127.0.0.1',
    });
    maintenance.start();
  } catch (error) {
    await close();
    throw error;
  }
}
