import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiBddConfig, ResolvedConfig, SecretDecl } from '@ai-bdd/contracts';
import { AiBddError, CONFIG_KEYS, DEFAULT_GUARD_CONFIG, DEFAULT_KIND_CONFIG, DEFAULT_SETTLE } from '@ai-bdd/contracts';
import { resolveSecrets } from '@ai-bdd/evidence';

export const DEFAULT_SPECS = ['specs/**/*.spec.md', 'specs/**/*.spec', 'features/**/*.feature'];
export const DEFAULT_CONCEPTS = ['specs/**/*.cpt'];
export const DEFAULT_BINDINGS = ['bindings/**/*.ts', 'bindings/**/*.js'];

export function defineConfig(config: AiBddConfig): AiBddConfig {
  return config;
}

/** Validates unknown keys and applies the documented defaults. */
export function resolveConfig(input: AiBddConfig, projectRoot: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const unknown = Object.keys(input).filter((key) => !(CONFIG_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new AiBddError('CONFIG_UNKNOWN_KEY', `unknown configuration key(s): ${unknown.join(', ')}`, {
      details: { unknown },
    });
  }

  const secrets = (input.secrets ?? {}) as Record<string, SecretDecl>;
  resolveSecrets(secrets, env); // validates SECRET_TOO_SHORT early

  const isCi = isTruthy(env.CI);
  const cacheMode = input.cache?.mode ?? (isCi ? 'read-only' : 'read-write');
  const resolved: ResolvedConfig = {
    specs: input.specs ?? DEFAULT_SPECS,
    concepts: input.concepts ?? DEFAULT_CONCEPTS,
    bindings: input.bindings ?? DEFAULT_BINDINGS,
    drivers: input.drivers ?? {},
    ...(input.defaultDriver !== undefined ? { defaultDriver: input.defaultDriver } : {}),
    models: input.models ?? { act: undefined, judge: undefined, embed: undefined },
    ...(input.context !== undefined ? { context: input.context } : {}),
    resolution: {
      threshold: input.resolution?.threshold ?? 0.85,
      margin: input.resolution?.margin ?? 0.1,
      allowAgentSetup: input.resolution?.allowAgentSetup ?? false,
      semantic: {
        enabled: input.resolution?.semantic?.enabled ?? true,
        guards: { ...DEFAULT_GUARD_CONFIG, ...(input.resolution?.semantic?.guards ?? {}) },
      },
    },
    kinds: { ...DEFAULT_KIND_CONFIG, ...(input.kinds ?? {}) },
    assertions: {
      mode: input.assertions?.mode ?? 'auto',
      requireDeterministic: input.assertions?.requireDeterministic ?? false,
      checkGen: { maxAttempts: input.assertions?.checkGen?.maxAttempts ?? 3 },
    },
    judge: {
      passThreshold: input.judge?.passThreshold ?? 0.8,
      failThreshold: input.judge?.failThreshold ?? 0.3,
      samples: input.judge?.samples ?? 3,
      maxSpread: input.judge?.maxSpread ?? 0.5,
      vision: input.judge?.vision ?? true,
      maxTreeChars: input.judge?.maxTreeChars ?? 20000,
    },
    grounding: { threshold: input.grounding?.threshold ?? 0.6, margin: input.grounding?.margin ?? 0.1 },
    agent: { maxActions: input.agent?.maxActions ?? 20, maxModelCalls: input.agent?.maxModelCalls ?? 15 },
    cache: {
      mode: cacheMode,
      dir: input.cache?.dir ?? '.ai-bdd/cache',
      invalidation: input.cache?.invalidation ?? ['effect-verify'],
      ...(input.cache?.files !== undefined ? { files: input.cache.files } : {}),
      ...(input.cache?.buildChecksum !== undefined ? { buildChecksum: input.cache.buildChecksum } : {}),
      ...(input.cache?.manual !== undefined ? { manual: input.cache.manual } : {}),
      ...(input.cache?.custom !== undefined ? { custom: input.cache.custom } : {}),
    },
    evidence: {
      dir: input.evidence?.dir ?? '.ai-bdd/runs',
      video: input.evidence?.video ?? 'retain-on-failure',
      requireSettled: input.evidence?.requireSettled ?? true,
      settle: { ...DEFAULT_SETTLE, ...(input.evidence?.settle ?? {}) },
      ...(input.evidence?.signing !== undefined ? { signing: input.evidence.signing } : {}),
    },
    secrets,
    policy: {
      allowHosts: input.policy?.allowHosts ?? ['localhost', '127.0.0.1', '[::1]'],
      denyVerbs: input.policy?.denyVerbs ?? [],
      cua: { allowApps: input.policy?.cua?.allowApps ?? [] },
    },
    concurrency: { scenarios: input.concurrency?.scenarios ?? 4 },
    daemon: {
      host: input.daemon?.host ?? '127.0.0.1',
      port: input.daemon?.port ?? 0,
      sessionIdleMs: input.daemon?.sessionIdleMs ?? 600_000,
    },
    hooks: input.hooks ?? {},
    reporters: input.reporters ?? ['json', 'junit', 'markdown', 'cucumber-messages'],
    prices: input.prices ?? {},
    projectRoot,
  };
  return resolved;
}

/**
 * Loads `ai-bdd.config.ts` (native type stripping) or `ai-bdd.config.json`.
 * Runtimes without type stripping report CONFIG_TS_UNSUPPORTED and ask for a
 * JSON or JS config (VERIFY V15).
 */
export async function loadConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): Promise<ResolvedConfig> {
  const jsonPath = explicitPath ?? join(projectRoot, 'ai-bdd.config.json');
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as AiBddConfig;
    return resolveConfig(raw, projectRoot, env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof AiBddError) throw error;
      throw new AiBddError('CONFIG_INVALID', `could not read ${jsonPath}`, { cause: error });
    }
  }

  const tsPath = explicitPath ?? join(projectRoot, 'ai-bdd.config.ts');
  const supportsTypescript = (process.features as { typescript?: string }).typescript !== undefined;
  if (!supportsTypescript) {
    throw new AiBddError('CONFIG_TS_UNSUPPORTED', 'this Node runtime cannot load ai-bdd.config.ts; use ai-bdd.config.json');
  }
  try {
    const module = (await import(tsPath)) as { default?: AiBddConfig } & AiBddConfig;
    return resolveConfig(module.default ?? module, projectRoot, env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      return resolveConfig({}, projectRoot, env);
    }
    throw AiBddError.from(error);
  }
}

export function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}
