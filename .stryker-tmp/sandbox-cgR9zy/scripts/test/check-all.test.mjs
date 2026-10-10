// @ts-nocheck
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { STEPS, runAll } from '../check-all.mjs';
import { cleanup, makeRepo, write } from './fixture.mjs';

const quiet = () => {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) } };
};

function fixture(exitCodes) {
  const root = makeRepo({});
  const scriptsDir = path.join(root, 'scripts');
  const steps = Object.entries(exitCodes).map(([name, [code, tolerable]]) => {
    write(root, `scripts/${name}.mjs`, `console.log('${name} ran skip=' + process.env.CHECK_ALLOW_SKIP + ' args=' + process.argv.slice(2).join(' '));\nprocess.exit(${code});\n`);
    return { name, script: `${name}.mjs`, args: [], tolerable };
  });
  return { root, scriptsDir, steps };
}

test('STEPS covers every check script in order', () => {
  assert.deepEqual(STEPS.map((s) => s.script), [
    'gen-errors-doc.mjs',
    'check-requirements.mjs',
    'check-boundaries.mjs',
    'check-stubs.mjs',
    'check-licenses.mjs',
    'check-determinism.mjs',
    'check-docs.mjs',
  ]);
  assert.deepEqual(STEPS.filter((s) => s.tolerable).map((s) => s.name).sort(), ['check-determinism', 'check-requirements', 'check-stubs', 'gen-errors-doc --check']);
});

test('runs every step, succeeds when all pass, passes --root to scripts', () => {
  const { root, scriptsDir, steps } = fixture({ a: [0, false], b: [0, true] });
  const { lines, log } = quiet();
  try {
    const r = runAll({ root, scriptsDir, steps, log });
    assert.equal(r.ok, true);
    assert.ok(lines.some((l) => l.includes(`args=--root ${root}`)));
    assert.ok(lines.some((l) => l.includes('PASS') && l.includes('a')));
  } finally {
    cleanup(root);
  }
});

test('a failing step fails the run but later steps still execute', () => {
  const { root, scriptsDir, steps } = fixture({ a: [1, false], b: [0, false] });
  const { lines, log } = quiet();
  try {
    const r = runAll({ root, scriptsDir, steps, log });
    assert.equal(r.ok, false);
    assert.deepEqual(r.results.map((x) => x.status), ['failed', 'passed']);
    assert.ok(lines.some((l) => l.includes('b ran')));
  } finally {
    cleanup(root);
  }
});

test('--allow-incomplete tolerates only tolerable steps and enables CHECK_ALLOW_SKIP', () => {
  const tolerable = fixture({ a: [1, true], b: [0, false] });
  const strictFail = fixture({ a: [0, true], b: [1, false] });
  const missing = fixture({ a: [0, false] });
  const q1 = quiet();
  try {
    const r1 = runAll({ ...tolerable, allowIncomplete: true, log: q1.log });
    assert.equal(r1.ok, true);
    assert.ok(q1.lines.some((l) => l.includes('tolerated')));
    assert.ok(q1.lines.some((l) => l.includes('skip=1')));
    assert.equal(runAll({ ...tolerable, allowIncomplete: false, log: quiet().log }).ok, false);
    assert.equal(runAll({ ...strictFail, allowIncomplete: true, log: quiet().log }).ok, false);
    const r3 = runAll({ root: missing.root, scriptsDir: missing.scriptsDir, steps: [...missing.steps, { name: 'ghost', script: 'ghost.mjs', args: [], tolerable: true }], allowIncomplete: true, log: quiet().log });
    assert.equal(r3.ok, false, 'a missing script is never tolerated');
  } finally {
    cleanup(tolerable.root);
    cleanup(strictFail.root);
    cleanup(missing.root);
  }
});
