import { readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/index.ts';
import { AiBddError, type Engine, type RunEvent, type RunReport, type ScenarioStatus } from '../../src/contracts/index.ts';
import { createEngine } from '../../src/engine/index.ts';
import { makeFixture, modelUsage, totalModelCalls, type Fixture } from './fakes.ts';

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

const SCENARIO_BILLING = 'docs-billing--billing/billing-works';
const SCENARIO_DOWNGRADE = 'docs-billing--downgrading/downgrading-works';
const SCENARIO_TASKS = 'docs-todos--todos/todos-works';

describe('run pipeline', () => {
  it('compiles stale docs first, runs every non-rejected scenario in selection order and reports totals', async () => {
    const { engine, world } = await setup();
    const report = await engine.run();
    expect(report.exitCode).toBe(0);
    expect(report.scenarios.map((s) => s.scenarioId)).toEqual([SCENARIO_BILLING, SCENARIO_DOWNGRADE, SCENARIO_TASKS]);
    expect(report.totals).toEqual({ passed: 3, failed: 0, healed: 0, blocked: 0, skipped: 0, inconclusive: 0, error: 0 });
    expect(modelUsage(world).extract).toBe(3);
    expect(report.schemaVersion).toBe(1);
    expect(report.options).toMatchObject({ frozen: false, strict: false, audit: false, noAgent: false, updateRecordings: false, recordingsMode: 'read-write', workers: 4 });
    expect(new Date(report.startedAt).toString()).not.toBe('Invalid Date');
  });

  it('R-EX1: a second run makes zero extract calls and the run itself needs no model when scenarios replay', async () => {
    const { engine, world } = await setup();
    await engine.run();
    world.modelCalls.length = 0;
    const report = await engine.run();
    expect(totalModelCalls(world)).toBe(0);
    expect(report.usage.modelCalls).toBe(0);
    expect(report.usage.byPurpose.extract.modelCalls).toBe(0);
  });

  it('--no-compile (compile:false) skips compilation; selectors, tags and grep narrow the selection', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.modelCalls.length = 0;
    const r1 = await engine.run({ compile: false, selectors: ['docs-billing--'] });
    expect(r1.scenarios.map((s) => s.scenarioId)).toEqual([SCENARIO_BILLING, SCENARIO_DOWNGRADE]);
    const r2 = await engine.run({ compile: false, grep: 'TODOS' });
    expect(r2.scenarios.map((s) => s.scenarioId)).toEqual([SCENARIO_TASKS]);
    const r3 = await engine.run({ compile: false, selectors: ['docs/t*.md'] });
    expect(r3.scenarios.map((s) => s.scenarioId)).toEqual([SCENARIO_TASKS]);
    expect(totalModelCalls(world)).toBe(0);
  });

  it('a selector that matches nothing is SCENARIO_NOT_FOUND', async () => {
    const { engine } = await setup();
    await expect(engine.run({ selectors: ['nope--'] })).rejects.toMatchObject({ code: 'SCENARIO_NOT_FOUND' });
  });

  it('passes options to the runner and defaults workers from config.concurrency.scenarios', async () => {
    const { engine, world } = await setup({ user: { concurrency: { scenarios: 2 } } });
    await engine.run({ strict: true, audit: true, noAgent: true, driver: 'fake', workers: 7 });
    const call = world.runnerCalls[0];
    expect(call?.opts).toMatchObject({ strict: true, audit: true, noAgent: true, updateRecordings: false, driver: 'fake', workers: 7 });
    world.runnerCalls.length = 0;
    const report = await engine.run();
    expect(world.runnerCalls[0]?.opts.workers).toBe(2);
    expect(report.options.workers).toBe(2);
  });

  it('wires the runner with decorated models, the redactor, secretValue, config and drivers', async () => {
    const { engine, world, config } = await setup();
    await engine.run();
    const deps = world.runnerDepsSeen[0];
    expect(deps?.config).toBe(config);
    expect([...(deps?.drivers.keys() ?? [])]).toEqual(['fake']);
    expect(deps?.evidence.runId).toBe(world.evidences[0]?.runId);
  });

  it('writes reports into the run dir, copies them to .ai-bdd/report and finalizes the evidence', async () => {
    const { engine, world, config } = await setup();
    const report = await engine.run();
    const ev = world.evidences.find((e) => e.runId === report.runId);
    expect(ev).toBeDefined();
    expect(ev?.finalized).toBe(1);
    const runDirFiles = await readdir(ev?.dir ?? '');
    expect(runDirFiles).toEqual(expect.arrayContaining(['report.json', 'junit.xml', 'summary.md', 'manifest.json']));
    const latest = join(dirname(config.runsDir), 'report');
    expect((await readdir(latest)).sort()).toEqual(['junit.xml', 'report.json', 'summary.md']);
    const onDisk = JSON.parse(await readFile(join(latest, 'report.json'), 'utf8')) as RunReport;
    expect(onDisk.runId).toBe(report.runId);
    expect(world.reportersRequested[0]).toEqual(['json', 'junit', 'markdown']);
    const only = await engine.run({ reporters: ['json'], compile: false });
    expect(only.runId).not.toBe(report.runId);
    expect((await readdir(latest)).sort()).toEqual(['report.json']);
  });

  it('emits run-start, scenario-end and run-end events', async () => {
    const { engine } = await setup();
    const events: RunEvent[] = [];
    engine.on((e) => events.push(e));
    const report = await engine.run();
    const types = events.map((e) => e.type);
    expect(types).toContain('run-start');
    expect(types.filter((t) => t === 'scenario-end').length).toBe(3);
    expect(types[types.length - 1]).toBe('run-end');
    const start = events.find((e) => e.type === 'run-start');
    expect(start).toMatchObject({ runId: report.runId, scenarios: 3 });
  });

  it('skips rejected scenarios (R-EX5) and reports coverage', async () => {
    const { engine } = await setup();
    await engine.compile();
    await engine.review(SCENARIO_TASKS, 'reject');
    const report = await engine.run({ compile: false });
    expect(report.scenarios.map((s) => s.scenarioId)).toEqual([SCENARIO_BILLING, SCENARIO_DOWNGRADE]);
    const todos = report.coverage.docs.find((d) => d.docUri === 'docs/todos.md');
    expect(todos).toBeDefined();
    expect(report.coverage.docs.map((d) => d.docUri)).toEqual(['docs/billing.md', 'docs/todos.md']);
    expect(todos?.covered).toBe(0); // its only scenario was rejected
    const billing = report.coverage.docs.find((d) => d.docUri === 'docs/billing.md');
    expect(billing?.chunks).toBe(2);
    expect(billing?.covered).toBe(2);
  });
});

describe('usage and cost', () => {
  it('counts usage per purpose and estimates cost from configured prices', async () => {
    const { engine, world } = await setup({
      user: { prices: { 'fake-act': { inputPerMTok: 2, outputPerMTok: 10 }, 'fake-judge': { inputPerMTok: 4, outputPerMTok: 20 }, 'fake-extract': { inputPerMTok: 1, outputPerMTok: 1 } } },
    });
    world.tokens = { inputTokens: 1_000_000, outputTokens: 500_000 };
    world.scenarioModelCalls = { act: 1, judge: 2 };
    const report = await engine.run({ selectors: [SCENARIO_TASKS] });
    expect(report.usage.byPurpose.extract).toEqual({ modelCalls: 3, inputTokens: 3_000_000, outputTokens: 1_500_000 });
    expect(report.usage.byPurpose.act).toEqual({ modelCalls: 1, inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(report.usage.byPurpose.judge).toEqual({ modelCalls: 2, inputTokens: 2_000_000, outputTokens: 1_000_000 });
    expect(report.usage.byPurpose.checkgen.modelCalls).toBe(0);
    expect(report.usage.modelCalls).toBe(6);
    expect(report.usage.inputTokens).toBe(6_000_000);
    // extract 3*(1+0.5) + act (2+5) + judge 2*(4+10)
    expect(report.usage.estimatedCostUsd).toBeCloseTo(3 * 1.5 + 7 + 28, 6);
  });

  it('omits estimatedCostUsd when no prices are configured', async () => {
    const { engine } = await setup();
    const report = await engine.run();
    expect('estimatedCostUsd' in report.usage).toBe(false);
  });
});

describe('frozen runs (R-PL2)', () => {
  it('R-PL2: --frozen with a new/stale plan exits 4 and nothing runs, nothing compiles', async () => {
    const { engine, world } = await setup();
    const report = await engine.run({ frozen: true });
    expect(report.exitCode).toBe(4);
    expect(report.scenarios).toEqual([]);
    expect(report.warnings.filter((w) => w.code === 'PLAN_STALE').map((w) => w.uri)).toEqual(['docs/billing.md', 'docs/todos.md']);
    expect(world.runnerCalls).toEqual([]);
    expect(world.runnerDepsSeen).toEqual([]);
    expect(totalModelCalls(world)).toBe(0);
    expect(world.planSaves).toEqual([]);
    expect(world.evidences).toEqual([]); // no run dir is created
  });

  it('R-PL2: frozen after a doc edit exits 4; frozen with fresh plans runs without compiling', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.modelCalls.length = 0;
    const ok = await engine.run({ frozen: true });
    expect(ok.exitCode).toBe(0);
    expect(ok.scenarios.length).toBe(3);
    expect(ok.options.frozen).toBe(true);

    world.docs.set('docs/todos.md', '# Todos\nUsers can delete a todo item.');
    world.runnerCalls.length = 0;
    const stale = await engine.run({ frozen: true });
    expect(stale.exitCode).toBe(4);
    expect(world.runnerCalls).toEqual([]);
    expect(totalModelCalls(world)).toBe(0);
  });

  it('R-PL2: frozen also fails for orphaned plans (a doc was deleted)', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.docs.delete('docs/todos.md');
    expect((await engine.run({ frozen: true })).exitCode).toBe(4);
  });
});

describe('exit codes (R-RN3)', () => {
  type Case = { name: string; statuses: Record<string, ScenarioStatus>; stepError?: string; strict?: boolean; expected: 0 | 1 | 3 };
  const cases: Case[] = [
    { name: 'all passed', statuses: {}, expected: 0 },
    { name: 'healed is a pass without --strict', statuses: { [SCENARIO_BILLING]: 'healed' }, expected: 0 },
    { name: 'healed fails with --strict', statuses: { [SCENARIO_BILLING]: 'healed' }, strict: true, expected: 1 },
    { name: 'skipped is not a failure', statuses: { [SCENARIO_BILLING]: 'skipped' }, expected: 0 },
    { name: 'failed', statuses: { [SCENARIO_BILLING]: 'failed' }, expected: 1 },
    { name: 'inconclusive', statuses: { [SCENARIO_TASKS]: 'inconclusive' }, expected: 1 },
    { name: 'blocked', statuses: { [SCENARIO_DOWNGRADE]: 'blocked' }, expected: 1 },
    { name: 'error', statuses: { [SCENARIO_BILLING]: 'error' }, expected: 3 },
    { name: 'error takes precedence over failed', statuses: { [SCENARIO_BILLING]: 'error', [SCENARIO_TASKS]: 'failed' }, expected: 3 },
    { name: 'a failed scenario whose step hit DRIVER_UNAVAILABLE', statuses: { [SCENARIO_BILLING]: 'failed' }, stepError: 'DRIVER_UNAVAILABLE', expected: 3 },
    { name: 'a failed scenario whose step hit MODEL_UNAVAILABLE', statuses: { [SCENARIO_BILLING]: 'failed' }, stepError: 'MODEL_UNAVAILABLE', expected: 3 },
    { name: 'a failed scenario whose step hit an ordinary driver error stays 1', statuses: { [SCENARIO_BILLING]: 'failed' }, stepError: 'DRIVER_ERROR', expected: 1 },
  ];
  it.each(cases)('R-RN3: $name -> exit $expected', async (c) => {
    const { engine, world } = await setup();
    for (const [id, st] of Object.entries(c.statuses)) world.statuses.set(id, st);
    if (c.stepError !== undefined) world.stepErrors.set(SCENARIO_BILLING, { code: c.stepError as AiBddError['code'] });
    const report = await engine.run({ strict: c.strict === true });
    expect(report.exitCode).toBe(c.expected);
  });

  it('R-RN3: a model that is unavailable during the run is exit 3 even if the scenario is reported failed', async () => {
    const { engine, world } = await setup();
    await engine.compile();
    world.scenarioModelCalls = { act: 1 };
    world.failModel = { purpose: 'act', error: new AiBddError('MODEL_UNAVAILABLE', 'down') };
    world.statuses.set(SCENARIO_BILLING, 'failed');
    const report = await engine.run({ compile: false });
    expect(report.totals.failed).toBe(1);
    expect(report.exitCode).toBe(3);
  });

  it('R-RN3: failed extraction during the implicit compile makes the run exit 1 even if every scenario passes', async () => {
    const { engine, world } = await setup();
    world.failSections.add('todos');
    const report = await engine.run();
    expect(report.totals.failed).toBe(0);
    expect(report.exitCode).toBe(1);
    expect(report.warnings.some((w) => w.code === 'EXTRACT_MODEL_OUTPUT_INVALID')).toBe(true);
  });
});

describe('CI defaults (R-RN4)', () => {
  it('R-RN4: CI=1 makes run default to --frozen (stale plan -> exit 4) and recordings read-only', async () => {
    const { engine, world, config } = await setup({ env: { CI: '1' } });
    expect(config.ci).toBe(true);
    expect(config.recordingsMode).toBe('read-only');
    const report = await engine.run();
    expect(report.exitCode).toBe(4);
    expect(report.options.frozen).toBe(true);
    expect(report.options.recordingsMode).toBe('read-only');
    expect(world.runnerCalls).toEqual([]);
    expect(totalModelCalls(world)).toBe(0);
  });

  it('R-RN4: in CI with fresh plans the run is frozen and compiles nothing', async () => {
    const { engine, world } = await setup({ env: { CI: 'true' } });
    await engine.compile();
    world.modelCalls.length = 0;
    const report = await engine.run();
    expect(report.options.frozen).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(totalModelCalls(world)).toBe(0);
  });

  it('R-RN4: CI can be overridden explicitly with frozen:false (compiles first)', async () => {
    const { engine, world } = await setup({ env: { CI: '1' } });
    const report = await engine.run({ frozen: false });
    expect(report.options.frozen).toBe(false);
    expect(modelUsage(world).extract).toBe(3);
    expect(report.exitCode).toBe(0);
  });

  it('R-RN4: without CI, run is not frozen and recordings are read-write', async () => {
    const { engine, config } = await setup();
    expect(config.ci).toBe(false);
    expect(config.recordingsMode).toBe('read-write');
    expect((await engine.run()).options.frozen).toBe(false);
  });

  it('R-RN4: -u in CI fails with RECORDING_READ_ONLY unless AI_BDD_RECORDINGS=read-write; nothing runs', async () => {
    const { engine, world } = await setup({ env: { CI: '1' } });
    await expect(engine.run({ updateRecordings: true })).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    await expect(engine.runScenario(SCENARIO_BILLING, { updateRecordings: true })).rejects.toMatchObject({ code: 'RECORDING_READ_ONLY' });
    expect(world.runnerCalls).toEqual([]);

    const rw = await setup({ env: { CI: '1', AI_BDD_RECORDINGS: 'read-write' } });
    await rw.engine.compile();
    const report = await rw.engine.run({ updateRecordings: true, frozen: true });
    expect(report.exitCode).toBe(0);
    expect(rw.world.runnerCalls.every((c) => c.opts.updateRecordings)).toBe(true);
  });

  it('R-RN4: the recording store is created with the resolved mode and directory', async () => {
    const { engine, world, config } = await setup({ env: { CI: '1' } });
    await engine.compile();
    await engine.run({ frozen: true });
    expect(world.recordingOpts[0]).toEqual({ dir: config.recordingsDir, mode: 'read-only' });
  });

  it('R-RN4: AI_BDD_RECORDINGS=off is carried through to the runner', () => {
    const cfg = resolveConfig({}, { projectRoot: '/p', env: { AI_BDD_RECORDINGS: 'off' } });
    expect(cfg.recordingsMode).toBe('off');
  });
});

describe('model independence', () => {
  it('warns JUDGE_SAME_AS_ACTOR once (log event) and lists it in every report', async () => {
    const { engine } = await setup({ sameJudgeModel: true });
    const logs: string[] = [];
    engine.on((e) => {
      if (e.type === 'log') logs.push(e.message);
    });
    const r1 = await engine.run();
    const r2 = await engine.run();
    expect(logs.filter((l) => l.startsWith('JUDGE_SAME_AS_ACTOR')).length).toBe(1);
    expect(r1.warnings.some((w) => w.code === 'JUDGE_SAME_AS_ACTOR')).toBe(true);
    expect(r2.warnings.some((w) => w.code === 'JUDGE_SAME_AS_ACTOR')).toBe(true);
  });

  it('does not warn when judge and actor differ', async () => {
    const { engine } = await setup();
    expect((await engine.run()).warnings.some((w) => w.code === 'JUDGE_SAME_AS_ACTOR')).toBe(false);
  });
});

describe('driver wiring', () => {
  it('creates only the drivers the selection needs, once, and disposes them on close', async () => {
    const { engine, world } = await setup({ driverFactories: { other: { id: 'other', create: () => Promise.reject(new Error('should not be created')) } } });
    await engine.run();
    await engine.run({ compile: false });
    expect(world.driversCreated).toEqual(['fake']);
    await engine.close();
    expect(world.driversDisposed).toEqual(['fake']);
  });

  it('a driver that cannot be created becomes a DRIVER_UNAVAILABLE stand-in instead of crashing the run', async () => {
    const { engine, world } = await setup();
    world.driverCreateError = new Error('browser missing');
    const report = await engine.run();
    expect(report.scenarios.length).toBe(3);
    const deps = world.runnerDepsSeen[0];
    const driver = deps?.drivers.get('fake');
    await expect(driver?.openSession({ scenarioId: 'x', policy: { allowHosts: [], denyVerbs: [] }, resolveValue: () => '' })).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
  });
});
