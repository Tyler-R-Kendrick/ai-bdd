import { resolve } from 'node:path';
import { createEngine, loadConfig } from '@ai-bdd/sdk';
import type { Engine } from '@ai-bdd/sdk/contracts';

/**
 * One engine per worker process (module state is per process, and Playwright runs each worker in its own process),
 * keyed by config location. The engine is created lazily by the first test that needs it, never at collection time.
 */
const engines = new Map<string, Promise<Engine>>();

function keyFor(configPath: string | undefined): string {
  return configPath === undefined ? `cwd:${process.cwd()}` : `config:${resolve(process.cwd(), configPath)}`;
}

export function getEngine(configPath: string | undefined): Promise<Engine> {
  const key = keyFor(configPath);
  const existing = engines.get(key);
  if (existing !== undefined) return existing;
  const created = (async () => {
    const config = await loadConfig({
      cwd: process.cwd(),
      ...(configPath === undefined ? {} : { configPath: resolve(process.cwd(), configPath) }),
    });
    return createEngine(config);
  })();
  engines.set(key, created);
  // A failed creation is not memoized, so the next test retries instead of replaying a stale rejection.
  created.catch(() => {
    if (engines.get(key) === created) engines.delete(key);
  });
  return created;
}

/**
 * Closes and forgets every memoized engine of this process, finalizing their run directories. Registered
 * automatically as a file-level `test.afterAll` (which Playwright runs once per worker after that worker's last test
 * in the file). Calling it again is harmless, and a later test simply creates a fresh engine.
 */
export async function closeAiBddEngines(): Promise<void> {
  const pending = [...engines.values()];
  engines.clear();
  let firstError: unknown;
  let failed = false;
  for (const promise of pending) {
    let engine: Engine;
    try {
      engine = await promise;
    } catch {
      continue; // creation failed: nothing to close, and the failing tests already reported it
    }
    try {
      await engine.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
}
