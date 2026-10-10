// Chaos 5: latency and hangs. Slow drivers run into the settle timeout (on the engine's injected clock, so no real waiting); a call
// that never returns cannot hold the run hostage once it is aborted; and no matter how the run ends, every session the driver
// opened has been closed and the driver disposed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ChaosOptions, DriverRule, ModelRule } from '@ai-bdd/testing';
import { virtualClock } from '../acceptance/helpers/clock.ts';
import { CLI_BIN } from '../acceptance/helpers/paths.ts';
import {
  FAST,
  baseEnv,
  T,
  chaosEngine,
  compilePlain,
  createProject,
  expectDocumentedExit,
  expectReportSane,
  expectScenarioSane,
  latestRunDir,
  readRecordings,
  readRunReport,
  stepsOf,
  writeChaosConfig,
} from './helpers/kit.ts';

async function virtualEngine(rules: DriverRule[], extra: { overrides?: Record<string, unknown>; docs?: string[] } = {}) {
  const project = createProject({ docs: extra.docs ?? ['billing'] });
  await compilePlain(project);
  const clock = virtualClock();
  const sleep: NonNullable<ChaosOptions['sleep']> = (ms) => clock.sleep(ms);
  const ce = await chaosEngine(project, {
    clock,
    ...(extra.overrides === undefined ? {} : { overrides: extra.overrides }),
    driverPlan: { seed: 'lat', rules },
    chaosOptions: { sleep },
  });
  return { project, ce, clock };
}

describe('chaos 5: latency and the settle timeout', () => {
  it('a driver that answers within the settle window only makes the scenario slower (on the virtual clock): it passes, deterministically', async () => {
    const { project, ce, clock } = await virtualEngine([{ at: 'observe', fault: { kind: 'latency', ms: 40 } }]);
    try {
      const t0 = Date.now();
      const result = await ce.h.runScenario(T.upgrade);
      expect(Date.now() - t0, 'virtual latency costs no real time').toBeLessThan(10_000);
      expect(result.status).toBe('passed');
      expect(ce.driver?.stats.faults.observe).toBe(ce.driver?.stats.calls.observe);
      expect(clock.elapsed(), 'the engine clock saw the latency').toBeGreaterThanOrEqual((ce.driver?.stats.calls.observe ?? 0) * 40);
      expect(result.durationMs).toBeGreaterThan(40 * 10);
      await ce.h.close();
    } finally {
      project.cleanup();
    }
  });

  it('observations slower than settle.timeoutMs never settle: the check is not evaluated, the step fails with SCREEN_NOT_SETTLED, the run terminates', async () => {
    const { project, ce, clock } = await virtualEngine([{ at: 'observe', from: 1, fault: { kind: 'latency', ms: 9_000 } }], { overrides: { settle: { timeoutMs: 5_000, quietMs: 300, intervalMs: 100 } } });
    try {
      const result = await ce.h.runScenario(T.upgradeVisible);
      expect(result.status).toBe('failed');
      expect(result.steps[0]?.error?.code).toBe('SCREEN_NOT_SETTLED');
      expect(result.steps[0]?.error?.details).toMatchObject({ timeoutMs: 5_000 });
      expect(result.steps[0]?.check, 'no verdict on an unsettled screen').toBeUndefined();
      expect(result.recording).toMatch(/^(none|discarded)$/);
      expect(readRecordings(project)).toEqual([]);
      // bounded: a handful of settle rounds, not an endless loop
      expect(ce.driver?.stats.calls.observe).toBeLessThan(10);
      expect(clock.elapsed()).toBeLessThan(120_000);
      expect(ce.driver?.stats.openSessions()).toEqual([]);
      await ce.h.close();
    } finally {
      project.cleanup();
    }
  });

  it('latency on every driver hook, together with a lost session, still ends with all sessions closed and the driver disposed', async () => {
    const { project, ce, clock } = await virtualEngine([
      { at: 'create', fault: { kind: 'latency', ms: 2_000 } },
      { at: 'openSession', fault: { kind: 'latency', ms: 2_000 } },
      { at: 'perform', fault: { kind: 'latency', ms: 500 } },
      { at: 'close', fault: { kind: 'latency', ms: 3_000 } },
      { at: 'dispose', fault: { kind: 'latency', ms: 3_000 } },
      { at: 'observe', nth: 25, fault: { kind: 'drop-session' } },
    ]);
    try {
      const result = await ce.h.runScenario(T.upgrade);
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('DRIVER_ERROR');
      await ce.h.close();
      expect(ce.driver?.stats.sessionsOpened.length).toBeGreaterThan(0);
      expect(ce.driver?.stats.openSessions()).toEqual([]);
      expect(ce.driver?.stats.driversDisposed).toBe(1);
      expect(clock.elapsed(), 'the engine clock saw the injected delays').toBeGreaterThan(5_000);
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 5: a call that never returns', () => {
  async function abortedRun(driverRules: DriverRule[], modelRules: ModelRule[], opts: { workers?: number; docs?: string[] } = {}) {
    const project = createProject({ docs: opts.docs ?? ['billing'] });
    await compilePlain(project);
    const ce = await chaosEngine(project, {
      ...(driverRules.length > 0 ? { driverPlan: { seed: 'hang', rules: driverRules } } : {}),
      ...(modelRules.length > 0 ? { modelPlan: { seed: 'hang', rules: modelRules } } : {}),
    });
    const controller = new AbortController();
    const started = Date.now();
    const run = ce.h.run({ signal: controller.signal, workers: opts.workers ?? 1, ...(opts.docs === undefined ? { titles: [T.upgrade] } : {}) });
    setTimeout(() => controller.abort(), 250);
    const outcome = await Promise.race([
      run.then((report) => ({ report }), (error: unknown) => ({ error })),
      new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 20_000)),
    ]);
    return { project, ce, outcome, took: Date.now() - started };
  }

  const HUNG: [string, DriverRule[], ModelRule[]][] = [
    ['observe', [{ at: 'observe', nth: 6, fault: { kind: 'hang' } }], []],
    ['perform', [{ at: 'perform', nth: 2, fault: { kind: 'hang' } }], []],
    ['model.act (ignoring the signal)', [], [{ at: 'act', nth: 1, fault: { kind: 'hang', ignoreSignal: true } }]],
    ['model.judge (ignoring the signal)', [], [{ at: 'judge', nth: 1, fault: { kind: 'hang', ignoreSignal: true } }]],
    ['model.checkgen (ignoring the signal)', [], [{ at: 'checkgen', nth: 1, fault: { kind: 'hang', ignoreSignal: true } }]],
    ['model.act (honouring the signal)', [], [{ at: 'act', nth: 1, fault: { kind: 'hang' } }]],
  ];

  for (const [what, driverRules, modelRules] of HUNG) {
    it(`hung ${what}: aborting the run ends it with ABORTED (instead of waiting forever), the session is closed, nothing is recorded`, async () => {
      const { project, ce, outcome, took } = await abortedRun(driverRules, modelRules);
      try {
        expect('timedOut' in outcome, 'the run must terminate after the abort').toBe(false);
        const report = (outcome as { report: Awaited<ReturnType<typeof ce.h.run>> }).report;
        expect(report, `${JSON.stringify(outcome)}`).toBeDefined();
        expectReportSane(report, 1);
        const result = report.scenarios[0];
        expect(result?.status).toBe('error');
        expect(result?.error?.code).toBe('ABORTED');
        expectScenarioSane(result as NonNullable<typeof result>, 6);
        expect(report.exitCode).toBe(3);
        expect(took).toBeLessThan(15_000);
        expect(readRecordings(project)).toEqual([]);
        if (ce.driver !== undefined) expect(ce.driver.stats.openSessions(), 'every opened session was closed').toEqual([]);
        await ce.h.close();
        if (ce.driver !== undefined) expect(ce.driver.stats.driversDisposed).toBe(1);
      } finally {
        project.cleanup();
      }
    });
  }

  it('many scenarios, a hang in each driver call, workers > scenarios: the abort ends all of them, queued scenarios never open a session, the report is complete', async () => {
    const { project, ce, outcome } = await abortedRun([{ at: 'observe', nth: 7, fault: { kind: 'hang' } }, { at: 'perform', nth: 3, fault: { kind: 'hang' } }], [], { workers: 16, docs: ['billing', 'login'] });
    try {
      expect('timedOut' in outcome).toBe(false);
      const report = (outcome as { report: Awaited<ReturnType<typeof ce.h.run>> }).report;
      expectReportSane(report, 6);
      expect(report.scenarios.every((s) => s.status === 'error' || s.status === 'passed')).toBe(true);
      expect(report.scenarios.some((s) => s.error?.code === 'ABORTED')).toBe(true);
      expect(ce.driver?.stats.openSessions()).toEqual([]);
      expect(ce.driver?.stats.sessionsOpened.length, 'at most a main and a confirm session per scenario').toBeLessThanOrEqual(12);
      await ce.h.close();
    } finally {
      project.cleanup();
    }
  });

  it('a hung request() (a fixture seeding state) is cut by the abort as well', async () => {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, { driverPlan: { seed: 'req', rules: [{ at: 'request', nth: 1, fault: { kind: 'hang' } }] } });
      const controller = new AbortController();
      const run = ce.h.run({ signal: controller.signal, titles: [T.blocked] });
      setTimeout(() => controller.abort(), 300);
      const outcome = await Promise.race([run, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000))]);
      expect(outcome).not.toBe('timeout');
      const report = outcome as Awaited<typeof run>;
      expect(report.scenarios[0]?.status).toMatch(/^(error|failed)$/);
      expect(report.scenarios[0]?.steps.some((s) => s.error?.code === 'FIXTURE_FAILED' || s.error?.code === 'ABORTED') || report.scenarios[0]?.error?.code === 'ABORTED').toBe(true);
      expect(ce.driver?.stats.openSessions()).toEqual([]);
      await ce.h.close();
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 5: closing', () => {
  it('a dispose() that throws is reported by engine.close() as INTERNAL after every other cleanup ran', async () => {
    const project = createProject({ docs: ['billing'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, { driverPlan: { seed: 'd', rules: [{ at: 'dispose', fault: { kind: 'throw-raw', message: 'dispose exploded' } }] } });
      expect((await ce.h.runScenario(T.upgradeVisible)).status).toBe('passed');
      await expect(ce.h.close()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('dispose exploded') });
      expect(ce.driver?.stats.openSessions()).toEqual([]);
      expect(ce.driver?.stats.driversDisposed).toBe(1);
    } finally {
      project.cleanup();
    }
  });

  it('a close() that throws never changes a scenario result, for every scenario of the run', async () => {
    const project = createProject({ docs: ['billing', 'login'] });
    try {
      await compilePlain(project);
      const ce = await chaosEngine(project, { driverPlan: { seed: 'c', rules: [{ at: 'close', fault: { kind: 'throw-raw', message: 'close exploded' } }] } });
      const report = await ce.h.run({ workers: 3 });
      expect(report.exitCode).toBe(0);
      expect(report.totals.passed).toBe(report.scenarios.length);
      expect(ce.driver?.stats.sessionsClosed).toEqual(ce.driver?.stats.sessionsOpened);
      expect(report.scenarios.some((s) => JSON.stringify(s).includes('close exploded'))).toBe(false);
      const warned = ce.h.events.filter((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('close exploded'));
      expect(warned.length, 'the failure is visible as a warning').toBeGreaterThan(0);
      await ce.h.close();
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 5: Ctrl-C through the real CLI', () => {
  it('SIGINT while a driver call is hung: the CLI finishes up by itself (one Ctrl-C is enough), exits with a documented code and leaves a valid run directory', async () => {
    const project = createProject({ docs: ['login'], options: FAST });
    try {
      await compilePlain(project);
      const marker = join(project.dir, 'chaos-events.jsonl');
      const config = writeChaosConfig(project, { driverPlan: { seed: 'sigint', rules: [{ at: 'perform', nth: 2, fault: { kind: 'hang' } }] } });
      const child = spawn(process.execPath, ['--conditions=source', CLI_BIN, '-c', config, 'run', '--no-compile'], {
        cwd: project.dir,
        env: { ...baseEnv(), NODE_NO_WARNINGS: '1', ACME_ADMIN_PASSWORD: 'correct-horse-battery', CHAOS_MARKER: marker },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      const deadline = Date.now() + 60_000;
      while (!(existsSync(marker) && readFileSync(marker, 'utf8').includes('"fault":"hang"'))) {
        if (Date.now() > deadline) throw new Error(`the hang never started\n${stdout}\n${stderr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      child.kill('SIGINT');
      const code = await Promise.race([exited, new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 20_000))]);
      if (code === 'stuck') child.kill('SIGKILL');
      expect(code, `a single SIGINT must end the run\n${stdout}\n${stderr}`).not.toBe('stuck');
      expectDocumentedExit(code as number);
      expect(stderr).toContain('interrupted');
      expect(stderr).not.toMatch(/internal error|Unhandled/);
      const dir = latestRunDir(project);
      expectReportSane(readRunReport(dir), 1);
      expect(readRunReport(dir).scenarios[0]?.error?.code).toBe('ABORTED');
      expect(stepsOf(readRunReport(dir).scenarios[0] as never).length).toBeGreaterThan(0);
    } finally {
      project.cleanup();
    }
  });
});
