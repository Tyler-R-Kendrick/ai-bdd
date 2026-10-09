import { join } from 'node:path';
import type { DriverFactory, ModelSet, ResolvedConfig } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { fake } from '@ai-bdd/driver-fake';
import { loadConfig } from '@ai-bdd/runtime';

export interface CliContext {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  models: ModelSet;
  drivers: Record<string, DriverFactory>;
  /** True when the deterministic fakes replaced the configured models and drivers. */
  fake: boolean;
}

export interface LoadContextOptions {
  projectRoot: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** `--fake` or `AI_BDD_FAKE=1`. */
  fake?: boolean;
  driverOverride?: string;
}

/**
 * Loads the configuration and the objects the commands need.
 *
 * `AI_BDD_FAKE=1` (or `--fake`) swaps in the deterministic fake models and the
 * fake driver, which is what the README quickstart and every CI job use: no
 * network, no model keys, no browser.
 */
export async function loadCliContext(options: LoadContextOptions): Promise<CliContext> {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot;
  const fakeMode = options.fake ?? env.AI_BDD_FAKE === '1';
  const config = await loadConfig(projectRoot, env, options.configPath);

  const models = fakeMode ? fakeModels(projectRoot) : resolveModels(config);
  const drivers = fakeMode ? fakeDrivers(projectRoot, Object.keys(config.drivers)) : await resolveDrivers(config);

  if (Object.keys(drivers).length === 0) {
    drivers.fake = fake({ modelPath: join(projectRoot, 'fixtures', 'app', 'model.json') });
  }
  const driverOverride = options.driverOverride;
  if (driverOverride && !drivers[driverOverride]) {
    throw new AiBddError('CONFIG_INVALID', `unknown driver \`${driverOverride}\` (configured: ${Object.keys(drivers).join(', ')})`);
  }

  return { projectRoot, env, config, models, drivers, fake: fakeMode };
}

export function fakeModels(projectRoot: string): ModelSet {
  return createFakeModelSet({ rulesPath: join(projectRoot, 'fixtures', 'fake-model', 'rules.json') });
}

/** In fake mode every configured driver name maps to the same in-memory driver. */
export function fakeDrivers(projectRoot: string, configuredNames: string[] = []): Record<string, DriverFactory> {
  const factory = fake({ modelPath: join(projectRoot, 'fixtures', 'app', 'model.json') });
  const drivers: Record<string, DriverFactory> = { fake: factory };
  for (const name of configuredNames) drivers[name] = factory;
  return drivers;
}


function resolveModels(config: ResolvedConfig): ModelSet {
  const models = config.models as Partial<ModelSet> & { act?: unknown };
  const looksReal = typeof (models as { act?: { generate?: unknown } }).act === 'object' && typeof (models as { act?: { generate?: unknown } }).act?.generate === 'function';
  if (!looksReal || typeof models.embed?.embed !== 'function') {
    throw new AiBddError(
      'CONFIG_INVALID',
      'ai-bdd.config.json cannot express model objects; use ai-bdd.config.ts with aiSdkModels(), or run with AI_BDD_FAKE=1',
    );
  }
  return models as ModelSet;
}

/**
 * Resolves `{ use, options }` driver entries to real factories. A driver package
 * that is not installed produces DRIVER_UNAVAILABLE with the package name, which
 * is exactly what `ai-bdd doctor` reports.
 */
async function resolveDrivers(config: ResolvedConfig): Promise<Record<string, DriverFactory>> {
  const drivers: Record<string, DriverFactory> = {};
  for (const [name, entry] of Object.entries(config.drivers)) {
    drivers[name] = await createDriver(entry.use, entry.options ?? {});
  }
  return drivers;
}

export async function createDriver(use: string, options: Record<string, unknown>): Promise<DriverFactory> {
  try {
    switch (use) {
      case '@ai-bdd/driver-fake':
        return fake(options as never);
      case '@ai-bdd/driver-playwright': {
        const module = (await import('@ai-bdd/driver-playwright' as string)) as { playwright: (o: unknown) => DriverFactory };
        return module.playwright(options);
      }
      case '@ai-bdd/driver-e2e': {
        const module = (await import('@ai-bdd/driver-e2e' as string)) as { e2e: (o: unknown) => DriverFactory };
        return module.e2e(options);
      }
      case '@ai-bdd/driver-cua': {
        const module = (await import('@ai-bdd/driver-cua' as string)) as { cua: (o: unknown) => DriverFactory };
        return module.cua(options);
      }
      default: {
        const module = (await import(use)) as { default?: (o: unknown) => DriverFactory };
        if (typeof module.default !== 'function') {
          throw new AiBddError('DRIVER_UNAVAILABLE', `${use} does not export a default driver factory`);
        }
        return module.default(options);
      }
    }
  } catch (error) {
    if (error instanceof AiBddError) throw error;
    throw new AiBddError('DRIVER_UNAVAILABLE', `could not load the driver \`${use}\``, {
      details: { hint: 'install the package or run with AI_BDD_FAKE=1' },
      cause: error,
    });
  }
}
