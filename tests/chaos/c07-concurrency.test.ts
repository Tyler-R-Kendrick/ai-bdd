// Chaos 7: concurrency. Several CLI processes work on the same project at once; many writers hit the same file; more workers than
// scenarios run under random driver faults. No file is ever corrupted, every process exits with a documented code (here: 0, since
// the work is independent and idempotent), and no gate is left held when a scenario dies.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlanStore, createRecordingStore, stableJson } from '@ai-bdd/sdk';
import type { DocPlan, JsonValue, ScenarioRecording } from '@ai-bdd/sdk/contracts';
import { findTempLeftovers, raceStart, type DriverRule } from '@ai-bdd/testing';
import {
  FAST,
  chaosEngine,
  cliOutput,
  compilePlain,
  createProject,
  expectDocumentedExit,
  expectReportSane,
  expectStoreFilesValid,
  planFiles,
  readPlans,
  readRecordings,
  runCli,
  walkFiles,
  withSeed,
  type Project,
} from './helpers/kit.ts';

const DOCS = ['billing', 'login'];
const planBytes = (project: Project): Record<string, string> => Object.fromEntries(Object.entries(planFiles(project)).filter(([k]) => k.endsWith('.plan.json')));

describe('chaos 7: several CLI processes on one project', () => {
  it('two concurrent compiles produce the plans of one compile; two concurrent runs both succeed and leave valid, complete stores', async () => {
    const ref = createProject({ docs: DOCS, options: FAST });
    try {
      expect((await runCli(ref, ['run'], { overrides: FAST })).code).toBe(0);
      const refPlans = planBytes(ref);
      const refRecordings = Object.fromEntries(walkFiles(ref.recordingsDir).map((f) => [f.slice(ref.recordingsDir.length), readFileSync(f, 'utf8')]));

      for (let round = 0; round < 1; round += 1) {
        const project = createProject({ docs: DOCS, options: FAST });
        try {
          const compiles = await Promise.all([runCli(project, ['compile'], { overrides: FAST }), runCli(project, ['compile'], { overrides: FAST })]);
          for (const r of compiles) {
            expectDocumentedExit(r.code);
            expect(r.code, cliOutput(r)).toBe(0);
          }
          expect(planBytes(project)).toEqual(refPlans);
          expect(findTempLeftovers(project.aiBddDir)).toEqual([]);

          const runs = await Promise.all([runCli(project, ['run'], { overrides: FAST }), runCli(project, ['run'], { overrides: FAST })]);
          for (const r of runs) {
            expectDocumentedExit(r.code);
            expect(r.code, cliOutput(r)).toBe(0);
            expect(r.stderr).not.toMatch(/internal error|Unhandled/);
          }
          const state = await expectStoreFilesValid(project);
          expect(state).toMatchObject({ plans: DOCS.length, unfinalizedRuns: 0 });
          expect(state.runs).toBe(2);
          expect(Object.fromEntries(walkFiles(project.recordingsDir).map((f) => [f.slice(project.recordingsDir.length), readFileSync(f, 'utf8')]))).toEqual(refRecordings);
          expect(findTempLeftovers(project.aiBddDir)).toEqual([]);
        } finally {
          project.cleanup();
        }
      }
    } finally {
      ref.cleanup();
    }
  });

  it('eight engines of one project finishing runs at the same moment (in-process, many rounds): every run succeeds and the latest-report copy is never half-replaced', async () => {
    const project = createProject({ docs: ['login'] });
    try {
      await compilePlain(project);
      const first = await chaosEngine(project);
      expect((await first.h.run()).exitCode).toBe(0);
      await first.h.close();
      for (let round = 0; round < 6; round += 1) {
        const engines = await Promise.all(Array.from({ length: 8 }, () => chaosEngine(project)));
        const outcomes = await Promise.allSettled(engines.map((e) => e.h.run()));
        const failures = outcomes.filter((o) => o.status === 'rejected').map((o) => String((o as PromiseRejectedResult).reason));
        expect(failures, `round ${round}`).toEqual([]);
        for (const o of outcomes) expect((o as PromiseFulfilledResult<Awaited<ReturnType<typeof first.h.run>>>).value.exitCode).toBe(0);
        const latest = JSON.parse(readFileSync(join(project.path('.ai-bdd', 'report'), 'report.json'), 'utf8')) as Parameters<typeof expectReportSane>[0];
        expectReportSane(latest, 1);
        await Promise.all(engines.map((e) => e.h.close()));
      }
      expect(findTempLeftovers(project.aiBddDir)).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it('four concurrent replays, repeatedly: all succeed (the latest-report copy is written atomically, not deleted and recreated) and .ai-bdd/report always holds a complete report', async () => {
    const project = createProject({ docs: DOCS, options: FAST });
    try {
      expect((await runCli(project, ['run'], { overrides: FAST })).code).toBe(0);
      for (let round = 0; round < 3; round += 1) {
        const results = await Promise.all([1, 2, 3, 4].map(() => runCli(project, ['run', '--no-compile'], { overrides: FAST })));
        for (const r of results) {
          expectDocumentedExit(r.code);
          expect(r.code, `round ${round}\n${cliOutput(r)}`).toBe(0);
        }
        const latest = JSON.parse(readFileSync(join(project.path('.ai-bdd', 'report'), 'report.json'), 'utf8')) as Parameters<typeof expectReportSane>[0];
        expectReportSane(latest, 6);
      }
      const state = await expectStoreFilesValid(project);
      expect(state.runs).toBe(1 + 3 * 4);
      expect(findTempLeftovers(project.aiBddDir)).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it('a re-characterizing process (-u) racing replaying processes: every reader sees a complete recording, everybody exits 0', async () => {
    const project = createProject({ docs: ['login'], options: FAST });
    try {
      expect((await runCli(project, ['run'], { overrides: FAST })).code).toBe(0);
      const results = await Promise.all([
        runCli(project, ['run', '--no-compile', '-u'], { overrides: FAST }),
        runCli(project, ['run', '--no-compile'], { overrides: FAST }),
        runCli(project, ['run', '--no-compile'], { overrides: FAST }),
        runCli(project, ['run', '--no-compile'], { overrides: FAST }),
      ]);
      for (const r of results) expect(r.code, cliOutput(r)).toBe(0);
      await expectStoreFilesValid(project);
      expect(readRecordings(project)).toHaveLength(1);
      expect(findTempLeftovers(project.aiBddDir)).toEqual([]);
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 7: many writers, one file', () => {
  it('concurrent saves of the same plan and the same recording: the file is always exactly one writer\'s complete version, no temp files remain, nobody errors', async () => {
    const project = createProject({ docs: ['login'], options: FAST });
    try {
      expect((await runCli(project, ['run'], { overrides: FAST })).code).toBe(0);
      const plan = readPlans(project)[0] as DocPlan;
      const recording = readRecordings(project)[0]?.recording as ScenarioRecording;

      const plans = createPlanStore({ dir: project.plansDir, readOnly: false });
      const planVariants = Array.from({ length: 24 }, (_, i): DocPlan => ({ ...plan, extractor: { modelId: `writer-${i}`, promptVersion: plan.extractor.promptVersion } }));
      const planResults = await raceStart(planVariants.map((v) => () => plans.save(v)));
      expect(planResults.filter((r) => r.status === 'rejected')).toEqual([]);
      const finalPlan = await plans.load(plan.docUri);
      expect(planVariants.map((v) => stableJson(v as unknown as JsonValue))).toContain(stableJson(finalPlan as unknown as JsonValue));

      const recordings = createRecordingStore({ dir: project.recordingsDir, mode: 'read-write' });
      const recVariants = Array.from({ length: 24 }, (_, i): ScenarioRecording => ({ ...recording, steps: recording.steps.map((s, k) => (k === 0 ? { ...s, stats: { healCount: i } } : s)) }));
      const recResults = await raceStart(recVariants.map((v) => () => recordings.save(v)));
      expect(recResults.filter((r) => r.status === 'rejected')).toEqual([]);
      const finalRec = await recordings.load(recording.driver.id, recording.scenarioId);
      expect(recVariants.map((v) => stableJson(v as unknown as JsonValue))).toContain(stableJson(finalRec as unknown as JsonValue));

      expect(findTempLeftovers(project.aiBddDir)).toEqual([]);
      await expectStoreFilesValid(project);
    } finally {
      project.cleanup();
    }
  });
});

describe('chaos 7: more workers than scenarios, under random driver faults', () => {
  const RULES = (): DriverRule[] => [
    { at: 'observe', probability: 0.02, fault: { kind: 'throw', code: 'DRIVER_ERROR' } },
    { at: 'observe', probability: 0.01, fault: { kind: 'drop-session' } },
    { at: 'perform', probability: 0.03, fault: { kind: 'fail', code: 'STALE_REF' } },
    { at: 'perform', probability: 0.02, fault: { kind: 'throw-raw', message: 'renderer crashed' } },
    { at: 'openSession', probability: 0.1, fault: { kind: 'throw', code: 'DRIVER_UNAVAILABLE' } },
    { at: 'observe', probability: 0.05, fault: { kind: 'garble', mode: 'shuffle' } },
    { at: 'observe', probability: 0.05, fault: { kind: 'latency', ms: 400 } },
    { at: 'close', probability: 0.1, fault: { kind: 'throw-raw', message: 'close failed' } },
  ];

  for (const [label, workers, prepare] of [
    ['16 workers, 6 scenarios', 16, undefined],
    ['16 workers, 6 scenarios, driver capped at 2 sessions', 16, { maxSessions: 2 }],
    ['8 workers, 6 scenarios, one exclusive resource', 8, { exclusiveResource: 'acme-database' }],
  ] as const) {
    for (const seedLabel of ['workers-a', 'workers-b']) {
      it(`${label} (${seedLabel}): the run terminates, every scenario has a sane result, no session leaks, no gate stays held`, async () => {
        await withSeed(`${seedLabel}/${workers}`, async (seed) => {
          const project = createProject({ docs: DOCS });
          try {
            await compilePlain(project);
            const ce = await chaosEngine(project, { driverPlan: { seed, rules: RULES() }, ...(prepare === undefined ? {} : { prepare }) });
            const report = await Promise.race([
              ce.h.run({ workers }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the run did not terminate (seed ${seed})`)), 90_000)),
            ]);
            expectReportSane(report, 6);
            expect(report.options.workers).toBe(workers);
            expect(ce.driver?.stats.faults.observe, 'the plan really injected faults').toBeGreaterThan(0);
            expect(ce.driver?.stats.openSessions(), 'sessions opened but never closed').toEqual([]);
            expect(report.scenarios.every((s) => s.recording !== 'created' || s.status === 'passed' || s.status === 'healed')).toBe(true);
            await ce.h.close();
            expect(ce.driver?.stats.driversDisposed).toBe(1);
            const state = await expectStoreFilesValid(project);
            expect(state.unfinalizedRuns).toBe(0);
            // whatever was recorded passed; a clean rerun finishes the job and everything passes
            const clean = await chaosEngine(project, prepare === undefined ? {} : { prepare });
            const again = await clean.h.run({ workers });
            expect(again.exitCode, `seed ${seed}`).toBe(0);
            expect(readRecordings(project)).toHaveLength(6);
            await clean.h.close();
          } finally {
            project.cleanup();
          }
        });
      });
    }
  }
});
