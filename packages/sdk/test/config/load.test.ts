import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { loadConfig } from '../../src/config/index.ts';
import { importConfigModule, loadConfigWith } from '../../src/config/load.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-bdd-config-'));
});
afterEach(async () => {
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

const MODEL_MODULE = `
export function createModelSet(options) {
  const m = (id) => ({ id: options.prefix + id, generate: async () => ({ toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop', modelId: id }) });
  return { extract: m('e'), act: m('a'), checkgen: m('c'), judge: m('j') };
}
`;
const DRIVER_MODULE = `
export function createDriverFactory(options) {
  return { id: 'drv-' + options.name, create: async () => { throw new Error('not used'); } };
}
`;

describe('loadConfig', () => {
  it('CONFIG_NOT_FOUND when no config file exists', async () => {
    const e = await failure(loadConfig({ cwd: dir, env: {} }));
    expect(e.code).toBe('CONFIG_NOT_FOUND');
  });

  it('CONFIG_NOT_FOUND for an explicit missing configPath', async () => {
    const e = await failure(loadConfig({ cwd: dir, configPath: 'nope.json', env: {} }));
    expect(e.code).toBe('CONFIG_NOT_FOUND');
  });

  it('loads a .json config and resolves paths against cwd', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ $schema: 'x', docs: ['d/**/*.md'], baseURL: 'http://localhost:3000' }));
    const c = await loadConfig({ cwd: dir, env: {} });
    expect(c.docs).toEqual(['d/**/*.md']);
    expect(c.projectRoot).toBe(dir);
    expect(c.configPath).toBe(join(dir, 'ai-bdd.config.json'));
    expect(c.planDir).toBe(join(dir, '.ai-bdd/plans'));
  });

  it('loads a .mjs config with a default export', async () => {
    await write('ai-bdd.config.mjs', `export default { docs: ['m/*.md'], context: 'hello' };`);
    const c = await loadConfig({ cwd: dir, env: {} });
    expect(c.docs).toEqual(['m/*.md']);
    expect(c.context).toBe('hello');
  });

  it('loads a .ts config through native import() (type annotations allowed)', async () => {
    await write('ai-bdd.config.ts', `const docs: string[] = ['t/*.md'];\nexport default { docs };\n`);
    const c = await loadConfig({ cwd: dir, env: {} });
    expect(c.docs).toEqual(['t/*.md']);
  });

  it('prefers .ts over .mjs over .js over .json', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ context: 'json' }));
    expect((await loadConfig({ cwd: dir, env: {} })).context).toBe('json');
    await write('ai-bdd.config.js', `export default { context: 'js' };`);
    await write('package.json', JSON.stringify({ type: 'module' }));
    expect((await loadConfig({ cwd: dir, env: {} })).context).toBe('js');
    await write('ai-bdd.config.mjs', `export default { context: 'mjs' };`);
    expect((await loadConfig({ cwd: dir, env: {} })).context).toBe('mjs');
    await write('ai-bdd.config.ts', `export default { context: 'ts' };`);
    expect((await loadConfig({ cwd: dir, env: {} })).context).toBe('ts');
  });

  it('an explicit configPath wins over the search order', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ context: 'json' }));
    await mkdir(join(dir, 'conf'));
    await writeFile(join(dir, 'conf', 'other.json'), JSON.stringify({ context: 'other' }));
    const c = await loadConfig({ cwd: dir, configPath: 'conf/other.json', env: {} });
    expect(c.context).toBe('other');
  });

  it('CONFIG_INVALID for unknown keys in a file config', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ docs: [], bogus: 1 }));
    expect((await failure(loadConfig({ cwd: dir, env: {} }))).code).toBe('CONFIG_INVALID');
  });

  it('CONFIG_INVALID for malformed JSON and non-object exports', async () => {
    await write('ai-bdd.config.json', '{ nope');
    expect((await failure(loadConfig({ cwd: dir, env: {} }))).code).toBe('CONFIG_INVALID');
    await rm(join(dir, 'ai-bdd.config.json'));
    await write('ai-bdd.config.mjs', `export default 42;`);
    expect((await failure(loadConfig({ cwd: dir, env: {} }))).code).toBe('CONFIG_INVALID');
  });

  it('CONFIG_INVALID when the config module throws while loading', async () => {
    await write('ai-bdd.config.mjs', `throw new Error('boom');`);
    const e = await failure(loadConfig({ cwd: dir, env: {} }));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('boom');
  });

  it('JSON { use, options } resolves drivers and models through createDriverFactory / createModelSet', async () => {
    await write('driver.mjs', DRIVER_MODULE);
    await write('models.mjs', MODEL_MODULE);
    await write(
      'ai-bdd.config.json',
      JSON.stringify({
        drivers: { web: { use: './driver.mjs', options: { name: 'web' } } },
        models: { use: './models.mjs', options: { prefix: 'p:' } },
        baseURL: 'http://localhost:5173',
      }),
    );
    const c = await loadConfig({ cwd: dir, env: {} });
    expect(c.drivers['web']?.id).toBe('drv-web');
    expect(c.defaultDriver).toBe('web');
    expect(c.models?.judge.id).toBe('p:j');
  });

  it('CONFIG_INVALID when a "use" package lacks the factory export or cannot be found', async () => {
    await write('empty.mjs', `export const nothing = 1;`);
    await write('ai-bdd.config.json', JSON.stringify({ drivers: { web: { use: './empty.mjs' } } }));
    const e1 = await failure(loadConfig({ cwd: dir, env: {} }));
    expect(e1.code).toBe('CONFIG_INVALID');
    expect(e1.message).toContain('createDriverFactory');
    await write('ai-bdd.config.json', JSON.stringify({ models: { use: './empty.mjs' } }));
    expect((await failure(loadConfig({ cwd: dir, env: {} }))).message).toContain('createModelSet');
    await write('ai-bdd.config.json', JSON.stringify({ models: { use: './does-not-exist.mjs' } }));
    expect((await failure(loadConfig({ cwd: dir, env: {} }))).code).toBe('CONFIG_INVALID');
    await write('ai-bdd.config.json', JSON.stringify({ models: { use: './empty.mjs', extra: 1 } }));
    expect((await failure(loadConfig({ cwd: dir, env: {} }))).code).toBe('CONFIG_INVALID');
  });

  it('validates secrets against the supplied env (SECRET_TOO_SHORT) and applies CI defaults', async () => {
    await write('ai-bdd.config.json', JSON.stringify({ secrets: { pw: { env: 'PW' } } }));
    expect((await failure(loadConfig({ cwd: dir, env: { PW: 'ab' } }))).code).toBe('SECRET_TOO_SHORT');
    const c = await loadConfig({ cwd: dir, env: { PW: 'abcdef', CI: 'true' } });
    expect(c.ci).toBe(true);
    expect(c.recordingsMode).toBe('read-only');
    expect(JSON.stringify(c)).not.toContain('abcdef');
  });

  it('CONFIG_TS_UNSUPPORTED when the loader reports ERR_UNKNOWN_FILE_EXTENSION', async () => {
    await write('ai-bdd.config.ts', 'export default {};');
    const importer = () => Promise.reject(Object.assign(new TypeError('Unknown file extension ".ts"'), { code: 'ERR_UNKNOWN_FILE_EXTENSION' }));
    const e = await failure(loadConfigWith({ cwd: dir, env: {} }, importer));
    expect(e.code).toBe('CONFIG_TS_UNSUPPORTED');
    expect(e.message).toMatch(/\.mjs|\.json/);
    const e2 = await failure(importConfigModule(join(dir, 'ai-bdd.config.ts'), importer));
    expect(e2.code).toBe('CONFIG_TS_UNSUPPORTED');
  });

  it('unwraps CommonJS-style nested default exports', async () => {
    await write('ai-bdd.config.ts', 'export default {};');
    const importer = () => Promise.resolve({ default: { default: { context: 'cjs' } } });
    expect((await loadConfigWith({ cwd: dir, env: {} }, importer)).context).toBe('cjs');
  });
});
