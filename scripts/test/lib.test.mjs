import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lineOf, stripComments, finish, walk } from '../lib.mjs';

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

test('walk skips the scratch directories that tests and tools create and delete while others scan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-'));
  try {
    for (const d of ['src', '.work/p-1', '.stryker-tmp/x', 'node_modules/m', 'dist']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
      fs.writeFileSync(path.join(dir, d, 'f.ts'), '');
    }
    assert.deepEqual(walk(dir).map((f) => path.relative(dir, f)), [path.join('src', 'f.ts')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
