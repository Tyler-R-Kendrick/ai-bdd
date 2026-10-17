// M28: report.json is a published contract. Real CLI runs of the offline test project (fake driver, fake models) write reports, and
// the committed JSON Schema accepts every one of them. The same runs are the evidence for what docs/cli.md says about the exit
// codes and about the three commands a release gate replays.
//
//   UPDATE_REPORT_FIXTURES=1 pnpm exec vitest run --project acceptance tests/acceptance/m28-run-report-contract.test.ts
//
// rewrites packages/sdk/test/report/fixtures/report.v1.{passed,failed}.json from the first two tests, byte for byte as the
// reporter wrote them.
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunReport } from '@ai-bdd/sdk/contracts';
import {
  type FixtureName,
  describeErrors,
  fixturePath,
  runReportValidator,
  validateWithSchema,
} from '../../packages/sdk/test/report/schema-kit.ts';
import { cliOutput, runCli, type CliOptions, type CliResult } from './helpers/cli.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { latestRunDir } from './helpers/runs.ts';

const UPDATE = process.env['UPDATE_REPORT_FIXTURES'] === '1';
const validate = runReportValidator();

/** The scenarios of the demo corpus that replay with no agent; the others (the downgrade pair, todos, checkout) need one. */
const REPLAYABLE = ['docs-billing--upgrade-to-pro/', 'docs-billing--friendly-confirmation-messages/', 'docs/release-notes.md', 'docs/reports.md'];
const GATE = ['run', '--frozen', '--no-agent', '--reporter', 'json,junit', ...REPLAYABLE];

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

function expectExit(r: CliResult, code: number): CliResult {
  expect(r.code, cliOutput(r)).toBe(code);
  return r;
}

async function ok(p: Project, args: string[], opts: CliOptions = {}): Promise<CliResult> {
  return expectExit(await runCli(p, args, opts), 0);
}

/** `.ai-bdd/report/report.json` as written (text) and parsed, checked against the published schema. */
function readReport(p: Project): { text: string; report: RunReport } {
  const text = readFileSync(p.path('.ai-bdd', 'report', 'report.json'), 'utf8');
  const verdict = validateWithSchema(validate, JSON.parse(text));
  expect(verdict.valid, `report.json is not valid against run-report.v1.schema.json: ${describeErrors(verdict.errors)}`).toBe(true);
  return { text, report: JSON.parse(text) as RunReport };
}

function capture(name: FixtureName, text: string): void {
  if (UPDATE) writeFileSync(fixturePath(name), text);
}

const runDirCount = (p: Project): number => readdirSync(p.runsDir).length;

describe('M28 the run report contract (fake driver, fake models, real CLI)', () => {
  it('M28 R-RN3 R-EV1: the replay-only gate (compile --check, run --frozen --no-agent, verify-run) exits 0 with a schema-valid report', async () => {
    const p = createProject({ docs: ['billing', 'release-notes', 'reports'], options: FAST_REAL });
    project = p;
    await ok(p, ['compile']);
    await ok(p, ['run']); // characterizes: writes the recordings the gate replays

    await ok(p, ['compile', '--check']);
    const gate = await ok(p, GATE);
    expect(gate.stdout).toContain('Model calls: 0');
    const { text, report } = readReport(p);
    expect(report.exitCode).toBe(0);
    expect(report.options).toMatchObject({ frozen: true, noAgent: true, strict: false });
    expect(report.scenarios).toHaveLength(5);
    expect(report.scenarios.map((s) => `${s.status}/${s.mode}`)).toEqual(Array<string>(5).fill('passed/replay'));
    expect(report.usage.modelCalls).toBe(0);
    expect(report.totals).toMatchObject({ passed: 5, failed: 0, error: 0 });

    // the run directory is named by the run id, holds the same report, and verifies
    const runDir = latestRunDir(p);
    expect(basename(runDir)).toBe(report.runId);
    expect(readFileSync(`${runDir}/report.json`, 'utf8')).toBe(text);
    expect((await ok(p, ['verify-run', runDir])).stdout).toContain('OK');
    capture('passed', text);
  });

  it('M28 R-RN3: --no-agent stops the agent, not the judge: a subjective step asks the judge again when the verdict cache is cold', async () => {
    const p = createProject({ docs: ['billing'], options: FAST_REAL });
    project = p;
    await ok(p, ['compile']);
    await ok(p, ['run']);
    const gate = ['run', '--frozen', '--no-agent', '--reporter', 'json', 'docs-billing--friendly-confirmation-messages/'];

    await ok(p, gate);
    expect(readReport(p).report.usage.modelCalls, 'the characterizing run left the judge verdict in .ai-bdd/cache').toBe(0);

    rmSync(p.cacheDir, { recursive: true, force: true }); // .ai-bdd/cache is not committed, so a fresh checkout starts like this
    await ok(p, gate);
    const { report } = readReport(p);
    expect(report.exitCode).toBe(0);
    expect(report.usage.byPurpose.act.modelCalls).toBe(0);
    expect(report.usage.byPurpose.judge.modelCalls).toBeGreaterThan(0);
  });

  it('M28 R-RN3: a regression exits 1, and its report (a failed check, a failed judge, healed steps, discarded recordings) is schema-valid', async () => {
    const p = createProject({ docs: ['billing'], options: FAST_REAL });
    project = p;
    await ok(p, ['compile']);
    await ok(p, ['run']);

    // the same suite against a build where the upgrade does nothing (the Acme flag), with the heal turn the fake models answer
    const r = expectExit(await runCli(p, ['run', '--frozen', '--reporter', 'json,junit'], { flags: ['bug-upgrade-noop'], layers: ['bug-heal-done', 'base'] }), 1);
    expect(r.stdout).toContain('Exit code: 1');
    const { text, report } = readReport(p);
    expect(report.exitCode).toBe(1);
    expect(report.totals).toMatchObject({ passed: 3, failed: 2 });
    const codes = report.scenarios.flatMap((s) => (s.error === undefined ? [] : [s.error.code]));
    expect(codes.sort()).toEqual(['CHECK_FAILED', 'JUDGE_FAILED']);
    expect(report.scenarios.flatMap((s) => s.steps).some((s) => s.status === 'healed')).toBe(true);
    expect(report.scenarios.filter((s) => s.status === 'failed').map((s) => s.recording)).toEqual(['discarded', 'discarded']);
    capture('failed', text);
  });

  it('M28 R-RN3: infrastructure is exit 3, and the report of that run is schema-valid too (a scenario ends error)', async () => {
    const p = createProject({ docs: ['login'], options: FAST_REAL });
    project = p;
    await ok(p, ['compile']);
    const r = expectExit(await runCli(p, ['run'], { env: { ACME_ADMIN_PASSWORD: undefined } }), 3);
    expect(r.stdout).toContain('SECRET_MISSING');
    const { report } = readReport(p);
    expect(report.exitCode).toBe(3);
    expect(report.totals).toMatchObject({ error: 1, passed: 0 });
    expect(report.scenarios[0]?.error?.code).toBe('SECRET_MISSING');
  });

  it('M28 R-RN3: usage errors are exit 2 and frozen violations exit 4, and neither writes a report: an earlier one stays in place', async () => {
    const p = createProject({ docs: ['release-notes'], options: FAST_REAL });
    project = p;
    await ok(p, ['compile']);
    await ok(p, ['run']);
    const earlier = readReport(p).text;
    const runs = runDirCount(p);

    const unknownReporter = expectExit(await runCli(p, ['run', '--frozen', '--reporter', 'bogus']), 2);
    expect(unknownReporter.stderr).toContain('USAGE');
    const noSelector = expectExit(await runCli(p, ['run', '--frozen', 'no-such-scenario']), 2);
    expect(noSelector.stderr).toContain('SCENARIO_NOT_FOUND');
    const readOnly = expectExit(await runCli(p, ['run', '-u'], { env: { CI: '1' } }), 2);
    expect(readOnly.stdout + readOnly.stderr).toContain('RECORDING_READ_ONLY');

    p.editDoc('release-notes', 'The page lists what changed in each release of Acme.', 'The page lists what changed in every release of Acme.');
    expectExit(await runCli(p, ['compile', '--check']), 4);
    const frozen = expectExit(await runCli(p, ['run', '--frozen']), 4);
    expect(frozen.stdout).toContain('PLAN_STALE');
    expect(frozen.stdout, 'no run directory is created, so none is named').not.toContain('Run: ');

    expect(readFileSync(p.path('.ai-bdd', 'report', 'report.json'), 'utf8'), 'exit 2 and 4 leave the earlier report alone').toBe(earlier);
    // an unknown selector is found only after the run directory exists, so it leaves one without a report; exit 4, a bad flag and -u leave none
    expect(runDirCount(p)).toBe(runs + 1);
  });
});
