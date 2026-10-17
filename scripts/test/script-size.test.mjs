import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPTS = path.resolve(import.meta.dirname, '..');
const MAX_LINES = 400;

test(`every repository script and script test stays under ${MAX_LINES} lines (split a script that grows past it)`, () => {
  const over = [];
  for (const dir of [SCRIPTS, path.join(SCRIPTS, 'test')]) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').length - 1;
      if (lines >= MAX_LINES) over.push(`${path.relative(SCRIPTS, path.join(dir, name))}: ${lines}`);
    }
  }
  assert.deepEqual(over, []);
});
