#!/usr/bin/env node
/**
 * Section 17: no package may import a non-public e2e module path (N5).
 * Allowed: 'e2e', 'e2e/agent', 'e2e/engine', 'e2e/runner'.
 * Also forbids reaching into 'e2e/dist/**'.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOWED = new Set(['e2e', 'e2e/agent', 'e2e/engine', 'e2e/runner']);
const IMPORT_RE = /(?:from\s+|import\(\s*|require\(\s*)['"](e2e(?:\/[^'"]*)?)['"]/gu;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json)$/u.test(entry)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'plugins')), ...walk(join(ROOT, 'fixtures'))]) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec.startsWith('e2e/dist') || !ALLOWED.has(spec)) {
      violations.push(`${relative(ROOT, file)}: imports '${spec}'`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`non-public e2e imports:\n${violations.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('no non-public e2e imports\n');
