#!/usr/bin/env node
/**
 * WP-J1 acceptance driver. Runs the checks that the specification's section 16
 * and 17 require, in order, and prints a single pass/fail table.
 *
 * Usage:
 *   node scripts/verify.mjs                # everything that is runnable
 *   node scripts/verify.mjs --quick        # skip the integration suites
 */
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const quick = process.argv.includes('--quick');

/** @type {Array<{name: string; cmd: string; args: string[]; optional?: boolean; ac: string}>} */
const STEPS = [
  { ac: 'AC1', name: 'build all packages', cmd: 'npx', args: ['tsc', '-b', 'tsconfig.build.json'] },
  { ac: 'AC1', name: 'unit + integration tests', cmd: 'npx', args: ['vitest', 'run', ...(quick ? ['--project', 'contracts'] : [])] },
  { ac: 'AC1', name: 'lint', cmd: 'npx', args: ['oxlint', '--deny-warnings', 'packages', 'plugins', 'fixtures', 'scripts'] },
  { ac: 'AC12', name: 'requirement coverage (R-K ids)', cmd: 'node', args: ['scripts/check-requirements.mjs'] },
  { ac: 'AC8', name: 'schema drift', cmd: 'node', args: ['scripts/check-schema-drift.mjs'] },
  { ac: 'AC6', name: 'no secrets in .ai-bdd', cmd: 'node', args: ['scripts/check-secrets.mjs'] },
  { ac: 'AC10', name: 'public e2e API only', cmd: 'node', args: ['scripts/check-e2e-imports.mjs'] },
];

const results = [];
for (const step of STEPS) {
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env: process.env });
  const ok = result.status === 0;
  results.push({ ...step, ok, ms: Date.now() - started, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${step.ac.padEnd(6)} ${step.name} (${Date.now() - started}ms)\n`);
  if (!ok && !step.optional) process.stdout.write(`${results.at(-1).output.split('\n').slice(-12).join('\n')}\n`);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((f) => `${f.ac} ${f.name}`).join('; ')}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
