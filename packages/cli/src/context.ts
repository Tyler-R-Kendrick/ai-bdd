import { isAbsolute, resolve } from 'node:path';
import type {
  CreateEngine,
  CreateRecordingStore,
  Engine,
  LoadConfig,
  ResolvedConfig,
  VerifyRun,
} from '@ai-bdd/sdk/contracts';
import type { CliDeps, CliIo } from './types.ts';

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
  /**
   * Register secret values that must never reach the terminal. `expand` lists the other forms a value may take on its way out
   * (URL-encoded, base64, JSON-escaped); the raw value is always scrubbed.
   */
  addSecrets(values: Iterable<string | undefined>, expand?: (value: string) => string[]): void;
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
    addSecrets(values, expand) {
      for (const v of values) {
        if (typeof v !== 'string' || v.length < MIN_SCRUB_LENGTH) continue;
        for (const form of expand === undefined ? [v] : expand(v)) if (form.length >= MIN_SCRUB_LENGTH) secrets.add(form);
      }
      // longest first, so a form that contains another is replaced as a whole
      const ordered = [...secrets].sort((a, b) => b.length - a.length);
      secrets.clear();
      for (const form of ordered) secrets.add(form);
    },
  };
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
export async function resolveCreateEngine(deps: CliDeps): Promise<CreateEngine> {
  return deps.createEngine ?? (await sdk()).createEngine;
}
export async function resolveCreateRecordingStore(deps: CliDeps): Promise<CreateRecordingStore> {
  return deps.createRecordingStore ?? (await sdk()).createRecordingStore;
}
export async function resolveVerifyRun(deps: CliDeps): Promise<VerifyRun> {
  return deps.verifyRun ?? (await sdk()).verifyRun;
}

// ───────────────────────── engine construction

export interface EngineOptions {
  /** `--driver` value; forwarded by `run` to the engine, which validates it against the config's registered drivers. */
  driver?: string | undefined;
}

export interface EngineHandle { engine: Engine; config: ResolvedConfig }

/**
 * Loads the config (`--config` or the default lookup). A missing config file, including an explicit `-c <path>` that does not
 * exist, is CONFIG_NOT_FOUND (exit 2). The CLI runs exactly the models and drivers the config registers.
 */
export async function loadResolvedConfig(ctx: Ctx): Promise<ResolvedConfig> {
  const loadConfig = await resolveLoadConfig(ctx.deps);
  return loadConfig({
    cwd: ctx.io.cwd,
    env: ctx.io.env,
    ...(ctx.configPath === undefined ? {} : { configPath: isAbsolute(ctx.configPath) ? ctx.configPath : resolve(ctx.io.cwd, ctx.configPath) }),
  });
}

export async function openEngine(ctx: Ctx, _opts: EngineOptions = {}): Promise<EngineHandle> {
  const config = await loadResolvedConfig(ctx);
  const createEngine = await resolveCreateEngine(ctx.deps);
  const engine = await createEngine(config);
  ctx.addSecrets(Object.values(engine.config.secrets).map((s) => ctx.io.env[s.env]), (await sdk()).secretVariants);
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
