// A third-party style driver package: exports `createDriverFactory(options)` like @ai-bdd/driver-playwright does.
// Behind the factory it reuses the deterministic fakeDriver, so the acceptance suite can run without a browser.
import { appendFileSync } from 'node:fs';
import { fakeDriver } from '@ai-bdd/testing';

/** @param {{ flags?: string[], logFile?: string }} options */
export function createDriverFactory(options = {}) {
  const inner = fakeDriver({ flags: options.flags ?? [] });
  return {
    id: inner.id,
    async create(ctx) {
      // proves the factory built from the config options really ran in the CLI process
      if (options.logFile !== undefined) appendFileSync(options.logFile, `${JSON.stringify({ created: 'vendor-fixture', options })}\n`);
      return inner.create(ctx);
    },
  };
}
