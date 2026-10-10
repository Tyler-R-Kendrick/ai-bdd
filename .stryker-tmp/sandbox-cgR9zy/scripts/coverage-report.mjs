#!/usr/bin/env node
// @ts-nocheck
// Reads the V8 coverage written by `pnpm coverage` (coverage/coverage-summary.json and coverage/coverage-final.json) and prints
//   - a per-package table (lines, branches, functions),
//   - with --gaps, every file below the line or branch floor with its uncovered line ranges.
// With $GITHUB_STEP_SUMMARY set it also writes the table as Markdown. Plain Node ESM, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseArgs } from './lib.mjs';

const KINDS = ['lines', 'branches', 'functions'];

/** `packages/<name>/src/...` -> `<name>`; anything else -> `other`. */
export function packageOf(file) {
  const m = /packages\/([^/]+)\//.exec(file.split(path.sep).join('/'));
  return m ? m[1] : 'other';
}

/** Per-package totals from an istanbul `coverage-summary.json` object. */
export function summarize(summary) {
  const acc = new Map();
  for (const [file, v] of Object.entries(summary)) {
    if (file === 'total') continue;
    const pkg = packageOf(file);
    const row = acc.get(pkg) ?? { files: 0, ...Object.fromEntries(KINDS.flatMap((k) => [[`${k}Covered`, 0], [`${k}Total`, 0]])) };
    row.files += 1;
    for (const k of KINDS) {
      row[`${k}Covered`] += v[k].covered;
      row[`${k}Total`] += v[k].total;
    }
    acc.set(pkg, row);
  }
  const pct = (c, t) => (t === 0 ? 100 : (100 * c) / t);
  const rows = [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, r]) => ({
      pkg,
      files: r.files,
      ...Object.fromEntries(KINDS.map((k) => [k, pct(r[`${k}Covered`], r[`${k}Total`])])),
    }));
  const all = {};
  for (const k of KINDS) {
    let c = 0;
    let t = 0;
    for (const r of acc.values()) {
      c += r[`${k}Covered`];
      t += r[`${k}Total`];
    }
    all[k] = pct(c, t);
  }
  return { rows, total: { pkg: 'all', files: [...acc.values()].reduce((n, r) => n + r.files, 0), ...all } };
}

/** Collapse sorted line numbers into `a-b` ranges. */
export function ranges(lines) {
  const out = [];
  let start = null;
  let prev = null;
  for (const n of [...new Set(lines)].sort((a, b) => a - b)) {
    if (start === null) start = prev = n;
    else if (n === prev + 1) prev = n;
    else {
      out.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = n;
    }
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out;
}

/** Uncovered statement lines and partially covered branch lines of one istanbul file entry. */
export function uncovered(entry) {
  const lines = [];
  for (const [id, count] of Object.entries(entry.s ?? {})) {
    if (count === 0) {
      const loc = entry.statementMap[id];
      for (let l = loc.start.line; l <= loc.end.line; l++) lines.push(l);
    }
  }
  const branchLines = [];
  for (const [id, counts] of Object.entries(entry.b ?? {})) {
    if (counts.some((c) => c === 0)) branchLines.push(entry.branchMap[id].loc.start.line);
  }
  return { lines: ranges(lines), branches: ranges(branchLines) };
}

/** Files under the given floors, worst first. */
export function gaps(summary, final, { lines = 90, branches = 75 } = {}) {
  const out = [];
  for (const [file, v] of Object.entries(summary)) {
    if (file === 'total') continue;
    if (v.lines.pct >= lines && v.branches.pct >= branches) continue;
    const u = final[file] ? uncovered(final[file]) : { lines: [], branches: [] };
    out.push({ file: path.relative(process.cwd(), file), lines: v.lines.pct, branches: v.branches.pct, uncoveredLines: u.lines, partialBranches: u.branches });
  }
  return out.sort((a, b) => a.lines + a.branches - (b.lines + b.branches));
}

const f1 = (n) => n.toFixed(1).padStart(5);

export function renderTable({ rows, total }) {
  const line = (r) => `${r.pkg.padEnd(18)} ${String(r.files).padStart(5)}  ${f1(r.lines)}  ${f1(r.branches)}  ${f1(r.functions)}`;
  return ['package            files  lines  branch  funcs', ...rows.map(line), line(total)].join('\n');
}

export function renderMarkdown({ rows, total }) {
  const line = (r) => `| ${r.pkg} | ${r.files} | ${r.lines.toFixed(1)}% | ${r.branches.toFixed(1)}% | ${r.functions.toFixed(1)}% |`;
  return ['### Coverage (unit tests, V8)', '', '| package | files | lines | branches | functions |', '|---|---:|---:|---:|---:|', ...rows.map(line), line({ ...total, pkg: '**all**' }), ''].join('\n');
}

export function main(argv, { log = console } = {}) {
  const { root, flags, rest } = parseArgs(argv, import.meta.url);
  const dir = path.resolve(root, rest[0] ?? 'coverage');
  const summaryFile = path.join(dir, 'coverage-summary.json');
  if (!fs.existsSync(summaryFile)) {
    log.error(`coverage-report: ${summaryFile} not found (run "pnpm coverage" first)`);
    return 2;
  }
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const result = summarize(summary);
  log.log(renderTable(result));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderMarkdown(result)}\n`);
  if (flags.has('--gaps')) {
    const finalFile = path.join(dir, 'coverage-final.json');
    const final = fs.existsSync(finalFile) ? JSON.parse(fs.readFileSync(finalFile, 'utf8')) : {};
    log.log('\nfiles below 90% lines or 75% branches (uncovered lines | partially covered branch lines):');
    for (const g of gaps(summary, final)) {
      log.log(`${f1(g.lines)} ${f1(g.branches)}  ${g.file}\n        lines: ${g.uncoveredLines.join(', ') || '-'}\n        branches: ${g.partialBranches.join(', ') || '-'}`);
    }
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
