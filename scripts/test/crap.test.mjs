import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CRAP_LIMIT, analyze, coverageOf, crap, functionsOf, main, renderRows, violations, withUniqueIds } from '../crap.mjs';
import { cleanup, makeRepo, write } from './fixture.mjs';

const only = (src) => functionsOf(src).filter((f) => f.name === 'f')[0];

test('complexity counts every branch point once and starts at 1', () => {
  assert.equal(only('function f() { return 1; }').complexity, 1);
  assert.equal(only('function f(a) { if (a) { return 1; } else if (!a) { return 2; } return 3; }').complexity, 3);
  assert.equal(only('function f(a, b) { return a && b || a ?? b; }').complexity, 4);
  assert.equal(only('function f(a) { return a ? 1 : 2; }').complexity, 2);
  assert.equal(only('function f(xs) { for (const x of xs) { while (x) { break; } } for (let i = 0; i < 1; i++) {} for (const k in xs) {} do {} while (false); }').complexity, 6);
  assert.equal(only('function f(a) { switch (a) { case 1: return 1; case 2: return 2; default: return 3; } }').complexity, 3);
  assert.equal(only('function f() { try { g(); } catch { h(); } }').complexity, 2);
  assert.equal(only('function f(a) { a ||= 1; a &&= 2; a ??= 3; }').complexity, 4);
});

test('nested functions are scored on their own', () => {
  const fns = functionsOf('function f(a) { const g = (b) => (b ? 1 : 2); if (a) { return g(a); } return 0; }');
  assert.equal(fns.find((x) => x.name === 'f').complexity, 2);
  assert.equal(fns.find((x) => x.name === 'g').complexity, 2);
});

test('names: declarations, methods, constructors, accessors, property functions', () => {
  const names = functionsOf('class A { constructor() {} m() {} get x() { return 1; } set x(v) {} static s() {} } const o = { p: () => 1, q() {} }; export const e = function () {};').map((f) => f.name);
  assert.deepEqual(names.sort(), ['constructor', 'e', 'm', 'p', 'q', 's', 'x', 'x'].sort());
});

test('functions without a body (overloads, abstract) are skipped', () => {
  assert.deepEqual(functionsOf('function f(a: string): void; function f(a: number): void; function f(a: any) {}').map((f) => f.name), ['f']);
});

test('coverage of a function counts only its own statements', () => {
  const [outer, inner] = functionsOf('function outer() {\n  a();\n  const g = () => {\n    b();\n    c();\n  };\n  d();\n}\n');
  const entry = {
    statementMap: {
      0: { start: { line: 2, column: 2 }, end: { line: 2, column: 6 } },
      1: { start: { line: 4, column: 4 }, end: { line: 4, column: 8 } },
      2: { start: { line: 5, column: 4 }, end: { line: 5, column: 8 } },
      3: { start: { line: 7, column: 2 }, end: { line: 7, column: 6 } },
    },
    s: { 0: 1, 1: 0, 2: 0, 3: 0 },
  };
  assert.equal(outer.name, 'outer');
  assert.equal(coverageOf(entry, outer), 0.5, 'a() ran, d() did not; the arrow function body is excluded');
  assert.equal(coverageOf(entry, inner), 0);
  assert.equal(coverageOf(undefined, outer), 0, 'a file nobody loaded is untested');
  assert.equal(coverageOf({ statementMap: {}, s: {} }, outer), 1, 'no statements: nothing to miss');
});

test('crap formula: covered = complexity, untested = c^2 + c', () => {
  assert.equal(crap(5, 1), 5);
  assert.equal(crap(5, 0), 30);
  assert.equal(crap(10, 0.5), 10 * 10 * 0.125 + 10);
});

test('violations: new offenders and baselined ones that got worse; tolerance for noise', () => {
  const row = (id, c) => ({ id, crap: c, line: 1, complexity: 9, coverage: 0.5 });
  const rows = [row('a#x', 40), row('b#y', 35), row('c#z', 31.5), row('d#ok', 12)];
  const bad = violations(rows, { 'b#y': 35, 'c#z': 30.4 }, CRAP_LIMIT).map((v) => v.id);
  assert.deepEqual(bad, ['a#x', 'c#z']);
  assert.deepEqual(violations(rows, { 'a#x': 40, 'b#y': 35, 'c#z': 31.5 }), []);
});

test('withUniqueIds numbers repeated ids', () => {
  const ids = withUniqueIds([{ id: 'a#f' }, { id: 'a#f' }, { id: 'b#g' }]).map((r) => r.id);
  assert.deepEqual(ids, ['a#f', 'a#f~2', 'b#g']);
});

test('main: analyzes a repository, writes and enforces a baseline', () => {
  const root = makeRepo({});
  try {
    write(root, 'packages/p/src/a.ts', 'export function risky(a: number) {\n  if (a === 1) return 1;\n  if (a === 2) return 2;\n  if (a === 3) return 3;\n  if (a === 4) return 4;\n  if (a === 5) return 5;\n  return 0;\n}\n');
    const file = path.join(root, 'packages/p/src/a.ts');
    fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
    const finalFile = path.join(root, 'coverage', 'coverage-final.json');
    fs.writeFileSync(finalFile, JSON.stringify({ [file]: { statementMap: { 0: { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } } }, s: { 0: 0 } } }));
    const out = [];
    const log = { log: (m) => out.push(String(m)), error: (m) => out.push(String(m)) };
    assert.equal(main(['--root', root, '--check'], { log }), 1, 'risky is complexity 6 and untested: 6*6+6 = 42');
    assert.match(out.join('\n'), /a\.ts#risky .*over 30/);
    out.length = 0;
    assert.equal(main(['--root', root, '--update-baseline'], { log }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'crap-baseline.json'), 'utf8')), { 'packages/p/src/a.ts#risky': 42 });
    assert.equal(main(['--root', root, '--check'], { log }), 0);
    assert.match(renderRows(analyze(root, JSON.parse(fs.readFileSync(finalFile, 'utf8')))), /42\.0 +6 +0 +packages\/p\/src\/a\.ts#risky/);
    fs.rmSync(finalFile);
    assert.equal(main(['--root', root], { log }), 2);
  } finally {
    cleanup(root);
  }
});
