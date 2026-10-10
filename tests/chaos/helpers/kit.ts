// Shared building blocks of the chaos suite: seeds that print themselves on failure, engines and CLI runs with fault
// injectors plugged in through the ordinary `drivers` / `models` keys, and invariant checkers for results and files.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect } from 'vitest';
import { createRecordingStore, loadPlansSync, verifyRun } from '@ai-bdd/sdk';
import {
  ERROR_CODES,
  type DocPlan,
  type ErrorCode,
  type RunReport,
  type ScenarioResult,
  type StepResult,
} from '@ai-bdd/sdk/contracts';
import {
  chaosDriver,
  chaosModels,
  type ChaosDriverFactory,
  type ChaosModelSet,
  type ChaosOptions,
  type DriverFaultPlan,
  type ModelFaultPlan,
} from '@ai-bdd/testing';
import { openEngine, type EngineHandle, type OpenEngineOptions } from '../../acceptance/helpers/engine.ts';
import type { ConfigOverrides, Project } from '../../acceptance/helpers/project.ts';
import { walkFiles } from '../../acceptance/helpers/scan.ts';

export { createProject, type Project, type ConfigOverrides } from '../../acceptance/helpers/project.ts';
export { openEngine, withEngine, type EngineHandle } from '../../acceptance/helpers/engine.ts';
export { runCli, cliOutput, type CliResult } from '../../acceptance/helpers/cli.ts';
export { walkFiles, findSecret, secretForms } from '../../acceptance/helpers/scan.ts';
export { latestRunDir, runDirs, readRunReport, readEvents } from '../../acceptance/helpers/runs.ts';
export { readPlans, readRecordings, planFiles, T, findScenario, allScenarios } from '../../acceptance/helpers/plans.ts';
export { ACME_DEFAULT_ADMIN_PASSWORD } from '../../acceptance/helpers/paths.ts';

// ───────────────────────── seeds

/** `CHAOS_SEED` replays a failure; otherwise every test uses its own fixed seed, so a plain run is deterministic too. */
export function seedFor(label: string): string {
  const fromEnv = process.env['CHAOS_SEED'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : label;
}

/** Runs `fn(seed)`; when it throws, prints the seed and the replay command and attaches them to the error message. */
export async function withSeed<T>(label: string, fn: (seed: string) => Promise<T>): Promise<T> {
  const seed = seedFor(label);
  try {
    return await fn(seed);
  } catch (err) {
    const hint = `[chaos] FAILED with seed "${seed}" (${label}); replay with CHAOS_SEED=${JSON.stringify(seed)}`;
    console.error(hint);
    if (err instanceof Error) err.message = `${err.message}\n${hint}`;
    throw err;
  }
}

// ───────────────────────── engines

/** Overrides that keep real-clock CLI runs fast (the engine tests use the virtual clock and do not need them). */
export const FAST = {
  characterize: { probeMs: 10 },
  settle: { quietMs: 20, intervalMs: 5, timeoutMs: 3000 },
} satisfies ConfigOverrides;

export interface ChaosEngine {
  h: EngineHandle;
  /** The chaos wrapper around the fake driver (undefined when no driver plan was given). */
  driver: ChaosDriverFactory | undefined;
  /** The chaos wrapper around the fake models (undefined when no model plan was given). */
  models: ChaosModelSet | undefined;
}

export interface ChaosEngineOptions extends Omit<OpenEngineOptions, 'wrapFactory' | 'models'> {
  driverPlan?: DriverFaultPlan;
  modelPlan?: ModelFaultPlan;
  /** Passed to the injectors (a custom `sleep` lets a test act at the exact moment a latency fault fires). */
  chaosOptions?: ChaosOptions;
}

/** An engine over the project with the fake driver / fake models wrapped by seeded fault plans. */
export async function chaosEngine(project: Project, opts: ChaosEngineOptions = {}): Promise<ChaosEngine> {
  const { driverPlan, modelPlan, chaosOptions, ...rest } = opts;
  const out: { driver?: ChaosDriverFactory; models?: ChaosModelSet } = {};
  const h = await openEngine(project, {
    ...rest,
    ...(driverPlan === undefined
      ? {}
      : {
          wrapFactory: (factory) => {
            const wrapped = chaosDriver(factory, driverPlan, chaosOptions);
            out.driver = wrapped;
            return wrapped;
          },
        }),
    ...(modelPlan === undefined
      ? {}
      : {
          models: (fake) => {
            const wrapped = chaosModels(fake, modelPlan, chaosOptions);
            out.models = wrapped;
            return wrapped;
          },
        }),
  });
  return { h, driver: out.driver, models: out.models };
}

/** Compile the project once with the plain fake models (no chaos) so later runs have plans. */
export async function compilePlain(project: Project): Promise<void> {
  const h = await openEngine(project);
  try {
    await h.compile();
  } finally {
    await h.close();
  }
}

// ───────────────────────── CLI with injectors

/**
 * A test config for CLI runs: the project's generated fake config, with the driver and the models wrapped by seeded fault plans.
 * The plans are embedded as JSON, so the spawned process injects exactly the faults the test described. Returns the config path.
 */
export function writeChaosConfig(
  project: Project,
  opts: {
    driverPlan?: DriverFaultPlan;
    modelPlan?: ModelFaultPlan;
    overrides?: Record<string, unknown>;
    flags?: string[];
    fileName?: string;
    /** The admin password of the fake Acme app (default: the corpus default), for runs whose secret has another value. */
    adminPassword?: string;
  } = {},
): string {
  const fileName = opts.fileName ?? 'ai-bdd.config.chaos.mjs';
  const base = project.writeTestConfig({
    fileName: 'ai-bdd.config.chaos-base.mjs',
    flags: opts.flags ?? [],
    overrides: { ...FAST, ...opts.overrides },
  });
  const baseName = relative(project.dir, base);
  const text = [
    "import { appendFileSync } from 'node:fs';",
    "import fsp from 'node:fs/promises';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { chaosDriver, chaosModels, fakeDriver } from '@ai-bdd/testing';",
    `import base from ${JSON.stringify(`./${baseName}`)};`,
    `const driverPlan = ${JSON.stringify(opts.driverPlan ?? null)};`,
    `const modelPlan = ${JSON.stringify(opts.modelPlan ?? null)};`,
    `const adminPassword = ${JSON.stringify(opts.adminPassword ?? null)};`,
    `const flags = ${JSON.stringify(opts.flags ?? [])};`,
    '// Slow disk: CHAOS_SLOW_RENAME=<regex> holds every rename whose destination matches for CHAOS_SLOW_RENAME_MS (default 1500),',
    '// leaving the temp file on disk, so a test can SIGKILL the process between the temp write and the rename.',
    'const slow = process.env.CHAOS_SLOW_RENAME ? new RegExp(process.env.CHAOS_SLOW_RENAME) : null;',
    'if (slow !== null) {',
    '  const realRename = fsp.rename;',
    '  fsp.rename = async (from, to) => {',
    '    if (slow.test(String(to))) await new Promise((r) => setTimeout(r, Number(process.env.CHAOS_SLOW_RENAME_MS ?? 1500)));',
    '    return realRename(from, to);',
    '  };',
    '  syncBuiltinESMExports();',
    '}',
    '// CHAOS_MARKER=<file>: every injected fault is appended there as one JSON line, so a test can wait for a fault to fire.',
    'const chaosOptions = { keepAlive: true, ...(process.env.CHAOS_MARKER ? { onEvent: (e) => appendFileSync(process.env.CHAOS_MARKER, `${JSON.stringify(e)}\\n`) } : {}) };',
    'const drivers = adminPassword === null ? base.drivers : { fake: fakeDriver({ flags, adminPassword }) };',
    'export default {',
    '  ...base,',
    '  drivers: driverPlan === null ? drivers : Object.fromEntries(Object.entries(drivers).map(([k, f]) => [k, chaosDriver(f, driverPlan, chaosOptions)])),',
    '  models: modelPlan === null ? base.models : chaosModels(base.models, modelPlan, chaosOptions),',
    '};',
    '',
  ].join('\n');
  const file = join(project.dir, fileName);
  writeFileSync(file, text);
  return file;
}

/** Path of a chaos config relative to the project, as `runCli({ config })` wants it. */
export const configArg = (project: Project, file: string): string => relative(project.dir, file);

// ───────────────────────── invariants

export const DOCUMENTED_EXIT_CODES = [0, 1, 2, 3, 4] as const;
const CODES: ReadonlySet<string> = new Set(ERROR_CODES);
const STATUSES = ['passed', 'failed', 'healed', 'blocked', 'skipped', 'inconclusive', 'error'];

export function expectDocumentedExit(code: number, context = ''): void {
  expect(DOCUMENTED_EXIT_CODES as readonly number[], `exit code ${code} is not one of the documented 0..4 ${context}`).toContain(code);
}

const RANK: Record<string, number> = { skipped: 0, passed: 1, healed: 2, blocked: 3, inconclusive: 4, failed: 5, error: 6 };

function expectStepSane(step: StepResult, where: string): void {
  expect(STATUSES, `${where}: step status`).toContain(step.status);
  if (step.error !== undefined) {
    expect(CODES.has(step.error.code), `${where}: unknown error code ${step.error.code}`).toBe(true);
    expect(typeof step.error.message, `${where}: error message`).toBe('string');
    expect(typeof step.error.retryable, `${where}: error retryable`).toBe('boolean');
  }
  if (['failed', 'error', 'blocked', 'inconclusive'].includes(step.status)) {
    expect(step.error ?? step.judge ?? step.check, `${where}: a ${step.status} step must say why`).toBeDefined();
  }
  if (step.status === 'passed' && step.path === 'check') expect(step.check?.passed, `${where}: a passed check step must have a passing check`).toBe(true);
}

/** Structural invariants of one scenario result, whatever faults hit it. */
export function expectScenarioSane(r: ScenarioResult, stepCount?: number): void {
  const where = `${r.scenarioId} [${r.status}]`;
  expect(STATUSES, where).toContain(r.status);
  if (stepCount !== undefined) expect(r.steps, `${where}: one result per plan step`).toHaveLength(stepCount);
  for (const s of r.steps) expectStepSane(s, `${where} / ${s.text}`);
  // the scenario status is the worst step status, or `error` when the scenario itself ended in an error
  const worst = r.steps.reduce((acc, s) => ((RANK[s.status] ?? 0) > (RANK[acc] ?? 0) ? s.status : acc), 'skipped' as string);
  if (r.error?.code === 'CHARACTERIZATION_UNSTABLE') {
    // the main run passed, a fresh confirm run did not reproduce it: failed, and nothing was committed
    expect([r.status, r.recording], `${where}: unstable characterization`).toEqual(['failed', 'discarded']);
  } else if (r.error === undefined || r.status !== 'error') {
    expect(r.status, `${where}: status must be the worst step status`).toBe(worst);
  }
  if (r.status === 'error') expect(r.error ?? r.steps.find((s) => s.status === 'error')?.error, `${where}: an error scenario names its cause`).toBeDefined();
  if (r.error !== undefined) expect(CODES.has(r.error.code), `${where}: unknown error code ${r.error.code}`).toBe(true);
  // a scenario that did not pass never ends up with a recording that claims it did
  if (r.status !== 'passed' && r.status !== 'healed') expect(['none', 'discarded', 'unchanged'], `${where}: recording ${r.recording}`).toContain(r.recording);
}

/** Structural invariants of a run report: complete, self-consistent, valid. */
export function expectReportSane(report: RunReport, expectedScenarios?: number): void {
  expect(report.schemaVersion).toBe(1);
  expect(typeof report.runId).toBe('string');
  expectDocumentedExit(report.exitCode, 'in the report');
  if (expectedScenarios !== undefined) expect(report.scenarios, 'every selected scenario has a result').toHaveLength(expectedScenarios);
  const counted: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const s of report.scenarios) {
    counted[s.status] = (counted[s.status] ?? 0) + 1;
    expectScenarioSane(s);
  }
  expect(report.totals).toEqual(counted);
  if (report.scenarios.some((s) => s.status === 'error')) expect(report.exitCode, 'an error scenario means infrastructure exit 3').toBe(3);
  if (report.exitCode === 0) expect(report.scenarios.every((s) => s.status === 'passed' || s.status === 'healed' || s.status === 'skipped')).toBe(true);
  expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
}

// ───────────────────────── files

/** Every plan, recording and finalized run under `.ai-bdd` must parse and validate; no torn writes. Returns counts. */
export async function expectStoreFilesValid(project: Project): Promise<{ plans: number; recordings: number; runs: number; unfinalizedRuns: number }> {
  const plans: DocPlan[] = existsSync(project.plansDir) ? loadPlansSync(project.plansDir) : [];
  const store = createRecordingStore({ dir: project.recordingsDir, mode: 'read-only' });
  const recordings = await store.list();
  for (const { driverId, scenarioId } of recordings) {
    const rec = await store.load(driverId, scenarioId);
    expect(rec, `recording ${driverId}/${scenarioId} must load`).not.toBeNull();
    expect(rec?.steps.length ?? 0).toBeGreaterThan(0);
  }
  let runs = 0;
  let unfinalized = 0;
  if (existsSync(project.runsDir)) {
    for (const name of readdirSync(project.runsDir)) {
      const dir = join(project.runsDir, name);
      if (!statSync(dir).isDirectory()) continue;
      runs += 1;
      if (!existsSync(join(dir, 'manifest.json'))) {
        unfinalized += 1; // killed before the engine finalized: documented as not finalized
        continue;
      }
      const verified = await verifyRun(dir);
      expect(verified.ok, `run ${name} must verify: ${JSON.stringify(verified)}`).toBe(true);
      const reportFile = join(dir, 'report.json');
      if (existsSync(reportFile)) expectReportSane(JSON.parse(readFileSync(reportFile, 'utf8')) as RunReport);
      for (const file of walkFiles(dir).filter((f) => f.endsWith('events.jsonl'))) {
        for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')) JSON.parse(line);
      }
    }
  }
  // every non-temp file with a JSON extension under .ai-bdd parses
  for (const file of walkFiles(project.aiBddDir)) {
    if (file.endsWith('.json') && !file.includes(`${join('.ai-bdd', 'cache')}`)) JSON.parse(readFileSync(file, 'utf8'));
  }
  return { plans: plans.length, recordings: recordings.length, runs, unfinalizedRuns: unfinalized };
}

export const stepsOf = (r: ScenarioResult): string[] => r.steps.map((s) => `${s.status}${s.error ? `:${s.error.code}` : ''}`);
export type { ErrorCode };
