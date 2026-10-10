// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gaps, main, packageOf, ranges, renderMarkdown, renderTable, summarize, uncovered } from '../coverage-report.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

const file = (lines, branches, functions) => ({
  lines: { total: lines[0], covered: lines[1], pct: lines[0] === 0 ? 100 : (100 * lines[1]) / lines[0] },
  branches: { total: branches[0], covered: branches[1], pct: branches[0] === 0 ? 100 : (100 * branches[1]) / branches[0] },
  functions: { total: functions[0], covered: functions[1], pct: functions[0] === 0 ? 100 : (100 * functions[1]) / functions[0] },
});

const SUMMARY = {
  total: file([0, 0], [0, 0], [0, 0]),
  '/r/packages/sdk/src/a.ts': file([10, 10], [4, 4], [2, 2]),
  '/r/packages/sdk/src/b.ts': file([10, 5], [4, 1], [2, 1]),
  '/r/packages/cli/src/c.ts': file([4, 4], [0, 0], [1, 1]),
};

test('packageOf names the package of a source file', () => {
  assert.equal(packageOf('/r/packages/sdk/src/a.ts'), 'sdk');
  assert.equal(packageOf('/r/scripts/x.mjs'), 'other');
});

test('summarize totals every package and the whole', () => {
  const { rows, total } = summarize(SUMMARY);
  assert.deepEqual(rows.map((r) => r.pkg), ['cli', 'sdk']);
  const sdk = rows.find((r) => r.pkg === 'sdk');
  assert.equal(sdk.files, 2);
  assert.equal(sdk.lines, 75);
  assert.equal(sdk.branches, 62.5);
  assert.equal(sdk.functions, 75);
  assert.equal(rows.find((r) => r.pkg === 'cli').branches, 100, 'no branches counts as fully covered');
  assert.equal(total.files, 3);
  assert.ok(Math.abs(total.lines - (100 * 19) / 24) < 1e-9);
});

test('ranges collapses consecutive lines and ignores duplicates', () => {
  assert.deepEqual(ranges([5, 1, 2, 3, 9, 9, 10]), ['1-3', '5', '9-10']);
  assert.deepEqual(ranges([]), []);
});

test('uncovered reports unexecuted statements and half-taken branches', () => {
  const entry = {
    statementMap: { 0: { start: { line: 3 }, end: { line: 3 } }, 1: { start: { line: 7 }, end: { line: 9 } } },
    s: { 0: 1, 1: 0 },
    branchMap: { 0: { loc: { start: { line: 3 } } }, 1: { loc: { start: { line: 12 } } } },
    b: { 0: [1, 1], 1: [1, 0] },
  };
  assert.deepEqual(uncovered(entry), { lines: ['7-9'], branches: ['12'] });
});

test('gaps lists files under the floors, worst first, with their uncovered ranges', () => {
  const final = { '/r/packages/sdk/src/b.ts': { statementMap: { 0: { start: { line: 2 }, end: { line: 4 } } }, s: { 0: 0 }, branchMap: {}, b: {} } };
  const g = gaps(SUMMARY, final);
  assert.equal(g.length, 1);
  assert.equal(g[0].file.endsWith('b.ts'), true);
  assert.deepEqual(g[0].uncoveredLines, ['2-4']);
});

test('rendering', () => {
  const result = summarize(SUMMARY);
  assert.match(renderTable(result), /sdk\s+2\s+75\.0\s+62\.5\s+75\.0/);
  assert.match(renderMarkdown(result), /\| sdk \| 2 \| 75\.0% \| 62\.5% \| 75\.0% \|/);
});

test('main reads a coverage directory and fails clearly when it is missing', () => {
  const root = makeRepo({});
  try {
    const out = [];
    const log = { log: (m) => out.push(String(m)), error: (m) => out.push(String(m)) };
    assert.equal(main(['--root', root], { log }), 2);
    assert.match(out.join('\n'), /run "pnpm coverage" first/);
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify(SUMMARY));
    out.length = 0;
    assert.equal(main(['--root', root, '--gaps'], { log }), 0);
    assert.match(out.join('\n'), /below 90% lines/);
  } finally {
    cleanup(root);
  }
});
