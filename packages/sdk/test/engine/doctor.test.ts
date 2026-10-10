import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/index.ts';
import { AiBddError, type Driver, type DriverFactory, type Engine, type UserConfig } from '../../src/contracts/index.ts';
import { createEngine, type EngineModules } from '../../src/engine/index.ts';
import { makeFixture, type Fixture } from './fakes.ts';

const open: { fx: Fixture; engine: Engine }[] = [];
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

type Check = { name: string; ok: boolean; detail: string };
const find = (checks: Check[], name: string): Check | undefined => checks.find((c) => c.name === name);

/** A fixture whose engine is built from `user` (merged over docs/models) and optional module overrides. */
async function setup(user: UserConfig = {}, overrides: Partial<EngineModules> = {}, projectOpts: { configPath?: string } = {}) {
  const fx = await makeFixture();
  const config = resolveConfig(
    { docs: ['docs/**/*.md'], baseURL: 'http://localhost:4000', models: fx.models, ...user },
    { projectRoot: fx.world.tmp, env: {}, ...projectOpts },
  );
  const engine = await createEngine(config, { modules: { ...fx.modules, ...overrides } });
  open.push({ fx, engine });
  return { fx, engine, world: fx.world, config };
}

function factory(id: string, selfCheck: Driver['selfCheck'], version = '2.3.4'): DriverFactory {
  return {
    id,
    async create() {
      return {
        id,
        version,
        capabilities: { verbs: ['click'], pixels: false, maskingProven: false, request: false, maxSessions: 1 },
        openSession: () => Promise.reject(new Error('unused')),
        selfCheck,
        dispose: () => Promise.resolve(),
      };
    },
  };
}

describe('doctor: node and config checks', () => {
  const withNodeVersion = async <T>(version: string, fn: () => Promise<T>): Promise<T> => {
    const original = process.versions.node;
    Object.defineProperty(process.versions, 'node', { value: version, configurable: true, enumerable: true, writable: false });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process.versions, 'node', { value: original, configurable: true, enumerable: true, writable: false });
    }
  };

  it.each([
    ['22.18.0', true],
    ['22.18.1', true],
    ['22.99.0', true],
    ['23.0.0', true],
    ['24.1.2', true],
    ['22.17.9', false],
    ['22.0.0', false],
    ['21.99.99', false],
    ['20.11.1', false],
  ])('the node check for version %s is ok=%s and names the version', async (version, ok) => {
    const { engine } = await setup({ drivers: { fake: factory('fake', async () => ({ ok: true, problems: [] })) } });
    const res = await withNodeVersion(version, () => engine.doctor({ offline: true }));
    expect(find(res.checks, 'node')).toEqual({ name: 'node', ok, detail: `Node ${version} (requires >= 22.18.0)` });
  });

  it('a failing node check fails the whole report', async () => {
    const { engine } = await setup({ drivers: { fake: factory('fake', async () => ({ ok: true, problems: [] })) }, defaultDriver: 'fake' });
    const res = await withNodeVersion('20.0.0', () => engine.doctor({ offline: true }));
    expect(res.ok).toBe(false);
    expect(res.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['node']);
  });

  it('without a config file the config check says so and names the project root', async () => {
    const { engine, config } = await setup();
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'config')).toEqual({ name: 'config', ok: true, detail: `no config file (project ${config.projectRoot})` });
  });

  it('with a config file the config check names it', async () => {
    const { engine, config } = await setup({}, {}, { configPath: '/work/ai-bdd.config.ts' });
    expect(config.configPath).toBe('/work/ai-bdd.config.ts');
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'config')).toEqual({ name: 'config', ok: true, detail: 'loaded /work/ai-bdd.config.ts' });
  });
});

describe('doctor: drivers', () => {
  const ok = async () => ({ ok: true, problems: [] as string[] });

  it('several drivers without a defaultDriver is reported, listing them, and each driver is still checked', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha', ok), beta: factory('beta', ok) } });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'drivers')).toEqual({ name: 'drivers', ok: false, detail: 'no defaultDriver set (configured: alpha, beta)' });
    expect(find(res.checks, 'driver:alpha')?.ok).toBe(true);
    expect(find(res.checks, 'driver:beta')?.ok).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('a defaultDriver that names no configured driver is reported with the configured names', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha', ok), beta: factory('beta', ok) }, defaultDriver: 'ghost' });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'drivers')).toEqual({ name: 'drivers', ok: false, detail: 'defaultDriver "ghost" is not a configured driver (alpha, beta)' });
    expect(res.ok).toBe(false);
  });

  it('a valid default driver reports the count and the default', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha', ok), beta: factory('beta', ok) }, defaultDriver: 'beta' });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'drivers')).toEqual({ name: 'drivers', ok: true, detail: '2 driver(s), default "beta"' });
  });

  it('a healthy driver reports its id and version', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha-id', ok, '9.8.7') }, defaultDriver: 'alpha' });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:alpha')).toEqual({ name: 'driver:alpha', ok: true, detail: 'alpha-id@9.8.7 ok' });
  });

  it('a failing self check lists its problems joined by "; "', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha', async () => ({ ok: false, problems: ['no browser', 'no display'] })) } });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:alpha')).toEqual({ name: 'driver:alpha', ok: false, detail: 'no browser; no display' });
  });

  it('a failing self check without problems still gets a message', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha', async () => ({ ok: false, problems: [] })) } });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:alpha')).toEqual({ name: 'driver:alpha', ok: false, detail: 'selfCheck failed' });
  });

  it('a self check that throws is reported with its message and does not stop the other drivers', async () => {
    const { engine } = await setup({
      drivers: {
        alpha: factory('alpha', () => Promise.reject(new Error('self check exploded'))),
        beta: factory('beta', ok),
      },
      defaultDriver: 'beta',
    });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:alpha')).toEqual({ name: 'driver:alpha', ok: false, detail: 'self check exploded' });
    expect(find(res.checks, 'driver:beta')?.ok).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('a non-Error thrown by a self check is reported by its string form', async () => {
    const { engine } = await setup({ drivers: { alpha: factory('alpha', () => Promise.reject('plain failure')) } });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:alpha')).toEqual({ name: 'driver:alpha', ok: false, detail: 'plain failure' });
  });
});

describe('doctor: models', () => {
  it('no models configured is a failed check with a hint', async () => {
    const fx = await makeFixture();
    const config = resolveConfig({ docs: ['docs/**/*.md'], drivers: fx.config.drivers }, { projectRoot: fx.world.tmp, env: {} });
    const engine = await createEngine(config, { modules: fx.modules });
    open.push({ fx, engine });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'models')).toEqual({ name: 'models', ok: false, detail: 'no models configured (set "models" in the config)' });
    const online = await engine.doctor();
    expect(find(online.checks, 'models')?.ok).toBe(false);
  });

  it('a model that fails with a plain error is unreachable and reported with its message', async () => {
    const { engine, world } = await setup({});
    world.failModel = { purpose: 'judge', error: new Error('socket hang up') };
    const res = await engine.doctor();
    expect(find(res.checks, 'model:fake-judge')).toEqual({ name: 'model:fake-judge', ok: false, detail: 'socket hang up' });
    expect(find(res.checks, 'model:fake-act')?.ok).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('an INTERNAL error from a model is not treated as proof of reachability', async () => {
    const { engine, world } = await setup({});
    world.failModel = { purpose: 'act', error: new AiBddError('INTERNAL', 'kaboom') };
    const res = await engine.doctor();
    expect(find(res.checks, 'model:fake-act')).toEqual({ name: 'model:fake-act', ok: false, detail: 'kaboom' });
  });

  it('a model-specific AiBddError other than unavailable counts as reachable and names the code', async () => {
    const { engine, world } = await setup({});
    world.failModel = { purpose: 'checkgen', error: new AiBddError('MODEL_NO_RULE', 'no scripted rule') };
    const res = await engine.doctor();
    expect(find(res.checks, 'model:fake-checkgen')).toEqual({
      name: 'model:fake-checkgen',
      ok: true,
      detail: 'reachable (checkgen); answered with MODEL_NO_RULE',
    });
  });

  it('purposes that share one model id are checked once and listed together', async () => {
    const fx = await makeFixture({ sameJudgeModel: true });
    const engine = await createEngine(fx.config, { modules: fx.modules });
    open.push({ fx, engine });
    fx.world.modelCalls.length = 0;
    const res = await engine.doctor();
    expect(res.checks.filter((c) => c.name.startsWith('model:')).map((c) => c.name)).toEqual(['model:fake-extract', 'model:fake-act', 'model:fake-checkgen']);
    expect(find(res.checks, 'model:fake-act')?.detail).toBe('reachable (act, judge)');
    expect(fx.world.modelCalls.map((c) => c.purpose)).toEqual(['extract', 'act', 'checkgen']);
    expect(fx.world.modelCalls.every((c) => c.context['doctor'] === true)).toBe(true);
  });
});

describe('doctor: plans', () => {
  it('a failure while analysing the project is reported as a failed plans check instead of throwing', async () => {
    const { engine } = await setup({}, { discoverDocs: () => Promise.reject(new Error('docs directory vanished')) });
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'plans')).toEqual({ name: 'plans', ok: false, detail: 'docs directory vanished' });
    expect(res.ok).toBe(false);
  });

  it('counts fresh, stale, not compiled and orphaned documents', async () => {
    const { engine, world } = await setup({ drivers: { fake: factory('fake', async () => ({ ok: true, problems: [] })) } });
    await engine.compile();
    world.docs.set('docs/todos.md', '# Todos\nedited text');
    world.docs.set('docs/extra.md', '# Extra\nA new document that was never compiled.');
    world.docs.delete('docs/billing.md');
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'plans')).toEqual({ name: 'plans', ok: false, detail: '3 doc(s): 0 fresh, 1 stale, 1 not compiled, 1 orphaned' });
  });
});
