// @ts-nocheck
import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/index.ts';
import { AiBddError, type Engine } from '../../src/contracts/index.ts';
import { createEngine } from '../../src/engine/index.ts';
import { makeFixture, totalModelCalls, type Fixture } from './fakes.ts';

const open: { fx: Fixture; engine: Engine }[] = [];
async function setup(opts: Parameters<typeof makeFixture>[0] = {}, engineEnv?: Record<string, string | undefined>) {
  const fx = await makeFixture(opts);
  const engine = await createEngine(fx.config, { modules: fx.modules, ...(engineEnv === undefined ? {} : { env: engineEnv }) });
  open.push({ fx, engine });
  return { fx, engine, world: fx.world, config: fx.config };
}
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

const BILLING = 'docs-billing--billing/billing-works';
const DOWNGRADE = 'docs-billing--downgrading/downgrading-works';
const SC_TASKS = 'docs-todos--todos/todos-works';

describe('createEngine', () => {
  it('is lazy: creating, closing and using no-module methods never touches the real (stub) sibling modules', async () => {
    const fx = await makeFixture();
    const engine = await createEngine(fx.config); // default modules are the unimplemented stubs
    expect(engine.config).toBe(fx.config);
    const off = engine.on(() => undefined);
    off();
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  });

  it('is idempotent per config object when no overrides are given', async () => {
    const fx = await makeFixture();
    const a = await createEngine(fx.config);
    const b = await createEngine(fx.config);
    expect(b).toBe(a);
    await a.close();
    const c = await createEngine(fx.config);
    expect(c).not.toBe(a);
    await c.close();
    const withOverrides = await createEngine(fx.config, { modules: fx.modules });
    expect(withOverrides).not.toBe(c);
    await withOverrides.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  });

  it('without configured models, compile reports failed sections (CONFIG_INVALID cause) instead of crashing', async () => {
    const fx = await makeFixture();
    const cfg = resolveConfig({ docs: ['docs/**/*.md'] }, { projectRoot: fx.world.tmp, env: {} });
    const engine = await createEngine(cfg, { modules: fx.modules });
    const res = await engine.compile();
    expect(res.exitCode).toBe(1);
    expect(res.docs.flatMap((d) => d.diagnostics).some((d) => d.code === 'EXTRACT_SECTION_FAILED')).toBe(true);
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  });

  it('uses overrides.models and overrides.drivers instead of the config ones', async () => {
    const fx = await makeFixture();
    const other = await makeFixture();
    const engine = await createEngine(fx.config, { modules: fx.modules, models: other.models });
    await engine.compile();
    expect(other.world.modelCalls.length).toBe(3);
    expect(fx.world.modelCalls.length).toBe(0);
    await engine.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
    await rm(other.world.tmp, { recursive: true, force: true });
  });
});

describe('secrets (R-SE1)', () => {
  const SECRET = 'hunter22-very-secret';
  const user = { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } } };

  it('R-SE1: JSON.stringify(resolvedConfig) and the engine config contain no secret value', async () => {
    const { engine, config } = await setup({ user, env: { ADMIN_PASSWORD: SECRET } }, { ADMIN_PASSWORD: SECRET });
    for (const text of [JSON.stringify(config), JSON.stringify(engine.config)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
      expect(text).toContain('ADMIN_PASSWORD');
    }
  });

  it('R-SE1: values resolved from env at engine creation reach only the redactor and secretValue()', async () => {
    const { engine, world } = await setup({ user }, { ADMIN_PASSWORD: SECRET });
    await engine.run();
    expect(world.redactorSecrets).toEqual([{ adminPassword: SECRET }]);
    const deps = world.runnerDepsSeen[0];
    expect(deps?.secretValue('adminPassword')).toBe(SECRET);
    expect(deps?.secretValue('unknown')).toBeUndefined();
    expect(JSON.stringify(deps?.config)).not.toContain(SECRET);
  });

  it('R-SE1: reports are redacted before they are written (secret in a scenario title)', async () => {
    const docs = { 'docs/login.md': `# Login\n## Sign in with ${SECRET}\nUsers sign in with ${SECRET} as the password.` };
    const { engine, config } = await setup({ docs, user }, { ADMIN_PASSWORD: SECRET });
    const report = await engine.run();
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).toContain('<secret:adminPassword>');
    const latest = join(dirname(config.runsDir), 'report', 'report.json');
    expect(await readFile(latest, 'utf8')).not.toContain(SECRET);
  });

  it('R-SE1: a secret whose env value is shorter than 4 characters is SECRET_TOO_SHORT at engine creation', async () => {
    const fx = await makeFixture({ user });
    await expect(createEngine(fx.config, { modules: fx.modules, env: { ADMIN_PASSWORD: 'abc' } })).rejects.toMatchObject({ code: 'SECRET_TOO_SHORT' });
    await rm(fx.world.tmp, { recursive: true, force: true });
  });

  it('R-SE1: an unset secret env var is not an error and yields no redactor entry', async () => {
    const { engine, world } = await setup({ user }, {});
    await engine.run();
    expect(world.redactorSecrets).toEqual([{}]);
    expect(world.runnerDepsSeen[0]?.secretValue('adminPassword')).toBeUndefined();
  });
});

describe('plans, status, listScenarios, review', () => {
  it('status() reports per-doc freshness without calling a model', async () => {
    const { engine, world } = await setup();
    expect((await engine.status()).docs.map((d) => d.state)).toEqual(['new', 'new']);
    await engine.compile();
    world.modelCalls.length = 0;
    expect((await engine.status()).docs.map((d) => d.state)).toEqual(['fresh', 'fresh']);
    world.docs.set('docs/todos.md', '# Todos\nchanged text');
    const st = await engine.status();
    expect(st.docs.find((d) => d.docUri === 'docs/todos.md')).toMatchObject({ state: 'stale', dirtySections: ['docs/todos.md#todos'] });
    world.docs.delete('docs/billing.md');
    expect((await engine.status()).docs.find((d) => d.docUri === 'docs/billing.md')?.state).toBe('orphaned');
    expect(totalModelCalls(world)).toBe(0);
  });

  it('plans() returns the stored plans ordered by docUri', async () => {
    const { engine } = await setup();
    await engine.compile();
    expect((await engine.plans()).map((p) => p.docUri)).toEqual(['docs/billing.md', 'docs/todos.md']);
  });

  it('listScenarios: order by docUri then plan order; selectors (id, prefix, feature id, doc glob), tags, grep', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    const todos = world.plans.get('docs/todos.md');
    const sc = todos?.features[0]?.scenarios[0];
    if (sc) sc.tags = ['@smoke', 'fast'];
    const ids = async (f?: Parameters<Engine['listScenarios']>[0]) => (await engine.listScenarios(f)).map((t) => t.scenario.id);

    expect(await ids()).toEqual([BILLING, DOWNGRADE, SC_TASKS]);
    expect(await ids({ selectors: [SC_TASKS] })).toEqual([SC_TASKS]);
    expect(await ids({ selectors: ['docs-billing--'] })).toEqual([BILLING, DOWNGRADE]);
    expect(await ids({ selectors: ['docs-billing--downgrading/'] })).toEqual([DOWNGRADE]);
    expect(await ids({ selectors: ['docs-billing--downgrading'] })).toEqual([DOWNGRADE]); // feature id
    expect(await ids({ selectors: ['docs/**/*.md'] })).toEqual([BILLING, DOWNGRADE, SC_TASKS]);
    expect(await ids({ selectors: ['docs/todos.md'] })).toEqual([SC_TASKS]);
    expect(await ids({ selectors: ['docs/b*.md', SC_TASKS] })).toEqual([BILLING, DOWNGRADE, SC_TASKS]);
    expect(await ids({ selectors: ['unknown'] })).toEqual([]);
    expect(await ids({ tags: ['smoke'] })).toEqual([SC_TASKS]);
    expect(await ids({ tags: ['@fast', 'nope'] })).toEqual([SC_TASKS]);
    expect(await ids({ tags: ['nope'] })).toEqual([]);
    expect(await ids({ grep: 'DOWNGRADING' })).toEqual([DOWNGRADE]);
    expect(await ids({ selectors: ['docs-billing--'], grep: 'billing works' })).toEqual([BILLING]);
    expect(await ids({ selectors: ['docs-billing--'], tags: ['smoke'] })).toEqual([]);
  });

  it('review: accept / reject / pin / unpin edit and save the plan; rejected scenarios are hidden and never re-proposed (R-EX5)', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.planSaves.length = 0;
    await engine.review(DOWNGRADE, 'accept');
    expect(world.plans.get('docs/billing.md')?.features.find((f) => f.id === 'docs-billing--downgrading')?.scenarios[0]?.review).toBe('accepted');
    expect(world.planSaves).toEqual(['docs/billing.md']);

    await engine.review('docs-billing--billing', 'pin');
    expect(world.plans.get('docs/billing.md')?.features.find((f) => f.id === 'docs-billing--billing')?.pinned).toBe(true);
    await engine.review('docs-billing--billing', 'unpin');
    expect(world.plans.get('docs/billing.md')?.features.find((f) => f.id === 'docs-billing--billing')?.pinned).toBeUndefined();

    await engine.review(SC_TASKS, 'reject');
    expect(world.plans.get('docs/todos.md')?.rejected.map((r) => r.title)).toEqual(['Todos works']);
    expect((await engine.listScenarios()).map((t) => t.scenario.id)).toEqual([BILLING, DOWNGRADE]);

    await engine.compile({ full: true });
    expect((await engine.listScenarios()).map((t) => t.scenario.id)).not.toContain(SC_TASKS);
  });

  it('review of an unknown id is SCENARIO_NOT_FOUND and saves nothing', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.planSaves.length = 0;
    await expect(engine.review('ghost', 'accept')).rejects.toMatchObject({ code: 'SCENARIO_NOT_FOUND' });
    expect(world.planSaves).toEqual([]);
  });
});

describe('prune', () => {
  it('removes recordings whose scenario is in no plan; --dry-run only lists', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.recordings.set(`fake/${BILLING}`, {});
    world.recordings.set('fake/docs-gone--old/old-scenario', {});
    world.recordings.set('other/docs-gone--old/older', {});
    const dry = await engine.prune({ dryRun: true });
    expect(dry.removed).toEqual(['fake/docs-gone--old/old-scenario', 'other/docs-gone--old/older']);
    expect(world.recordings.size).toBe(3);
    const real = await engine.prune();
    expect(real.removed).toEqual(dry.removed);
    expect([...world.recordings.keys()]).toEqual([`fake/${BILLING}`]);
    expect((await engine.prune()).removed).toEqual([]);
  });

  it('keeps recordings of rejected scenarios (they are still in a plan)', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    await engine.review(SC_TASKS, 'reject');
    world.recordings.set(`fake/${SC_TASKS}`, {});
    expect((await engine.prune()).removed).toEqual([]);
  });

  it('R-RN4: refuses to delete in read-only recordings mode (but dry-run still lists)', async () => {
    const { engine, world } = await setup({ env: { CI: '1' } });
    await engine.compile();
    world.recordings.set('fake/ghost/one', {});
    expect((await engine.prune({ dryRun: true })).removed).toEqual(['fake/ghost/one']);
    await expect(engine.prune()).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    expect(world.recordings.size).toBe(1);
  });
});

describe('doctor', () => {
  const find = (checks: { name: string; ok: boolean; detail: string }[], name: string) => checks.find((c) => c.name === name);

  it('reports node, config, drivers, models and plan freshness; offline skips model reachability', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.modelCalls.length = 0;
    const res = await engine.doctor({ offline: true });
    expect(res.ok).toBe(true);
    expect(res.checks.map((c) => c.name)).toEqual(['node', 'config', 'drivers', 'driver:fake', 'models', 'plans']);
    expect(find(res.checks, 'models')?.detail).toMatch(/skipped/);
    expect(totalModelCalls(world)).toBe(0);
  });

  it('online it pings each distinct model; MODEL_UNAVAILABLE fails, a scripted-rule miss still counts as reachable', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.modelCalls.length = 0;
    const ok = await engine.doctor();
    expect(ok.checks.filter((c) => c.name.startsWith('model:')).map((c) => c.name)).toEqual(['model:fake-extract', 'model:fake-act', 'model:fake-checkgen', 'model:fake-judge']);
    expect(ok.ok).toBe(true);

    world.failModel = { purpose: 'judge', error: new AiBddError('MODEL_NO_RULE', 'no rule') };
    expect(find((await engine.doctor()).checks, 'model:fake-judge')?.ok).toBe(true);
    world.failModel = { purpose: 'judge', error: new AiBddError('MODEL_UNAVAILABLE', 'offline') };
    const bad = await engine.doctor();
    expect(find(bad.checks, 'model:fake-judge')?.ok).toBe(false);
    expect(bad.ok).toBe(false);
  });

  it('never throws for missing or broken drivers: it reports them', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.driverSelfCheck = { ok: false, problems: ['chromium not installed'] };
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:fake')).toMatchObject({ ok: false, detail: 'chromium not installed' });
    expect(res.ok).toBe(false);

    world.driverSelfCheck = { ok: true, problems: [] };
    const fx = await makeFixture({ user: { drivers: {} } });
    const noDrivers = await createEngine(resolveConfig({ docs: ['docs/**/*.md'] }, { projectRoot: fx.world.tmp, env: {} }), { modules: fx.modules });
    const res2 = await noDrivers.doctor({ offline: true });
    expect(find(res2.checks, 'drivers')).toMatchObject({ ok: false, detail: 'no drivers configured' });
    expect(find(res2.checks, 'models')?.ok).toBe(false);
    await noDrivers.close();
    await rm(fx.world.tmp, { recursive: true, force: true });
  });

  it('a driver whose factory throws is reported, not thrown', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.driverCreateError = new Error('cannot launch');
    const res = await engine.doctor({ offline: true });
    expect(find(res.checks, 'driver:fake')?.ok).toBe(false);
    expect(find(res.checks, 'driver:fake')?.detail).toMatch(/cannot launch/);
  });

  it('plan freshness: stale and orphaned docs fail the check, never-compiled docs do not', async () => {
    const { engine, world } = await setup();
    const fresh = await engine.doctor({ offline: true });
    expect(find(fresh.checks, 'plans')).toMatchObject({ ok: true });
    expect(find(fresh.checks, 'plans')?.detail).toMatch(/2 not compiled/);
    await engine.compile();
    world.docs.set('docs/todos.md', '# Todos\nedited');
    expect(find((await engine.doctor({ offline: true })).checks, 'plans')?.ok).toBe(false);
  });
});

describe('verifyRun', () => {
  it('delegates to the evidence module with a resolved path', async () => {
    const { engine, world, config } = await setup();
    await expect(engine.verifyRun('.ai-bdd/runs/abc')).resolves.toEqual({ ok: true, problems: [] });
    expect(world.verifyRunDirs).toEqual([join(config.projectRoot, '.ai-bdd/runs/abc')]);
    await engine.verifyRun('/abs/run');
    expect(world.verifyRunDirs[1]).toBe('/abs/run');
  });
});

describe('run directory contents', () => {
  it('each run() gets its own run dir under runsDir with a fresh runId', async () => {
    const { engine, config } = await setup();
    const a = await engine.run();
    const b = await engine.run({ compile: false });
    expect(a.runId).not.toBe(b.runId);
    expect((await readdir(config.runsDir)).sort()).toEqual([a.runId, b.runId].sort());
  });
});
