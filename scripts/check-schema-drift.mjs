#!/usr/bin/env node
/**
 * AC8 / WP-A1: the checked-in JSON Schemas and docs/errors.md must be exactly
 * what the generator produces.
 */
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

const gen = spawnSync('pnpm', ['-F', '@ai-bdd/contracts', 'gen:schemas'], { cwd: ROOT, encoding: 'utf8' });
if (gen.status !== 0) {
  process.stderr.write(`${gen.stdout ?? ''}${gen.stderr ?? ''}\n`);
  process.exit(1);
}
const diff = spawnSync('git', ['diff', '--exit-code', '--', 'packages/contracts/schemas', 'docs/errors.md'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (diff.status !== 0) {
  process.stderr.write(`schema drift detected:\n${diff.stdout ?? ''}\n`);
  process.exit(1);
}
process.stdout.write('schemas and docs/errors.md are in sync\n');
