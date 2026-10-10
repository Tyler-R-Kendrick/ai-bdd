import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  AiBddError,
  type Diagnostic,
  type DocPlan,
  type JsonValue,
  type ReporterName,
  type RunOptions,
  type RunReport,
  type ScenarioResult,
  type ScenarioRunOptions,
  type ScenarioTarget,
} from '../contracts/index.ts';
import { uuidv7 } from '../util/index.ts';
import { compile } from './compile.ts';
import type { Core } from './core.ts';
import { buildUsage, computeCoverage, computeRunExitCode, countTotals } from './report.ts';
import { selectTargets } from './scenarios.ts';
import { errorMessage, throwIfAborted } from './util.ts';

type RunnerOpts = ScenarioRunOptions;

function guardRecordingsMode(core: Core, updateRecordings: boolean): void {
  if (updateRecordings && core.config.recordingsMode === 'read-only') {
    throw new AiBddError(
      'RECORDING_READ_ONLY',
      'Recordings are read-only (CI default), so --update-recordings is refused. Set AI_BDD_RECORDINGS=read-write to override.',
    );
  }
}

/** Driver names the selected targets will need (scenario > CLI > default, as in §9.2). */
function neededDrivers(core: Core, targets: readonly ScenarioTarget[], cliDriver: string | undefined): (string | undefined)[] {
  return targets.map((t) => t.scenario.driver ?? cliDriver ?? core.config.defaultDriver);
}

export async function runTarget(core: Core, target: ScenarioTarget, opts: Partial<ScenarioRunOptions> = {}): Promise<ScenarioResult> {
  core.assertOpen();
  const full: RunnerOpts = { updateRecordings: false, strict: false, noAgent: false, audit: false, ...opts };
  guardRecordingsMode(core, full.updateRecordings);
  core.warnOnce();
  // An adopted session (sessionFactory) never needs a configured driver.
  if (full.sessionFactory === undefined) await core.ensureDrivers(neededDrivers(core, [target], full.driver));
  const runner = await core.sharedRunner();
  return runner.runScenario(target, full);
}

async function writeReports(core: Core, report: RunReport, outDir: string, names: ReporterName[] | undefined, plans: readonly DocPlan[]): Promise<void> {
  const reporters = core.modules.createReporters(names ?? core.config.reporters);
  const written: string[] = [];
  for (const reporter of reporters) {
    try {
      const files = await reporter.render(report, { plans, outDir });
      written.push(...files.map((f) => f.path));
    } catch (err) {
      core.log('error', `reporter "${reporter.name}" failed: ${errorMessage(err)}`);
    }
  }
  // Latest report copy: .ai-bdd/report/ next to the runs dir.
  const latest = join(dirname(core.config.runsDir), 'report');
  await rm(latest, { recursive: true, force: true });
  await mkdir(latest, { recursive: true });
  for (const file of written) await copyFile(file, join(latest, basename(file)));
}

/** The run pipeline: frozen check -> optional compile -> select -> runner -> reporters -> RunReport. */
export async function run(core: Core, opts: RunOptions = {}): Promise<RunReport> {
  core.assertOpen();
  const { config } = core;
  const frozen = opts.frozen ?? config.ci;
  const shouldCompile = !frozen && (opts.compile ?? true);
  const strict = opts.strict === true;
  const updateRecordings = opts.updateRecordings === true;
  const audit = opts.audit === true;
  const noAgent = opts.noAgent === true;
  const workers = opts.workers ?? config.concurrency.scenarios;
  guardRecordingsMode(core, updateRecordings);
  throwIfAborted(opts.signal);

  const before = core.meter.snapshot();
  const startedAt = new Date(core.clock.now()).toISOString();
  const reportOptions: RunReport['options'] = { frozen, strict, audit, noAgent, updateRecordings, recordingsMode: config.recordingsMode, workers };
  const warnings: Diagnostic[] = [...core.warnings];
  core.warnOnce();

  const emptyReport = (runId: string, exitCode: RunReport['exitCode']): RunReport => {
    const usage = core.meter.since(before);
    return {
      schemaVersion: 1,
      runId,
      startedAt,
      finishedAt: new Date(core.clock.now()).toISOString(),
      options: reportOptions,
      scenarios: [],
      totals: countTotals([]),
      usage: buildUsage(usage.byPurpose, core.meter.pricesConfigured ? usage.costUsd : undefined),
      coverage: { docs: [] },
      warnings,
      exitCode,
    };
  };

  // 1. Frozen check: a stale or missing plan means exit 4 and nothing runs (R-PL2).
  if (frozen) {
    const check = await compile(core, { check: true });
    if (check.exitCode === 4) {
      for (const d of check.docs.filter((x) => x.state !== 'fresh')) {
        warnings.push({ code: 'PLAN_STALE', severity: 'error', message: `Plan for ${d.docUri} is ${d.state}; run "ai-bdd compile" (frozen mode)`, uri: d.docUri });
      }
      return emptyReport(uuidv7(core.clock.now()), 4);
    }
    if (check.exitCode === 2) {
      warnings.push(...check.docs.flatMap((d) => d.diagnostics.filter((x) => x.severity === 'error')));
      throw new AiBddError('DOC_READ_FAILED', 'Cannot read one or more documents', { details: { docs: check.docs.filter((d) => d.diagnostics.some((x) => x.severity === 'error')).map((d) => d.docUri) } });
    }
  }

  const evidence = await core.newEvidence();
  let compileFailed = false;
  try {
    // 2. Optional compile (default unless frozen / --no-compile).
    if (shouldCompile) {
      const compiled = await compile(core, opts.signal === undefined ? {} : { signal: opts.signal }, evidence);
      for (const d of compiled.docs) warnings.push(...d.diagnostics.filter((x) => x.severity !== 'info'));
      if (compiled.exitCode === 2) throw new AiBddError('DOC_READ_FAILED', 'Cannot read one or more documents');
      compileFailed = compiled.docs.some((d) => d.failedSections.length > 0);
    }

    // 3. Select.
    const plans = await core.planStore().loadAll();
    const selection = {
      ...(opts.selectors === undefined ? {} : { selectors: opts.selectors }),
      ...(opts.tags === undefined ? {} : { tags: opts.tags }),
      ...(opts.grep === undefined ? {} : { grep: opts.grep }),
    };
    const targets = selectTargets(plans, selection, { strictSelectors: true });
    core.emit({ type: 'run-start', runId: evidence.runId, scenarios: targets.length });

    // 4. Run.
    await core.ensureDrivers(neededDrivers(core, targets, opts.driver));
    const runner = core.buildRunner(evidence);
    const runOpts: RunnerOpts & { workers: number } = {
      updateRecordings,
      strict,
      noAgent,
      audit,
      workers,
      ...(opts.driver === undefined ? {} : { driver: opts.driver }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    };
    const results = await runner.runAll(targets, runOpts);

    // 5. Report.
    const usage = core.meter.since(before);
    const report: RunReport = {
      schemaVersion: 1,
      runId: evidence.runId,
      startedAt,
      finishedAt: new Date(core.clock.now()).toISOString(),
      options: reportOptions,
      scenarios: results,
      totals: countTotals(results),
      usage: buildUsage(usage.byPurpose, core.meter.pricesConfigured ? usage.costUsd : undefined),
      coverage: computeCoverage(plans),
      warnings,
      exitCode: computeRunExitCode(results, { strict, modelUnavailable: usage.unavailable > 0, compileFailed }),
    };
    // Reports are redacted like every other artifact before they touch the disk (R-SE1).
    const safe = core.redactor().redactJson(report as unknown as JsonValue) as unknown as RunReport;
    await writeReports(core, safe, evidence.dir, opts.reporters, plans);
    core.emit({ type: 'run-end', report: safe });
    return safe;
  } finally {
    await evidence.finalize();
  }
}
