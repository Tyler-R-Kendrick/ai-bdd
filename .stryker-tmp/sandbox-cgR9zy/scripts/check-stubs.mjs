#!/usr/bin/env node
// @ts-nocheck
// Fails when a `notImplemented(` call remains in package sources outside the contracts module.
import fs from 'node:fs';
import path from 'node:path';
import { finish, isMain, listPackages, parseArgs, stripComments, lineOf, toPosix, walk } from './lib.mjs';

const CONTRACTS = 'packages/sdk/src/contracts/index.ts';

export function checkStubs(root) {
  const problems = [];
  let scanned = 0;
  for (const pkg of listPackages(root)) {
    const files = walk(path.join(root, 'packages', pkg, 'src'), { filter: (f) => /\.[cm]?[jt]sx?$/.test(f) });
    for (const f of files) {
      const rel = toPosix(path.relative(root, f));
      if (rel === CONTRACTS) continue;
      scanned++;
      const text = stripComments(fs.readFileSync(f, 'utf8'));
      const re = /\bnotImplemented\s*\(/g;
      let m;
      while ((m = re.exec(text))) problems.push(`${rel}:${lineOf(text, m.index)} notImplemented( call remains`);
    }
  }
  return { ok: problems.length === 0, problems, summary: `${scanned} source files scanned` };
}

if (isMain(import.meta.url)) {
  const { root } = parseArgs(process.argv.slice(2), import.meta.url);
  process.exit(finish('check-stubs', checkStubs(root)));
}
