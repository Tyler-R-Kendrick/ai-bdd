import { resolve } from 'node:path';
import { createHostingApplication } from './application.ts';
const service = await createHostingApplication(process.env, {
  logger: true,
  clientDir: resolve(import.meta.dirname, '../client'),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    service.beginDrain();
    const grace = setTimeout(() => process.exit(1), 25_000);
    grace.unref();
    void service.close().then(
      () => {
        clearTimeout(grace);
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
await service.app.listen({
  host: service.config.host,
  port: service.config.port,
});
