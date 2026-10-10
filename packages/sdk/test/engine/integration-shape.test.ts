import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type EngineModules } from '../../src/engine/index.ts';
import { loadConfig } from '../../src/config/index.ts';
import type { DocPlan, DriverSession, SessionOptions } from '../../src/contracts/index.ts';
import { makeFixture, totalModelCalls, type Fixture } from './fakes.ts';

/** Self-contained config packages used through the JSON `{ use, options }` form. */
const MODELS_MODULE = `
export function createModelSet() {
  const m = (id) => ({ id, generate: async () => ({ toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop', modelId: id }) });
  return { extract: m('ext'), act: m('act'), checkgen: m('chk'), judge: m('jdg') };
}`;
const DRIVER_MODULE = `
export function createDriverFactory() {
  return { id: 'pw', create: async () => { throw new Error('the host framework owns the browser; the driver must not be created'); } };
}`;

let dir: string;
let fx: Fixture;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-bdd-shape-'));
  await writeFile(join(dir, 'models.mjs'), MODELS_MODULE);
  await writeFile(join(dir, 'driver.mjs'), DRIVER_MODULE);
  await writeFile(
    join(dir, 'ai-bdd.config.json'),
    JSON.stringify({
      baseURL: 'http://localhost:4321',
      drivers: { web: { use: './driver.mjs' } },
      models: { use: './models.mjs' },
    }),
  );
  fx = await makeFixture();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(fx.world.tmp, { recursive: true, force: true });
});

/** What a framework integration does with the public API (spec section 4), with sibling modules faked. */
const fakeSession = (driverId: string): DriverSession => ({
  id: 'host-session',
  driverId,
  driverVersion: '1.2.3',
  capabilities: { verbs: ['click'], pixels: false, maskingProven: false, request: false, maxSessions: 1 },
  observe: () => Promise.reject(new Error('unused')),
  perform: () => Promise.reject(new Error('unused')),
  close: () => Promise.resolve(),
});

describe('integration shape (spec section 4)', () => {
  it('R-SDK1: plans load synchronously at collection time without touching models, drivers or the runner', async () => {
    await createEngine(await loadConfig({ cwd: dir, env: {} }), { modules: fx.modules }).then(async (e) => {
      await e.compile();
      await e.close();
    });
    const { world } = fx;
    world.modelCalls.length = 0;
    world.driversCreated.length = 0;
    world.runnerDepsSeen.length = 0;

    const config = await loadConfig({ cwd: dir, env: {} });
    // synchronous registration phase: no await between reading the plans and declaring the tests
    const plans: DocPlan[] = fx.modules.createPlanStore({ dir: config.planDir, readOnly: true }).loadAllSync();
    const declared: string[] = [];
    for (const plan of plans) for (const f of plan.features) for (const s of f.scenarios) if (s.review !== 'rejected') declared.push(s.id);

    expect(declared.length).toBe(3);
    expect(totalModelCalls(world)).toBe(0);
    expect(world.driversCreated).toEqual([]);
    expect(world.runnerDepsSeen).toEqual([]);
    expect(world.evidences).toHaveLength(0); // loading plans creates no run dir
  });

  it('R-SDK1 R-SDK3: loadConfig -> loadPlans -> createEngine -> runScenario(id, { sessionFactory }) -> close', async () => {
    const config = await loadConfig({ cwd: dir, env: {} });
    expect(config.baseURL).toBe('http://localhost:4321');
    const engine = await createEngine(config, { modules: fx.modules });
    await engine.compile();
    const plans = fx.modules.createPlanStore({ dir: config.planDir, readOnly: true }).loadAllSync();

    const adopted: SessionOptions[] = [];
    const statuses: [string, string][] = [];
    for (const plan of plans) {
      for (const f of plan.features) {
        for (const s of f.scenarios) {
          if (s.review === 'rejected') continue;
          const r = await engine.runScenario(s.id, {
            sessionFactory: (o) => {
              adopted.push(o);
              return Promise.resolve(fakeSession('host-pw'));
            },
          });
          statuses.push([s.id, r.status]);
        }
      }
    }
    await engine.close();

    expect(statuses.map(([, st]) => st)).toEqual(['passed', 'passed', 'passed']);
    // the engine handed engine-built SessionOptions to the host's factory
    expect(adopted.map((o) => o.scenarioId)).toEqual(statuses.map(([id]) => id));
    expect(adopted[0]?.baseURL).toBe('http://localhost:4321');
    expect(adopted[0]?.policy.allowHosts).toContain('localhost');
    expect(typeof adopted[0]?.resolveValue).toBe('function');
    // the configured driver was never created, because the host owns the session
    expect(fx.world.driversCreated).toEqual([]);
    expect(fx.world.sessionsOpened).toHaveLength(3);
    expect(fx.world.runnerCalls.every((c) => c.opts.sessionFactory !== undefined)).toBe(true);
  });

  it('R-SDK3: the run dir is created lazily, once per engine, and finalized by close()', async () => {
    const engine = await createEngine(fx.config, { modules: fx.modules });
    await engine.compile();
    expect(fx.world.evidences).toHaveLength(0);
    const ids = (await engine.listScenarios()).map((t) => t.scenario.id);
    const sf = (): Promise<DriverSession> => Promise.resolve(fakeSession('pw'));
    await engine.runScenario(ids[0] ?? '', { sessionFactory: sf });
    await engine.runScenario(ids[1] ?? '', { sessionFactory: sf });
    expect(fx.world.evidences).toHaveLength(1);
    const ev = fx.world.evidences[0];
    expect(ev?.finalized).toBe(0);
    // both scenarios shared one runner/evidence store
    expect(new Set(fx.world.runnerDepsSeen.map((d) => d.evidence.runId)).size).toBe(1);
    await engine.close();
    await engine.close();
    expect(ev?.finalized).toBe(1);
  });

  it('an engine that never ran a scenario never creates a run dir, and close() is a no-op on it', async () => {
    const engine = await createEngine(fx.config, { modules: fx.modules });
    await engine.compile();
    await engine.close();
    expect(fx.world.evidences).toHaveLength(0);
  });

  it('without sessionFactory, runScenario builds the configured driver for the scenario', async () => {
    const engine = await createEngine(fx.config, { modules: fx.modules });
    await engine.compile();
    const [first] = await engine.listScenarios();
    const result = await engine.runScenario(first?.scenario.id ?? '');
    expect(result.status).toBe('passed');
    expect(fx.world.driversCreated).toEqual(['fake']);
    expect([...(fx.world.runnerDepsSeen[0]?.drivers.keys() ?? [])]).toEqual(['fake']);
    await engine.close();
    expect(fx.world.driversDisposed).toEqual(['fake']);
  });

  it('runScenario on an unknown id is SCENARIO_NOT_FOUND', async () => {
    const engine = await createEngine(fx.config, { modules: fx.modules });
    await engine.compile();
    await expect(engine.runScenario('nope/nope')).rejects.toMatchObject({ code: 'SCENARIO_NOT_FOUND' });
    await engine.close();
  });

  it('events from runScenario reach listeners registered with engine.on', async () => {
    const engine = await createEngine(fx.config, { modules: fx.modules });
    await engine.compile();
    const seen: string[] = [];
    const off = engine.on((e) => seen.push(e.type));
    const [first] = await engine.listScenarios();
    await engine.runScenario(first?.scenario.id ?? '');
    off();
    expect(seen).toContain('scenario-end');
    await engine.close();
  });

  it('a closed engine refuses further work', async () => {
    const engine = await createEngine(fx.config, { modules: fx.modules });
    await engine.close();
    await expect(engine.compile()).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(engine.run()).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('the module type is public enough for hosts to inject fakes', () => {
    const partial: Partial<EngineModules> = { extractPromptVersion: 'x' };
    expect(partial.extractPromptVersion).toBe('x');
  });
});
