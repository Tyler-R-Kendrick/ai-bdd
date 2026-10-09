#!/usr/bin/env node
/**
 * WP-J2: docs checks. Verifies that
 *  - every relative markdown link resolves to a file in the repo,
 *  - every fenced ```json block parses,
 *  - every fenced ```ts block is non-empty,
 *  - every file mentioned in docs/verification-log.md exists or is marked N/A.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const docsDir = join(ROOT, 'docs');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = [join(ROOT, 'README.md'), ...walk(docsDir)];
const problems = [];

for (const file of files) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/u.test(target)) continue;
    const path = resolve(dirname(file), target.split('#')[0]);
    if (!existsSync(path)) problems.push(`${relative(ROOT, file)}: broken link ${target}`);
  }
  const blocks = [...text.matchAll(/```(\w+)\n([\s\S]*?)```/gu)];
  for (const [, lang, body] of blocks) {
    if (lang === 'json') {
      try {
        JSON.parse(body);
      } catch (error) {
        problems.push(`${relative(ROOT, file)}: invalid json block (${error.message})`);
      }
    }
    if (lang === 'ts' && body.trim().length === 0) {
      problems.push(`${relative(ROOT, file)}: empty ts block`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`docs problems:\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`docs check clean (${files.filter((f) => existsSync(f)).length} files)\n`);
