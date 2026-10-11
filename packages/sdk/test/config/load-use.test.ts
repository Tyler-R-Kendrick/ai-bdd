import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { importConfigModule, loadConfig, loadConfigWith, type ModuleImporter } from '../../src/config/load.ts';

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-bdd-config-use-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => writeFile(join(dir, name), text);

async function failure(p: Promise<unknown>): Promise<AiBddError> {
  try {
    await p;
  } catch (e) {
    return e as AiBddError;
  }
  throw new Error('expected rejection');
}

const chatModel = (id: string) => ({ id, generate: async () => Promise.reject(new Error('not used')) });
const modelSet = (prefix: string) => ({ extract: chatModel(`${prefix}e`), act: chatModel(`${prefix}a`), checkgen: chatModel(`${prefix}c`), judge: chatModel(`${prefix}j`) });

const factoryFor = (id: string) => ({ id, create: async () => Promise.reject(new Error('not used')) });

/** An importer that records what it was asked to import and answers from a map keyed by the exact specifier or URL. */
function recordingImporter(modules: Record<string, Record<string, unknown>>): ModuleImporter & { calls: string[] } {
  const calls: string[] = [];
  const importer = (async (s: string) => {
    calls.push(s);
    const mod = modules[s];
    if (mod === undefined) throw new Error(`no module for ${s}`);
    return mod;
  }) as ModuleImporter & { calls: string[] };
  importer.calls = calls;
  return importer;
}

async function installPackage(name: string, main = 'main.mjs'): Promise<string> {
  const pkgDir = join(dir, 'node_modules', name);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main }));
  await writeFile(join(pkgDir, main), '// not executed in these tests\n');
  return join(pkgDir, main);
}

describe('"use" resolution (JSON config form)', () => {
  it('a relative specifier is resolved against the project root', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './sub/driver.mjs' } } }));
    const importer = recordingImporter({ [pathToFileURL(join(dir, 'sub/driver.mjs')).href]: { createDriverFactory: () => factoryFor('rel') } });
    const c = await loadConfigWith({ cwd: dir, env: {} }, importer);
    expect(c.drivers['web']?.id).toBe('rel');
    expect(importer.calls).toEqual([pathToFileURL(join(dir, 'sub/driver.mjs')).href]);
  });

  it('an absolute specifier is imported from that exact path, receiving the options', async () => {
    const abs = join(dir, 'elsewhere', 'models.mjs');
    await write('ai-bdd.config.json', JSON.stringify({ models: { use: abs, options: { prefix: 'abs:' } } }));
    const importer = recordingImporter({ [pathToFileURL(abs).href]: { createModelSet: (o: unknown) => modelSet((o as { prefix: string }).prefix) } });
    const c = await loadConfigWith({ cwd: dir, env: {} }, importer);
    expect(importer.calls).toEqual([pathToFileURL(abs).href]);
    expect(c.models?.judge.id).toBe('abs:j');
  });

  it('a bare package that resolves from the project is imported by its resolved file URL', async () => {
    const main = await installPackage('fake-driver-pkg');
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: 'fake-driver-pkg', options: { n: 1 } } } }));
    const seen: unknown[] = [];
    const importer = recordingImporter({
      [pathToFileURL(main).href]: {
        createDriverFactory: (o: unknown) => {
          seen.push(o);
          return factoryFor('from-node-modules');
        },
      },
    });
    const c = await loadConfigWith({ cwd: dir, env: {} }, importer);
    expect(c.drivers['web']?.id).toBe('from-node-modules');
    expect(importer.calls).toEqual([pathToFileURL(main).href]);
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('a resolvable package that fails to load reports its own error, not a masking "cannot find package"', async () => {
    const main = await installPackage('broken-pkg');
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: 'broken-pkg' } } }));
    const loadError = new Error('SyntaxError inside the package');
    const importer: ModuleImporter = () => Promise.reject(loadError);
    const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toBe('drivers.web: cannot load "broken-pkg": SyntaxError inside the package');
    expect(e.message).not.toContain('resolving from');
    expect(e.cause).toBe(loadError);
    expect(main).toContain('broken-pkg');
  });

  it('a package that does not resolve from the project is still tried through the importer by name', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ models: { use: 'globally-installed-models-pkg' } }));
    const set = modelSet('g:');
    const importer = recordingImporter({ 'globally-installed-models-pkg': { createModelSet: () => set } });
    const c = await loadConfigWith({ cwd: dir, env: {} }, importer);
    expect(importer.calls).toEqual(['globally-installed-models-pkg']);
    expect(c.models?.judge).toBe(set.judge);
  });

  it('when a package neither resolves nor imports, the error names both the import failure and the project it was resolved from', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: 'definitely-not-installed-pkg' } } }));
    const e = await failure(loadConfigWith({ cwd: dir, env: {} }, recordingImporter({})));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('drivers.web: cannot load "definitely-not-installed-pkg": no module for definitely-not-installed-pkg');
    expect(e.message).toContain(`(resolving from ${dir}: `);
    expect(e.message).toContain("Cannot find module 'definitely-not-installed-pkg'");
  });

  it('a non-Error rejection from the importer is reported by its string form', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ models: { use: './m.mjs' } }));
    const importer: ModuleImporter = () => Promise.reject('plain string failure');
    const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
    expect(e.message).toBe('models: cannot load "./m.mjs": plain string failure');
  });

  it('the options default to an empty object when omitted', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './d.mjs' } } }));
    const seen: unknown[] = [];
    const importer = recordingImporter({
      [pathToFileURL(join(dir, 'd.mjs')).href]: { createDriverFactory: (o: unknown) => (seen.push(o), factoryFor('d')) },
    });
    await loadConfigWith({ cwd: dir, env: {} }, importer);
    expect(seen).toEqual([{}]);
  });

  it('an async factory is awaited', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './d.mjs' } } }));
    const importer = recordingImporter({
      [pathToFileURL(join(dir, 'd.mjs')).href]: { createDriverFactory: async () => factoryFor('async-d') },
    });
    expect((await loadConfigWith({ cwd: dir, env: {} }, importer)).drivers['web']?.id).toBe('async-d');
  });

  it('a "use" entry with keys other than use and options is rejected, naming them', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './d.mjs', option: {}, extra: 1 } } }));
    const e = await failure(loadConfigWith({ cwd: dir, env: {} }, recordingImporter({})));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toBe('drivers.web: unknown key(s) option, extra next to "use" (expected { use, options })');
  });

  describe('factory failures', () => {
    it('a driver factory that throws becomes CONFIG_INVALID naming the driver, with the cause attached', async () => {
      await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './d.mjs' } } }));
      const boom = new Error('bad options');
      const importer = recordingImporter({
        [pathToFileURL(join(dir, 'd.mjs')).href]: {
          createDriverFactory: () => {
            throw boom;
          },
        },
      });
      const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.message).toBe('drivers.web: createDriverFactory failed: bad options');
      expect(e.cause).toBe(boom);
    });

    it('a driver factory that rejects asynchronously is handled the same way', async () => {
      await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './d.mjs' } } }));
      const importer = recordingImporter({
        [pathToFileURL(join(dir, 'd.mjs')).href]: { createDriverFactory: () => Promise.reject('async string failure') },
      });
      const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
      expect(e.message).toBe('drivers.web: createDriverFactory failed: async string failure');
    });

    it('an AiBddError thrown by a driver factory keeps its own code and message', async () => {
      await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './d.mjs' } } }));
      const own = new AiBddError('POLICY_DENIED', 'driver refused');
      const importer = recordingImporter({
        [pathToFileURL(join(dir, 'd.mjs')).href]: {
          createDriverFactory: () => {
            throw own;
          },
        },
      });
      expect(await failure(loadConfigWith({ cwd: dir, env: {} }, importer))).toBe(own);
    });

    it('a model factory that throws becomes CONFIG_INVALID with the cause attached', async () => {
      await write('ai-bdd.config.json', JSON.stringify({ models: { use: './m.mjs' } }));
      const boom = new Error('no api key');
      const importer = recordingImporter({
        [pathToFileURL(join(dir, 'm.mjs')).href]: {
          createModelSet: () => {
            throw boom;
          },
        },
      });
      const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.message).toBe('models: createModelSet failed: no api key');
      expect(e.cause).toBe(boom);
    });

    it('an AiBddError thrown by a model factory keeps its own code and message', async () => {
      await write('ai-bdd.config.json', JSON.stringify({ models: { use: './m.mjs' } }));
      const own = new AiBddError('SECRET_TOO_SHORT', 'key too short');
      const importer = recordingImporter({
        [pathToFileURL(join(dir, 'm.mjs')).href]: {
          createModelSet: () => Promise.reject(own),
        },
      });
      expect(await failure(loadConfigWith({ cwd: dir, env: {} }, importer))).toBe(own);
    });
  });

  it('a driver that is already an object (no "use") is passed through untouched, next to "use" entries', async () => {
    await write('ai-bdd.config.mjs', '');
    const direct = factoryFor('direct');
    const importer = recordingImporter({
      [pathToFileURL(join(dir, 'ai-bdd.config.mjs')).href]: { default: { drivers: { web: direct, other: { use: './o.mjs' } } } },
      [pathToFileURL(join(dir, 'o.mjs')).href]: { createDriverFactory: () => factoryFor('from-use') },
    });
    const c = await loadConfigWith({ cwd: dir, env: {} }, importer);
    expect(c.drivers['web']).toBe(direct);
    expect(c.drivers['other']?.id).toBe('from-use');
    expect(importer.calls).toEqual([pathToFileURL(join(dir, 'ai-bdd.config.mjs')).href, pathToFileURL(join(dir, 'o.mjs')).href]);
  });

  it('a "use" that is not a string is not a package reference and is left for config validation to reject', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: 5 } } }));
    const importer = recordingImporter({});
    const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(importer.calls).toEqual([]);
  });
});

describe('config file handling', () => {
  it('an unsupported extension is CONFIG_INVALID and names the extension', async () => {
    await write('ai-bdd.config.yaml', 'docs: []');
    const e = await failure(loadConfig({ cwd: dir, configPath: 'ai-bdd.config.yaml', env: {} }));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toBe('Unsupported config file extension ".yaml" (use .ts, .mjs, .js or .json)');
  });

  it('the extension check ignores case', async () => {
    await write('custom.JSON', JSON.stringify({ context: 'upper' }));
    expect((await loadConfig({ cwd: dir, configPath: 'custom.JSON', env: {} })).context).toBe('upper');
  });

  it.each(['.ts', '.mts', '.cts', '.mjs', '.js', '.cjs'])('a %s config is loaded through the module importer', async (ext) => {
    const name = `custom${ext}`;
    await write(name, '');
    const importer = recordingImporter({ [pathToFileURL(join(dir, name)).href]: { default: { context: `from ${ext}` } } });
    const c = await loadConfigWith({ cwd: dir, configPath: name, env: {} }, importer);
    expect(c.context).toBe(`from ${ext}`);
    expect(c.configPath).toBe(join(dir, name));
  });

  it('a module namespace without a default export is itself the config', async () => {
    await write('custom.mjs', '');
    const importer = recordingImporter({ [pathToFileURL(join(dir, 'custom.mjs')).href]: { context: 'named export' } });
    expect((await loadConfigWith({ cwd: dir, configPath: 'custom.mjs', env: {} }, importer)).context).toBe('named export');
  });

  it('an export that is not an object (array, null, number) is rejected and names the file', async () => {
    await write('custom.mjs', '');
    for (const value of [[], null, 42, 'text']) {
      const importer = recordingImporter({ [pathToFileURL(join(dir, 'custom.mjs')).href]: { default: value } });
      const e = await failure(loadConfigWith({ cwd: dir, configPath: 'custom.mjs', env: {} }, importer));
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.message).toBe(`Config "${join(dir, 'custom.mjs')}" must export an object (use defineConfig({...}))`);
    }
  });

  it('with no env supplied, secrets are read from process.env', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ secrets: { pw: { env: 'AI_BDD_TEST_LOAD_PW' } } }));
    vi.stubEnv('AI_BDD_TEST_LOAD_PW', 'ab');
    expect((await failure(loadConfig({ cwd: dir }))).code).toBe('SECRET_TOO_SHORT');
    vi.stubEnv('AI_BDD_TEST_LOAD_PW', 'long enough');
    expect((await loadConfig({ cwd: dir })).secrets).toBeDefined();
  });

  it('an explicit env wins over process.env', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ secrets: { pw: { env: 'AI_BDD_TEST_LOAD_PW2' } } }));
    vi.stubEnv('AI_BDD_TEST_LOAD_PW2', 'long enough value');
    expect((await failure(loadConfig({ cwd: dir, env: { AI_BDD_TEST_LOAD_PW2: 'xy' } }))).code).toBe('SECRET_TOO_SHORT');
  });
});

describe('importConfigModule', () => {
  const file = '/project/ai-bdd.config.mjs';

  it('an AiBddError thrown while importing is rethrown unchanged', async () => {
    const own = new AiBddError('POLICY_DENIED', 'nope');
    expect(await failure(importConfigModule(file, () => Promise.reject(own)))).toBe(own);
  });

  it('any other failure becomes CONFIG_INVALID naming the file, with the cause attached', async () => {
    const boom = new SyntaxError('Unexpected token');
    const e = await failure(importConfigModule(file, () => Promise.reject(boom)));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toBe(`Failed to load config "${file}": Unexpected token`);
    expect(e.cause).toBe(boom);
    const e2 = await failure(importConfigModule(file, () => Promise.reject('just text')));
    expect(e2.message).toBe(`Failed to load config "${file}": just text`);
  });

  it('an error whose code is not a string is not mistaken for the unsupported-TypeScript case', async () => {
    const e = await failure(importConfigModule(file, () => Promise.reject(Object.assign(new Error('odd'), { code: 42 }))));
    expect(e.code).toBe('CONFIG_INVALID');
  });

  it('asks the importer for the file URL', async () => {
    const importer = recordingImporter({ [pathToFileURL(file).href]: { default: { a: 1 } } });
    expect(await importConfigModule(file, importer)).toEqual({ a: 1 });
    expect(importer.calls).toEqual([pathToFileURL(file).href]);
  });

  it('unwraps { default: { default: x } } only when default is the single key', async () => {
    expect(await importConfigModule(file, async () => ({ default: { default: { x: 1 } } }))).toEqual({ x: 1 });
    expect(await importConfigModule(file, async () => ({ default: { default: 1, other: 2 } }))).toEqual({ default: 1, other: 2 });
    expect(await importConfigModule(file, async () => ({ default: { other: 2 } }))).toEqual({ other: 2 });
  });

  it('returns a non-object default as is, without trying to unwrap it', async () => {
    expect(await importConfigModule(file, async () => ({ default: 7 }))).toBe(7);
    expect(await importConfigModule(file, async () => ({ default: ['default'] }))).toEqual(['default']);
  });
});
