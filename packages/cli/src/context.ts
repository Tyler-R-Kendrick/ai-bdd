import { isAbsolute, resolve } from 'node:path';
import {
  AiBddError,
  type CreateEngine,
  type CreateRecordingStore,
  type DriverFactory,
  type Engine,
  type LoadConfig,
  type ModelSet,
  type ResolveConfig,
  type ResolvedConfig,
  type VerifyRun,
} from '@ai-bdd/sdk/contracts';
import { hasErrorCode } from './exit.ts';
import type { CliDeps, CliIo, TestingModule } from './types.ts';

export const FAKE_BANNER = 'ai-bdd: FAKE models/driver active';
const MIN_SCRUB_LENGTH = 4;

/** Everything a command needs; built once per `main` call. */
export interface Ctx {
  readonly io: CliIo;
  readonly deps: CliDeps;
  /** `--config` value, if given. */
  configPath: string | undefined;
  /** Print a line to stdout. Secret values known to the CLI are scrubbed. */
  out(line?: string): void;
  /** Print a line to stderr. Secret values known to the CLI are scrubbed. */
  err(line?: string): void;
  /** Register secret values that must never reach the terminal. */
  addSecrets(values: Iterable<string | undefined>): void;
}

export function createCtx(io: CliIo, deps: CliDeps): Ctx {
  const secrets = new Set<string>();
  const scrub = (s: string): string => {
    let r = s;
    for (const v of secrets) r = r.split(v).join('[redacted]');
    return r;
  };
  return {
    io,
    deps,
    configPath: undefined,
    out: (line = '') => void io.stdout.write(`${scrub(line)}\n`),
    err: (line = '') => void io.stderr.write(`${scrub(line)}\n`),
    addSecrets(values) {
      for (const v of values) if (typeof v === 'string' && v.length >= MIN_SCRUB_LENGTH) secrets.add(v);
    },
  };
}

export function isEnvOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ───────────────────────── lazily resolved SDK defaults (keeps `--help` free of the engine's import graph)

let sdkPromise: Promise<typeof import('@ai-bdd/sdk')> | undefined;
function sdk(): Promise<typeof import('@ai-bdd/sdk')> {
  sdkPromise ??= import('@ai-bdd/sdk');
  return sdkPromise;
}

export async function resolveLoadConfig(deps: CliDeps): Promise<LoadConfig> {
  return deps.loadConfig ?? (await sdk()).loadConfig;
}
export async function resolveResolveConfig(deps: CliDeps): Promise<ResolveConfig> {
  return deps.resolveConfig ?? (await sdk()).resolveConfig;
}
export async function resolveCreateEngine(deps: CliDeps): Promise<CreateEngine> {
  return deps.createEngine ?? (await sdk()).createEngine;
}
export async function resolveCreateRecordingStore(deps: CliDeps): Promise<CreateRecordingStore> {
  return deps.createRecordingStore ?? (await sdk()).createRecordingStore;
}
export async function resolveVerifyRun(deps: CliDeps): Promise<VerifyRun> {
  return deps.verifyRun ?? (await sdk()).verifyRun;
}

// ───────────────────────── AI_BDD_FAKE (§5.3)

async function importTesting(deps: CliDeps): Promise<TestingModule> {
  let mod: unknown;
  try {
    // A variable specifier keeps this optional peer out of static analysis (R-SDK2 boundary scripts, bundlers).
    const specifier = '@ai-bdd/testing';
    mod = await (deps.importTesting ? deps.importTesting() : import(specifier));
  } catch (cause) {
    throw new AiBddError('CONFIG_INVALID', 'AI_BDD_FAKE=1 requires the @ai-bdd/testing package, which could not be loaded. Install it or unset AI_BDD_FAKE.', { cause });
  }
  const m = mod as Partial<TestingModule> | null | undefined;
  if (!m || typeof m.createFakeModels !== 'function' || typeof m.fakeDriver !== 'function') {
    throw new AiBddError('CONFIG_INVALID', 'AI_BDD_FAKE=1: @ai-bdd/testing does not export createFakeModels and fakeDriver.');
  }
  return m as TestingModule;
}

export interface FakeSetup { models: ModelSet; drivers: Record<string, DriverFactory> }

export async function setupFake(ctx: Ctx): Promise<FakeSetup> {
  const testing = await importTesting(ctx.deps);
  const rules = ctx.io.env['AI_BDD_FAKE_RULES'];
  const flags = (ctx.io.env['AI_BDD_FAKE_FLAGS'] ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  const models = testing.createFakeModels(rules ? { rulesDir: isAbsolute(rules) ? rules : resolve(ctx.io.cwd, rules) } : {});
  return { models, drivers: { fake: testing.fakeDriver({ flags }) } };
}

// ───────────────────────── engine construction

export interface EngineOptions {
  /** `--driver` value; when set, `AI_BDD_FAKE` does not change `defaultDriver`. */
  driver?: string | undefined;
  /** When the project has no config file, fall back to this instead of failing (verify-run). */
  allowNoConfig?: boolean;
}

export interface EngineHandle { engine: Engine; config: ResolvedConfig }

export async function loadResolvedConfig(ctx: Ctx, allowDefaults: boolean): Promise<ResolvedConfig> {
  const loadConfig = await resolveLoadConfig(ctx.deps);
  const env = ctx.io.env;
  const opts = {
    cwd: ctx.io.cwd,
    env,
    ...(ctx.configPath === undefined ? {} : { configPath: isAbsolute(ctx.configPath) ? ctx.configPath : resolve(ctx.io.cwd, ctx.configPath) }),
  };
  try {
    return await loadConfig(opts);
  } catch (e) {
    if (allowDefaults && hasErrorCode(e, 'CONFIG_NOT_FOUND')) {
      const resolveConfig = await resolveResolveConfig(ctx.deps);
      return resolveConfig({}, { projectRoot: ctx.io.cwd, env });
    }
    throw e;
  }
}

export async function openEngine(ctx: Ctx, opts: EngineOptions = {}): Promise<EngineHandle> {
  const fake = isEnvOn(ctx.io.env['AI_BDD_FAKE']);
  let config = await loadResolvedConfig(ctx, fake || opts.allowNoConfig === true);
  const createEngine = await resolveCreateEngine(ctx.deps);

  let engine: Engine;
  if (fake) {
    const setup = await setupFake(ctx);
    ctx.err(FAKE_BANNER);
    const drivers = { ...config.drivers, ...setup.drivers };
    config = { ...config, models: setup.models, drivers, defaultDriver: opts.driver === undefined ? 'fake' : (config.defaultDriver ?? 'fake') };
    engine = await createEngine(config, { models: setup.models, drivers });
  } else {
    engine = await createEngine(config);
  }
  ctx.addSecrets(Object.values(engine.config.secrets).map((s) => ctx.io.env[s.env]));
  return { engine, config: engine.config };
}

/** Opens an engine, runs `fn`, and always closes the engine. */
export async function withEngine<T>(ctx: Ctx, opts: EngineOptions, fn: (h: EngineHandle) => Promise<T>): Promise<T> {
  const handle = await openEngine(ctx, opts);
  try {
    return await fn(handle);
  } finally {
    try {
      await handle.engine.close();
    } catch (e) {
      ctx.err(`ai-bdd: warning: engine close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
