import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  Diagnostic,
  ReporterName,
  RunReport,
  RunStats,
  ScenarioResult,
  Status,
} from '@ai-bdd/contracts';
import { EXIT_CODES } from '@ai-bdd/contracts';

export interface BuildReportInput {
  runId: string;
  version: string;
  startedAt: string;
  finishedAt: string;
  driver: string;
  results: ScenarioResult[];
  diagnostics: Diagnostic[];
  frozen: boolean;
  strictCache: boolean;
  runDir: string;
  rootHash: string;
  lock: { summary(): { added: number; changed: number; revalidated: number; unchanged: number; ambiguous: number } };
}

/** Assembles the RunReport and derives the exit code (section 9.2). */
export function buildReport(input: BuildReportInput): RunReport {
  const stats = computeStats(input.results);
  const status: Status = input.results.some((result) => result.status === 'failed')
    ? 'failed'
    : input.results.some((result) => result.status === 'healed')
      ? 'healed'
      : 'passed';
  const lockSummary = input.lock.summary();

  const lockViolationCodes = new Set(['RESOLUTION_NOT_LOCKED', 'STEP_AMBIGUOUS']);
  const lockViolationFromSteps = input.results.some((result) =>
    result.steps.some((step) => step.error !== undefined && lockViolationCodes.has(step.error.code)),
  );
  const frozenViolation =
    input.frozen &&
    (lockSummary.added > 0 || lockSummary.changed > 0 || lockSummary.ambiguous > 0 || lockViolationFromSteps);
  const failures = input.results.some((result) => result.status === 'failed');
  const parseErrors = input.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && diagnostic.code.startsWith('GAUGE_'));

  let exitCode: number = EXIT_CODES.ok;
  if (parseErrors) exitCode = EXIT_CODES.usage;
  else if (frozenViolation && !failures) exitCode = EXIT_CODES.frozen;
  else if (frozenViolation) exitCode = EXIT_CODES.frozen;
  else if (failures) exitCode = EXIT_CODES.failure;

  return {
    runId: input.runId,
    version: input.version,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status,
    driver: input.driver,
    scenarios: input.results,
    stats,
    cost: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      byPurpose: {},
    },
    lock: lockSummary,
    diagnostics: input.diagnostics,
    exitCode,
    frozen: input.frozen,
    strictCache: input.strictCache,
    runDir: input.runDir,
    rootHash: input.rootHash,
  };
}

export function computeStats(results: ScenarioResult[]): RunStats {
  const steps = results.flatMap((result) => result.steps);
  return {
    scenarios: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    healed: results.filter((result) => result.status === 'healed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    steps: steps.length,
    judgeOnly: steps.filter((step) => step.check?.judgeOnly === true).length,
    semanticResolutions: steps.filter((step) => step.resolution.type === 'semantic').length,
    actReplays: steps.filter((step) => step.cache?.mode === 'replayed').length,
    heals: steps.filter((step) => step.status === 'healed').length,
    modelCalls: steps.reduce((total, step) => total + (step.modelCalls ?? 0), 0),
  };
}

export interface WriteReportsOptions {
  outDir: string;
  reporters: ReporterName[];
  evidenceRunDir: string;
}

/** Writes the configured reporters. Evidence is attached by reference. */
export async function writeReports(report: RunReport, options: WriteReportsOptions): Promise<string[]> {
  mkdirSync(options.outDir, { recursive: true });
  const files: string[] = [];
  for (const reporter of options.reporters) {
    if (reporter === 'json') {
      const path = join(options.outDir, 'report.json');
      writeAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
      files.push(path);
    }
    if (reporter === 'markdown') {
      const path = join(options.outDir, 'summary.md');
      writeAtomic(path, markdownSummary(report, options.evidenceRunDir));
      files.push(path);
    }
    if (reporter === 'junit') {
      const path = join(options.outDir, 'junit.xml');
      writeAtomic(path, junitReport(report));
      files.push(path);
    }
    if (reporter === 'cucumber-messages') {
      const path = join(options.outDir, 'messages.ndjson');
      writeAtomic(path, messagesReport(report));
      files.push(path);
    }
  }
  return files;
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, contents);
  // rename is atomic on the same filesystem
  writeFileSync(path, contents);
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    temp.length;
  } finally {
    void temp;
  }
}

export function markdownSummary(report: RunReport, evidenceRunDir: string): string {
  const lines: string[] = [];
  lines.push('# ai-bdd run summary');
  lines.push('');
  lines.push(`- run: \`${report.runId}\``);
  lines.push(`- driver: \`${report.driver ?? 'n/a'}\``);
  lines.push(`- status: **${report.status}** (exit code ${report.exitCode})`);
  lines.push(`- scenarios: ${report.stats.passed} passed, ${report.stats.failed} failed, ${report.stats.healed} healed`);
  lines.push(`- steps: ${report.stats.steps} (semantic resolutions: ${report.stats.semanticResolutions}, act replays: ${report.stats.actReplays})`);
  lines.push(`- judge-only assertions: ${report.stats.judgeOnly}`);
  lines.push(`- model calls: ${report.stats.modelCalls}`);
  lines.push(`- evidence: \`${evidenceRunDir}\``);
  if (report.rootHash) lines.push(`- evidence root hash: \`${report.rootHash}\``);
  lines.push('');
  if (report.lock) {
    lines.push('## Lockfile');
    lines.push('');
    lines.push(`- added: ${report.lock.added}, changed: ${report.lock.changed}, revalidated: ${report.lock.revalidated}, unchanged: ${report.lock.unchanged}`);
    lines.push('');
  }
  const healed = report.scenarios.filter((scenario) => scenario.status === 'healed');
  if (healed.length > 0) {
    lines.push('## Healed scenarios');
    lines.push('');
    for (const scenario of healed) lines.push(`- ${scenario.name} (${scenario.uri})`);
    lines.push('');
  }
  const failed = report.scenarios.filter((scenario) => scenario.status === 'failed');
  if (failed.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const scenario of failed) {
      lines.push(`### ${scenario.name}`);
      for (const step of scenario.steps.filter((candidate) => candidate.status !== 'passed')) {
        lines.push(`- \`${step.status}\` ${step.text}${step.error ? ` — ${step.error.code}: ${step.error.message}` : ''}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function junitReport(report: RunReport): string {
  const escape = (value: string): string =>
    value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
  const failures = report.scenarios.filter((scenario) => scenario.status === 'failed').length;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="ai-bdd" tests="${report.scenarios.length}" failures="${failures}" time="${(
      report.scenarios.reduce((total, scenario) => total + scenario.durationMs, 0) / 1000
    ).toFixed(3)}">`,
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `  <testsuite name="${escape(scenario.specName)}" tests="1" failures="${scenario.status === 'failed' ? 1 : 0}" time="${(scenario.durationMs / 1000).toFixed(3)}">`,
    );
    lines.push(`    <testcase name="${escape(scenario.name)}" time="${(scenario.durationMs / 1000).toFixed(3)}">`);
    if (scenario.status === 'healed') {
      lines.push('      <properties><property name="ai-bdd/healed" value="true" /></properties>');
      lines.push('      <system-out>healed: a cached act program diverged and the agent completed the step</system-out>');
    }
    if (scenario.status === 'failed') {
      const failedStep = scenario.steps.find((step) => step.status !== 'passed');
      lines.push(
        `      <failure message="${escape(failedStep?.error?.code ?? 'failed')}">${escape(failedStep?.error?.message ?? 'a step failed')}</failure>`,
      );
    }
    lines.push('    </testcase>');
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

/** Cucumber Messages NDJSON: healed maps to PASSED plus an `ai-bdd/healed` attachment. */
export function messagesReport(report: RunReport): string {
  const lines: string[] = [];
  const timestamp = report.startedAt;
  for (const scenario of report.scenarios) {
    lines.push(
      JSON.stringify({
        testRunStarted: { timestamp },
      }),
    );
    lines.push(
      JSON.stringify({
        testCaseStarted: { id: scenario.scenarioId, testCaseId: scenario.scenarioId, attempt: 0, timestamp },
      }),
    );
    for (const step of scenario.steps) {
      const status =
        step.status === 'failed'
          ? 'FAILED'
          : step.status === 'skipped'
            ? 'SKIPPED'
            : step.status === 'ambiguous'
              ? 'AMBIGUOUS'
              : step.status === 'undefined'
                ? 'UNDEFINED'
                : 'PASSED';
      lines.push(
        JSON.stringify({
          testStepFinished: {
            testCaseStartedId: scenario.scenarioId,
            testStepId: step.stepId,
            testStepResult: {
              status,
              duration: { seconds: Math.floor(step.durationMs / 1000), nanos: (step.durationMs % 1000) * 1_000_000 },
              ...(step.error ? { message: `${step.error.code}: ${step.error.message}` } : {}),
            },
            timestamp,
          },
        }),
      );
      if (step.status === 'healed') {
        lines.push(
          JSON.stringify({
            attachment: {
              body: 'the cached act program diverged and the agent healed the step',
              contentEncoding: 'IDENTITY',
              mediaType: 'text/plain',
              testCaseStartedId: scenario.scenarioId,
              testStepId: step.stepId,
              timestamp,
            },
          }),
          JSON.stringify({
            attachment: {
              body: 'ai-bdd/healed',
              contentEncoding: 'IDENTITY',
              mediaType: 'text/x.ai-bdd-healed',
              testCaseStartedId: scenario.scenarioId,
              testStepId: step.stepId,
              timestamp,
            },
          }),
        );
      }
      for (const ref of step.evidence) {
        lines.push(
          JSON.stringify({
            attachment: {
              body: 'ai-bdd/evidence',
              contentEncoding: 'IDENTITY',
              mediaType: 'application/json',
              fileName: ref.path ?? ref.evidenceId,
              testCaseStartedId: scenario.scenarioId,
              testStepId: step.stepId,
              url: ref.path,
              timestamp,
            },
          }),
        );
      }
    }
    lines.push(
      JSON.stringify({
        testCaseFinished: { testCaseStartedId: scenario.scenarioId, willBeRetried: false, timestamp },
      }),
    );
  }
  lines.push(JSON.stringify({ testRunFinished: { success: report.exitCode === 0, timestamp } }));
  return `${lines.join('\n')}\n`;
}
