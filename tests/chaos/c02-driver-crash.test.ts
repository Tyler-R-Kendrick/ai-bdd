// Chaos 2: the driver crashes or the session is lost in the middle of a scenario. The scenario ends `error` with the driver's own
// code, its remaining steps are skipped, no recording is written for it, every session is closed, and other scenarios (also those
// running at the same time) are unaffected. The run report stays complete and valid, and the CLI exits with a documented code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DriverRule } from '@ai-bdd/testing';
import {
  FAST,
  T,
  cliOutput,
  chaosEngine,
  compilePlain,
  configArg,
  createProject,
  expectDocumentedExit,
  expectReportSane,
  expectScenarioSane,
  expectStoreFilesValid,
  latestRunDir,
  readRecordings,
  readRunReport,
  runCli,
  stepsOf,
  writeChaosConfig,
  allScenarios,
  readPlans,
} from './helpers/kit.ts';

const UPGRADE_STEPS = 6;

async function upgradeWith(rules: DriverRule[]) {
  const project = createProject({ docs: ['billing'] });
  try {
    await compilePlain(project);
    const ce = await chaosEngine(project, { driverPlan: { seed: 'crash', rules } });
    const result = await ce.h.runScenario(T.upgrade);
    const files = await expectStoreFilesValid(project);
    const recordings = readRecordings(project);
    await ce.h.close();
    return { result, ce, recordings, files };
  } finally {
    project.cleanup();
  }
}

describe('chaos 2: session lost in the middle of one scenario', () => {
  const POINTS: [string, DriverRule][] = [
    ['the 2nd perform (first click)', { at: 'perform', nth: 2, fault: { kind: 'drop-session', message: 'browser crashed' } }],
    ['the 3rd perform (second action)', { at: 'perform', nth: 3, fault: { kind: 'drop-session', message: 'browser crashed' } }],
    ['the 5th observation (settling the first screen)', { at: 'observe', nth: 5, fault: { kind: 'drop-session', message: 'browser crashed' } }],
    ['the 12th observation (inside the steps)', { at: 'observe', nth: 12, fault: { kind: 'drop-session', message: 'browser crashed' } }],
    ['the 40th observation (late)', { at: 'observe', nth: 40, fault: { kind: 'drop-session', message: 'browser crashed' } }],
  ];
  for (const [label, rule] of POINTS) {
    it(`lost at ${label}: error with the driver's code, later steps skipped, no recording, session closed`, async () => {
      const { result, ce, recordings } = await upgradeWith([rule]);
      expect(result.status).toBe('error');
      expect(result.error).toMatchObject({ code: 'DRIVER_ERROR', retryable: true });
      expect(result.error?.message).toContain('browser crashed');
      expectScenarioSane(result, UPGRADE_STEPS);
      const firstBad = result.steps.findIndex((s) => s.status !== 'passed');
      expect(firstBad, 'something must have stopped').toBeGreaterThanOrEqual(0);
      if (result.steps[firstBad]?.status === 'error') expect(result.steps[firstBad]?.error?.code).toBe('DRIVER_ERROR');
      expect(result.steps.slice(firstBad + 1).every((s) => s.status === 'skipped'), `steps after the crash are skipped: ${stepsOf(result)}`).toBe(true);
      expect(result.recording).toBe('discarded');
      expect(recordings, 'no recording for a scenario that did not finish').toEqual([]);
      expect(ce.driver?.stats.sessionsOpened).toHaveLength(1);
      expect(ce.driver?.stats.openSessions(), 'the lost session was still closed').toEqual([]);
      expect(ce.driver?.stats.driversDisposed, 'engine.close() disposed the driver').toBe(1);
    });
  }

  it('a plain Error thrown by the driver (not an AiBddError) becomes INTERNAL with its message intact', async () => {
    const { result, ce } = await upgradeWith([{ at: 'observe', nth: 8, fault: { kind: 'throw-raw', message: 'segfault in renderer' } }]);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('INTERNAL');
    expect(result.error?.message).toBe('segfault in renderer');
    expect(ce.driver?.stats.openSessions()).toEqual([]);
  });

  it('close() failing after the crash is logged, never thrown: the result stays the original error', async () => {
    const { result, ce } = await upgradeWith([
      { at: 'perform', nth: 2, fault: { kind: 'drop-session' } },
      { at: 'close', fault: { kind: 'throw', code: 'DRIVER_ERROR', message: 'close failed too' } },
    ]);
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('session fake-1 was lost');
    expect(ce.driver?.stats.sessionsClosed).toEqual(['fake-1']);
    expect(JSON.stringify(result)).not.toContain('close failed too');
  });
});

describe('chaos 2: the session is lost during a confirm run', () => {
  it('is infrastructure (error, DRIVER_ERROR), not "the recording is unstable"; nothing is committed', async () => {
    for (const rule of [
      { at: 'perform', session: 2, nth: 2, fault: { kind: 'drop-session' } },
      { at: 'observe', session: 2, from: 3, fault: { kind: 'drop-session' } },
      { at: 'observe', session: 2, nth: 9, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } },
    ] as DriverRule[]) {
      const { result, recordings, ce } = await upgradeWith([rule]);
      expect(result.status, JSON.stringify(rule)).toBe('error');
      expect(result.error?.code, JSON.stringify(rule)).toMatch(/^DRIVER_(ERROR|UNAVAILABLE)$/);
      expect(result.error?.code).not.toBe('CHARACTERIZATION_UNSTABLE');
      expect(result.recording).toBe('discarded');
      expect(recordings).toEqual([]);
      expect(ce.driver?.stats.openSessions()).toEqual([]);
    }
  });

  it('a driver exception inside a replayed action of a confirm run reads as "did not replay": the step is stored FUZZY, never as a deterministic step that was not confirmed', async () => {
    const { result, recordings, ce } = await upgradeWith([{ at: 'perform', session: 2, nth: 2, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } }]);
    expect(result.status).toBe('passed');
    expect(result.confirm?.reclassified, 'the interrupted step was reclassified').toHaveLength(1);
    const reclassified = recordings[0]?.recording.steps.find((s) => result.confirm?.reclassified.includes(s.stepKey));
    expect(reclassified).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['confirm-replay-failed'] });
    expect(ce.driver?.stats.openSessions()).toEqual([]);
  });

  it('a confirm session that cannot even be opened leaves no recording and reports the driver code', async () => {
    const { result, recordings } = await upgradeWith([{ at: 'openSession', nth: 2, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } }]);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('DRIVER_UNAVAILABLE');
    expect(result.confirm).toMatchObject({ runs: 0 });
    expect(recordings).toEqual([]);
  });
});

describe('chaos 2: other scenarios keep running', () => {
  for (const workers of [1, 4]) {
    it(`one lost session among many (workers=${workers}): exactly one scenario errors, the rest pass and record; report complete and valid; rerun converges`, async () => {
      const project = createProject({ docs: ['billing', 'login'] });
      try {
        await compilePlain(project);
        const total = allScenarios(readPlans(project)).length;
        expect(total).toBeGreaterThanOrEqual(6);
        const ce = await chaosEngine(project, {
          driverPlan: { seed: 'iso', rules: [{ at: 'observe', session: 3, nth: 6, fault: { kind: 'drop-session', message: 'tab crashed' } }] },
        });
        const report = await ce.h.run({ workers });
        expectReportSane(report, total);
        const errored = report.scenarios.filter((s) => s.status === 'error');
        expect(errored, JSON.stringify(report.scenarios.map((s) => [s.title, s.status]))).toHaveLength(1);
        expect(errored[0]?.error).toMatchObject({ code: 'DRIVER_ERROR' });
        expect(['none', 'discarded'], 'nothing is committed for it').toContain(errored[0]?.recording);
        const others = report.scenarios.filter((s) => s.status !== 'error');
        expect(others.every((s) => s.status === 'passed'), 'unaffected scenarios pass').toBe(true);
        expect(others.every((s) => s.recording === 'created'), 'and record').toBe(true);
        expect(report.exitCode, 'an errored scenario is infrastructure').toBe(3);
        expect(report.totals.error).toBe(1);
        expect(report.totals.passed).toBe(total - 1);
        expect(ce.driver?.stats.openSessions()).toEqual([]);
        expect(readRecordings(project).map((r) => r.recording.scenarioId).sort()).toEqual(others.map((s) => s.scenarioId).sort());

        // the report on disk is the report returned, and the whole run directory verifies
        await ce.h.close();
        const onDisk = readRunReport(latestRunDir(project));
        expect(onDisk.totals).toEqual(report.totals);
        expect(onDisk.exitCode).toBe(3);
        expectReportSane(onDisk, total);
        const files = await expectStoreFilesValid(project);
        expect(files.unfinalizedRuns).toBe(0);

        // a clean rerun characterizes only what is missing and everything passes
        const again = await chaosEngine(project);
        const second = await again.h.run({ workers });
        expect(second.exitCode).toBe(0);
        expect(second.scenarios.filter((s) => s.recording === 'created')).toHaveLength(1);
        expect(readRecordings(project)).toHaveLength(total);
        await again.h.close();
      } finally {
        project.cleanup();
      }
    });
  }
});

describe('chaos 2: through the real CLI', () => {
  it('a lost session in one scenario: exit 3, ERROR line with the code, no internal error, valid report and run directory', async () => {
    const project = createProject({ docs: ['billing', 'login'], options: FAST });
    try {
      await compilePlain(project);
      const config = writeChaosConfig(project, { driverPlan: { seed: 'cli', rules: [{ at: 'perform', session: 2, nth: 1, fault: { kind: 'drop-session', message: 'tab crashed' } }] } });
      const r = await runCli(project, ['run', '--no-compile', '--workers', '2'], { config: configArg(project, config), timeoutMs: 120_000 });
      expectDocumentedExit(r.code);
      expect(r.code, cliOutput(r)).toBe(3);
      expect(r.stdout).toMatch(/^ERROR .*docs-/m);
      expect(r.stdout).toContain('DRIVER_ERROR');
      expect(r.stdout).toContain('Exit code: 3');
      expect(r.stderr).not.toMatch(/internal error|Unhandled|TypeError/);
      const dir = latestRunDir(project);
      const report = readRunReport(dir);
      expectReportSane(report);
      expect(report.exitCode).toBe(3);
      expect(report.scenarios.filter((s) => s.status === 'error')).toHaveLength(1);
      const verify = await runCli(project, ['verify-run', dir], { config: configArg(project, config) });
      expect(verify.code, cliOutput(verify)).toBe(0);
      expect(readFileSync(join(project.path('.ai-bdd', 'report'), 'report.json'), 'utf8')).toBe(readFileSync(join(dir, 'report.json'), 'utf8'));
    } finally {
      project.cleanup();
    }
  });

  it('the driver cannot even be created: every scenario errors with DRIVER_UNAVAILABLE, exit 3, nothing recorded', async () => {
    const project = createProject({ docs: ['login'], options: FAST });
    try {
      await compilePlain(project);
      const config = writeChaosConfig(project, { driverPlan: { seed: 'cli', rules: [{ at: 'create', fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE', message: 'no display' } }] } });
      const r = await runCli(project, ['run', '--no-compile'], { config: configArg(project, config) });
      expect(r.code, cliOutput(r)).toBe(3);
      expect(r.stdout).toContain('DRIVER_UNAVAILABLE');
      expect(r.stdout).toContain('no display');
      expect(readRecordings(project)).toEqual([]);
      const report = readRunReport(latestRunDir(project));
      expect(report.scenarios.every((s) => s.status === 'error' && s.error?.code === 'DRIVER_UNAVAILABLE')).toBe(true);
    } finally {
      project.cleanup();
    }
  });
});
