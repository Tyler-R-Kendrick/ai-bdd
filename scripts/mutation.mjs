#!/usr/bin/env node
// Mutation testing with Stryker (vitest runner + TypeScript checker), one target at a time.
//
//   node scripts/mutation.mjs --list                  print the targets
//   node scripts/mutation.mjs <target> [<target>...]  mutate the target's sources and run only its tests against every mutant
//   node scripts/mutation.mjs all                     every target, one after the other
//   node scripts/mutation.mjs --config <target>       print the Stryker configuration that would be used
//
// A target (scripts/mutation-targets.json) names the source files to mutate, the unit tests that exercise them and the mutation
// score below which the run fails (`break`). Raise `break` as the score improves; it is a ratchet like the coverage floors and the
// CRAP baseline. Reports land in reports/mutation/<target>.json (and .html when --html is given).
// Plain Node ESM; needs @stryker-mutator/* from the repository's dev dependencies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseArgs } from './lib.mjs';

export function loadTargets(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'mutation-targets.json'), 'utf8'));
}

/**
 * The Stryker configuration for one target. Every mutant runs `vitest run` over the target's own test files in a fresh process
 * (Stryker's `command` runner, the active mutant is passed through the environment), stopping at the first failing test.
 * The vitest runner plugin is not used: its per-test filtering ran no tests at all with this vitest version, so every mutant
 * "survived" (a 0 % score that measured nothing).
 */
export function buildConfig(name, target, { html = false, fcRuns = 40 } = {}) {
  return {
    plugins: ['@stryker-mutator/typescript-checker'],
    testRunner: 'command',
    commandRunner: { command: `MUTATION_TESTS='${target.tests.join(',')}' FC_RUNS=${fcRuns} pnpm exec vitest run -c vitest.mutation.config.ts --bail 1 --reporter=dot` },
    mutate: target.mutate,
    checkers: ['typescript'],
    tsconfigFile: 'tsconfig.json',
    reporters: html ? ['progress-append-only', 'clear-text', 'json', 'html'] : ['progress-append-only', 'clear-text', 'json'],
    jsonReporter: { fileName: `reports/mutation/${name}.json` },
    htmlReporter: { fileName: `reports/mutation/${name}.html` },
    thresholds: { high: 90, low: 75, break: target.break },
    coverageAnalysis: 'off',
    concurrency: 4,
    timeoutMS: 60000,
    tempDirName: `.stryker-tmp/${name}`,
    ignorePatterns: ['.claude', '.git', 'scripts', 'docs', 'coverage', 'reports', '.stryker-tmp', '**/dist', '**/.work', 'tests/acceptance', 'tests/adversarial', 'tests/chaos', 'tests/live'],
  };
}

/** Mutation score of a Stryker json report: killed (incl. timeout) over all valid mutants that were run. */
export function scoreOf(report) {
  const counts = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 };
  for (const file of Object.values(report.files ?? {})) {
    for (const m of file.mutants ?? []) if (m.status in counts) counts[m.status] += 1;
  }
  const detected = counts.Killed + counts.Timeout;
  const total = detected + counts.Survived + counts.NoCoverage;
  return { ...counts, total, score: total === 0 ? 100 : (100 * detected) / total };
}

export function main(argv, { log = console, run = spawnSync } = {}) {
  const { root, flags, rest } = parseArgs(argv, import.meta.url);
  const targets = loadTargets(root);
  if (flags.has('--list')) {
    for (const [name, t] of Object.entries(targets)) log.log(`${name.padEnd(14)} break ${String(t.break).padStart(3)}  ${t.mutate.join(' ')}`);
    return 0;
  }
  const configOnly = flags.has('--config');
  const names = rest.includes('all') ? Object.keys(targets) : rest;
  if (names.length === 0) {
    log.error('mutation: name a target (see --list) or "all"');
    return 2;
  }
  const unknown = names.filter((n) => targets[n] === undefined);
  if (unknown.length > 0) {
    log.error(`mutation: unknown target(s) ${unknown.join(', ')} (see --list)`);
    return 2;
  }
  if (configOnly) {
    for (const n of names) log.log(JSON.stringify(buildConfig(n, targets[n]), null, 2));
    return 0;
  }
  let exit = 0;
  for (const name of names) {
    const target = targets[name];
    const dir = path.join(root, '.stryker-tmp');
    fs.mkdirSync(dir, { recursive: true });
    const confFile = path.join(dir, `${name}.conf.json`);
    fs.writeFileSync(confFile, `${JSON.stringify(buildConfig(name, target, { html: flags.has('--html'), fcRuns: process.env.FC_RUNS ?? 40 }), null, 2)}\n`);
    log.log(`\nmutation: ${name} (${target.mutate.join(', ')}) against ${target.tests.join(', ')}`);
    const r = run('pnpm', ['exec', 'stryker', 'run', confFile], {
      cwd: root,
      stdio: 'inherit',
    });
    if (r.status !== 0) exit = 1;
    const reportFile = path.join(root, `reports/mutation/${name}.json`);
    if (fs.existsSync(reportFile)) {
      const s = scoreOf(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      log.log(`mutation: ${name}: score ${s.score.toFixed(1)}% (${s.Killed} killed, ${s.Timeout} timeout, ${s.Survived} survived, ${s.NoCoverage} no coverage; break at ${target.break}%)`);
    }
  }
  return exit;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
