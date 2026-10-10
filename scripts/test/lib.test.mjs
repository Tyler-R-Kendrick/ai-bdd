import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineOf, stripComments, finish } from '../lib.mjs';

test('stripComments blanks comments but keeps strings and line numbers', () => {
  const src = "const g = 'docs/**/*.md'; // trailing\n/* block\nspan */ import x from './y';\n";
  const out = stripComments(src);
  assert.equal(out.length, src.length);
  assert.ok(out.includes("'docs/**/*.md'"));
  assert.ok(!out.includes('trailing'));
  assert.ok(!out.includes('block'));
  assert.equal(lineOf(out, out.indexOf('import')), 3);
});

test('stripComments leaves a comment marker inside a template literal alone', () => {
  const out = stripComments('const t = `a // b ${1} /* c */`;');
  assert.ok(out.includes('// b'));
});

test('finish returns exit codes and prints problems', () => {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  assert.equal(finish('x', { ok: true, problems: [], summary: '1 file' }, log), 0);
  assert.equal(finish('x', { ok: false, problems: ['boom'] }, log), 1);
  assert.equal(finish('x', { ok: true, skipped: 'later', problems: [] }, log), 0);
  assert.equal(finish('x', { ok: false, skipped: 'later', problems: ['p'] }, log), 1);
  assert.ok(lines.some((l) => l.includes('boom')));
});
