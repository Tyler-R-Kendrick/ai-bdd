#!/usr/bin/env node
// @ts-nocheck
// Runs every repository check in sequence and exits non-zero if any of them fails.
//   --allow-incomplete   tolerate failures of the checks that depend on unfinished work
//                        (check-stubs, check-requirements, check-determinism and the generated
//                        error doc, whose `reserved` column follows the state of the tree).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, parseArgs } from './lib.mjs';

/** Each step: script file, extra args, and whether `--allow-incomplete` tolerates its failure. */
export const STEPS = [
  { name: 'gen-errors-doc --check', script: 'gen-errors-doc.mjs', args: ['--check'], tolerable: true },
  { name: 'check-requirements', script: 'check-requirements.mjs', args: [], tolerable: true },
  { name: 'check-boundaries', script: 'check-boundaries.mjs', args: [], tolerable: false },
  { name: 'check-stubs', script: 'check-stubs.mjs', args: [], tolerable: true },
  { name: 'check-licenses', script: 'check-licenses.mjs', args: [], tolerable: false },
  { name: 'check-determinism', script: 'check-determinism.mjs', args: [], tolerable: true },
  { name: 'check-docs', script: 'check-docs.mjs', args: [], tolerable: false },
];

/**
 * Runs the steps with the given scripts directory. Returns `{ ok, results }`.
 * Output of each step is passed through to `log` with a header.
 */
export function runAll({ root, scriptsDir, steps = STEPS, allowIncomplete = false, log = console, nodePath = process.execPath }) {
  const results = [];
  for (const step of steps) {
    const file = path.join(scriptsDir, step.script);
    log.log(`\n== ${step.name} ==`);
    if (!fs.existsSync(file)) {
      results.push({ name: step.name, status: 'failed', tolerated: false, reason: 'script missing' });
      log.error(`missing script ${step.script}`);
      continue;
    }
    const env = { ...process.env };
    if (allowIncomplete) env.CHECK_ALLOW_SKIP = '1';
    const r = spawnSync(nodePath, [file, '--root', root, ...step.args], { cwd: root, env, encoding: 'utf8' });
    if (r.stdout) log.log(r.stdout.trimEnd());
    if (r.stderr) log.error(r.stderr.trimEnd());
    const passed = r.status === 0;
    const tolerated = !passed && allowIncomplete && step.tolerable;
    results.push({ name: step.name, status: passed ? 'passed' : 'failed', tolerated });
  }
  const failed = results.filter((r) => r.status === 'failed' && !r.tolerated);
  log.log('\n== summary ==');
  for (const r of results) {
    const label = r.status === 'passed' ? 'PASS' : r.tolerated ? 'FAIL (tolerated: --allow-incomplete)' : 'FAIL';
    log.log(`${label.padEnd(8)} ${r.name}`);
  }
  return { ok: failed.length === 0, results };
}

if (isMain(import.meta.url)) {
  const { root, flags } = parseArgs(process.argv.slice(2), import.meta.url);
  const { ok } = runAll({ root, scriptsDir: path.dirname(fileURLToPath(import.meta.url)), allowIncomplete: flags.has('--allow-incomplete') });
  process.exit(ok ? 0 : 1);
}
