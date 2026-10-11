#!/usr/bin/env node
// Fails when a requirement id from docs/requirements.json is not named by any test.
import fs from 'node:fs';
import path from 'node:path';
import { finish, isMain, listPackages, parseArgs, toPosix, walk } from './lib.mjs';

const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

export function idPattern(id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `R-EX1` must not match inside `R-EX10` or `XR-EX1`.
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`);
}

/** Test files: packages/<pkg>/test/** and tests/** ending in `.test.ts`. */
export function findTestFiles(root) {
  const dirs = [path.join(root, 'tests'), ...listPackages(root).map((p) => path.join(root, 'packages', p, 'test'))];
  return dirs.flatMap((d) => walk(d, { filter: (f) => f.endsWith('.test.ts') }));
}

export function checkRequirements(root) {
  const problems = [];
  const reqFile = path.join(root, 'docs', 'requirements.json');
  let reqs;
  try {
    reqs = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  } catch (e) {
    return { ok: false, problems: [`cannot read docs/requirements.json: ${e.message}`] };
  }
  if (!Array.isArray(reqs)) return { ok: false, problems: ['docs/requirements.json must be an array of {id, text}'] };
  const seen = new Set();
  for (const r of reqs) {
    if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || !r.id || !r.text) {
      problems.push(`invalid requirement entry: ${JSON.stringify(r)}`);
    } else if (seen.has(r.id)) {
      problems.push(`duplicate requirement id ${r.id}`);
    } else {
      seen.add(r.id);
    }
  }
  const files = findTestFiles(root);
  // Test titles and describe strings are string literals; comments do not count.
  const haystacks = files.map((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return { name: toPosix(path.relative(root, f)), strings: (src.match(STRING_LITERAL) ?? []).join('\n') };
  });
  const uncovered = [];
  for (const id of seen) {
    const re = idPattern(id);
    if (!haystacks.some((h) => re.test(h.name) || re.test(h.strings))) uncovered.push(id);
  }
  for (const id of uncovered) problems.push(`${id} is not named by any test title (searched ${files.length} test files)`);
  return {
    ok: problems.length === 0,
    problems,
    summary: `${seen.size - uncovered.length}/${seen.size} requirements covered by ${files.length} test files`,
    uncovered,
  };
}

if (isMain(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2), import.meta.url);
  process.exit(finish('check-requirements', checkRequirements(root)));
}
