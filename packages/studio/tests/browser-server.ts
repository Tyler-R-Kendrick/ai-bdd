// Test-only composition. Shipping main.js never imports the owned OAuth fixture.
import { resolve } from 'node:path';
import { createApp, browserOwnerEmail } from './browser-fixture.ts';
import { createLocalMaintenance } from '../server/runtime/local-maintenance.ts';

if (process.env.NODE_ENV !== 'test')
  throw new Error('The browser fixture server is restricted to tests');
const studio = await createApp({
  production: false,
  demo: false,
  origin: process.env.STUDIO_ORIGIN ?? 'http://127.0.0.1:8877',
  dataDir: process.env.STUDIO_DATA_DIR ?? '.studio-browser-tests',
  adminEmail: browserOwnerEmail,
}, { clientDir: resolve(import.meta.dirname, '../dist/client') });
const maintenance = createLocalMaintenance({
  maintenance: studio.maintenance,
  runtime: studio.runtime,
  onError: () => studio.app.log.error('Browser fixture maintenance failed'),
});
studio.app.addHook('onClose', () => maintenance.close());
let stopping: Promise<unknown> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void (stopping ??= studio.app.close()).then(() => process.exit(0));
  });
await studio.app.listen({ port: Number(process.env.STUDIO_PORT ?? 8877), host: '127.0.0.1' });
maintenance.start();
