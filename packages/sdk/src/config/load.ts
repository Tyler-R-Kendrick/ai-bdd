import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AiBddError, type DriverFactory, type LoadConfig, type ModelSet, type UserConfig } from '../contracts/index.ts';
import { resolveConfig } from './resolve.ts';

/** Candidate config files, in precedence order. */
export const CONFIG_FILE_NAMES = ['ai-bdd.config.ts', 'ai-bdd.config.mjs', 'ai-bdd.config.js', 'ai-bdd.config.json'] as const;

export type ModuleImporter = (specifierOrUrl: string) => Promise<Record<string, unknown>>;

const defaultImporter: ModuleImporter = (s) => import(/* @vite-ignore */ s) as Promise<Record<string, unknown>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function errCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err['code'] === 'string' ? err['code'] : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Import a config module, mapping Node loader failures to AiBddError codes. */
export async function importConfigModule(file: string, importer: ModuleImporter = defaultImporter): Promise<unknown> {
  let mod: Record<string, unknown>;
  try {
    mod = await importer(pathToFileURL(file).href);
  } catch (err) {
    if (errCode(err) === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new AiBddError(
        'CONFIG_TS_UNSUPPORTED',
        `This Node.js version cannot load "${file}" (no native TypeScript type stripping). Use Node >= 22.18, or write the config as ai-bdd.config.mjs or ai-bdd.config.json.`,
        { cause: err },
      );
    }
    if (err instanceof AiBddError) throw err;
    throw new AiBddError('CONFIG_INVALID', `Failed to load config "${file}": ${errMessage(err)}`, { cause: err });
  }
  let value: unknown = 'default' in mod ? mod['default'] : mod;
  // CommonJS interop: `module.exports = x` may surface as `{ default: { default: x } }`.
  if (isRecord(value) && Object.keys(value).length === 1 && 'default' in value) value = value['default'];
  return value;
}

async function importUse(spec: string, projectRoot: string, where: string, importer: ModuleImporter): Promise<Record<string, unknown>> {
  try {
    if (spec.startsWith('.') || isAbsolute(spec)) return await importer(pathToFileURL(resolve(projectRoot, spec)).href);
    let resolved: string | undefined;
    let resolveError: unknown;
    try {
      resolved = createRequire(join(projectRoot, 'package.json')).resolve(spec);
    } catch (err) {
      resolveError = err; // not resolvable from the project: let the importer try (workspace / global installs)
    }
    // a package that resolves but fails to load reports its own error, never a masking "cannot find package"
    if (resolved !== undefined) return await importer(pathToFileURL(resolved).href);
    try {
      return await importer(spec);
    } catch (err) {
      throw new Error(`${errMessage(err)} (resolving from ${projectRoot}: ${errMessage(resolveError)})`, { cause: err });
    }
  } catch (err) {
    throw new AiBddError('CONFIG_INVALID', `${where}: cannot load "${spec}": ${errMessage(err)}`, { cause: err });
  }
}

function parseUse(value: unknown, where: string): { use: string; options: unknown } | null {
  if (!isRecord(value) || typeof value['use'] !== 'string') return null;
  const extra = Object.keys(value).filter((k) => k !== 'use' && k !== 'options');
  if (extra.length > 0) throw new AiBddError('CONFIG_INVALID', `${where}: unknown key(s) ${extra.join(', ')} next to "use" (expected { use, options })`);
  return { use: value['use'], options: value['options'] ?? {} };
}

/** Replace `{ use, options }` entries (JSON config form) with the objects built by the named packages. */
async function resolveUses(raw: Record<string, unknown>, projectRoot: string, importer: ModuleImporter): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...raw };
  delete out['$schema'];

  if (isRecord(out['drivers'])) {
    const drivers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(out['drivers'])) {
      const where = `drivers.${name}`;
      const use = parseUse(value, where);
      if (use === null) {
        drivers[name] = value;
        continue;
      }
      const mod = await importUse(use.use, projectRoot, where, importer);
      const factory = mod['createDriverFactory'];
      if (typeof factory !== 'function') {
        throw new AiBddError('CONFIG_INVALID', `${where}: package "${use.use}" does not export createDriverFactory(options)`);
      }
      try {
        drivers[name] = (await (factory as (o: unknown) => DriverFactory | Promise<DriverFactory>)(use.options)) as DriverFactory;
      } catch (err) {
        if (err instanceof AiBddError) throw err;
        throw new AiBddError('CONFIG_INVALID', `${where}: createDriverFactory failed: ${errMessage(err)}`, { cause: err });
      }
    }
    out['drivers'] = drivers;
  }

  const use = parseUse(out['models'], 'models');
  if (use !== null) {
    const mod = await importUse(use.use, projectRoot, 'models', importer);
    const factory = mod['createModelSet'];
    if (typeof factory !== 'function') {
      throw new AiBddError('CONFIG_INVALID', `models: package "${use.use}" does not export createModelSet(options)`);
    }
    try {
      out['models'] = (await (factory as (o: unknown) => ModelSet | Promise<ModelSet>)(use.options)) as ModelSet;
    } catch (err) {
      if (err instanceof AiBddError) throw err;
      throw new AiBddError('CONFIG_INVALID', `models: createModelSet failed: ${errMessage(err)}`, { cause: err });
    }
  }
  return out;
}

export function findConfigFile(cwd: string, configPath?: string): string {
  if (configPath !== undefined) {
    const file = resolve(cwd, configPath);
    if (!existsSync(file)) throw new AiBddError('CONFIG_NOT_FOUND', `Config file not found: ${file}`);
    return file;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const file = join(cwd, name);
    if (existsSync(file)) return file;
  }
  throw new AiBddError('CONFIG_NOT_FOUND', `No ai-bdd config found in ${cwd} (looked for ${CONFIG_FILE_NAMES.join(', ')}). Run "ai-bdd init".`);
}

/** Load a config file from disk and resolve it. `importer` is injectable for tests. */
export async function loadConfigWith(
  opts: Parameters<LoadConfig>[0],
  importer: ModuleImporter = defaultImporter,
): Promise<Awaited<ReturnType<LoadConfig>>> {
  const cwd = resolve(opts.cwd);
  const env = opts.env ?? process.env;
  const file = findConfigFile(cwd, opts.configPath);
  const ext = extname(file).toLowerCase();

  let raw: unknown;
  if (ext === '.json') {
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (err) {
      throw new AiBddError('CONFIG_INVALID', `Cannot parse JSON config "${file}": ${errMessage(err)}`, { cause: err });
    }
  } else if (['.ts', '.mts', '.cts', '.mjs', '.js', '.cjs'].includes(ext)) {
    raw = await importConfigModule(file, importer);
  } else {
    throw new AiBddError('CONFIG_INVALID', `Unsupported config file extension "${ext}" (use .ts, .mjs, .js or .json)`);
  }
  raw = await Promise.resolve(raw);
  if (!isRecord(raw)) throw new AiBddError('CONFIG_INVALID', `Config "${file}" must export an object (use defineConfig({...}))`);

  const user = await resolveUses(raw, cwd, importer);
  return resolveConfig(user as UserConfig, { projectRoot: cwd, configPath: file, env });
}

export const loadConfig: LoadConfig = (opts) => loadConfigWith(opts);
