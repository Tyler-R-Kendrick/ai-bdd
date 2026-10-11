import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildConfig, loadTargets, main, scoreOf } from '../mutation.mjs';
import { cleanup, makeRepo, write } from './fixture.mjs';

const TARGETS = {
  one: { mutate: ['packages/a/src/**/*.ts'], tests: ['packages/a/test/**/*.test.ts'], break: 55 },
  two: { mutate: ['packages/b/src/x.ts'], tests: ['packages/b/test/x.test.ts', 'packages/b/test/y.test.ts'], break: 70 },
};

function capture() {
  const out = [];
  return { out, log: { log: (m) => out.push(String(m)), error: (m) => out.push(String(m)) } };
}

test('the repository targets are well formed and name existing source directories', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const targets = loadTargets(root);
  assert.ok(Object.keys(targets).length >= 1);
  for (const [name, t] of Object.entries(targets)) {
    assert.ok(t.mutate.length > 0 && t.tests.length > 0, name);
    assert.ok(Number.isInteger(t.break) && t.break >= 0 && t.break <= 100, `${name}: break`);
    for (const pattern of t.mutate.filter((p) => !p.startsWith('!'))) {
      const dir = pattern.split('/**')[0].replace(/\/[^/]*\.ts$/, '');
      assert.ok(fs.existsSync(path.join(root, dir)), `${name}: ${dir} exists`);
      if (!pattern.includes('*')) assert.ok(fs.existsSync(path.join(root, pattern)), `${name}: ${pattern} exists`);
    }
    for (const pattern of t.tests) {
      // a named file must exist; a glob must at least name an existing directory (a typo would run no tests, and every mutant would survive)
      const target = pattern.includes('*') ? pattern.slice(0, pattern.indexOf('*')).replace(/\/[^/]*$/, '') : pattern;
      assert.ok(fs.existsSync(path.join(root, target)), `${name}: ${pattern} exists`);
    }
  }
});

test('buildConfig names the report after the target and breaks below its threshold', () => {
  const c = buildConfig('one', TARGETS.one);
  assert.deepEqual(c.mutate, TARGETS.one.mutate);
  assert.equal(c.thresholds.break, 55);
  assert.equal(c.jsonReporter.fileName, 'reports/mutation/one.json');
  assert.equal(c.tempDirName, '.stryker-tmp/one');
  assert.deepEqual(c.reporters, ['progress-append-only', 'clear-text', 'json']);
  assert.deepEqual(buildConfig('one', TARGETS.one, { html: true }).reporters, ['progress-append-only', 'clear-text', 'json', 'html']);
  assert.ok(c.ignorePatterns.includes('.stryker-tmp'), 'the sandbox never copies earlier sandboxes');
  assert.equal(c.testRunner, 'command');
  assert.equal(c.coverageAnalysis, 'off', 'the command runner has no per-test coverage');
  assert.match(c.commandRunner.command, /^MUTATION_TESTS='packages\/a\/test\/\*\*\/\*\.test\.ts' FC_RUNS=40 pnpm exec vitest run .*--bail 1/);
  assert.match(buildConfig('one', TARGETS.two, { fcRuns: 7 }).commandRunner.command, /MUTATION_TESTS='packages\/b\/test\/x\.test\.ts,packages\/b\/test\/y\.test\.ts' FC_RUNS=7 /);
});

test('scoreOf counts timeouts as detected and no-coverage as undetected, and ignores ignored mutants', () => {
  const report = {
    files: {
      'a.ts': { mutants: [{ status: 'Killed' }, { status: 'Timeout' }, { status: 'Survived' }, { status: 'Ignored' }, { status: 'CompileError' }] },
      'b.ts': { mutants: [{ status: 'NoCoverage' }, { status: 'Killed' }] },
    },
  };
  const s = scoreOf(report);
  assert.deepEqual([s.Killed, s.Timeout, s.Survived, s.NoCoverage, s.total], [2, 1, 1, 1, 5]);
  assert.equal(s.score, 60);
  assert.equal(scoreOf({ files: {} }).score, 100);
  assert.equal(scoreOf({}).score, 100);
});

test('main: --list, unknown targets and a missing target', () => {
  const root = makeRepo({ 'scripts/mutation-targets.json': TARGETS });
  try {
    let c = capture();
    assert.equal(main(['--root', root, '--list'], { log: c.log }), 0);
    assert.match(c.out.join('\n'), /one\s+break\s+55/);
    c = capture();
    assert.equal(main(['--root', root, 'nope'], { log: c.log }), 2);
    assert.match(c.out.join('\n'), /unknown target\(s\) nope/);
    c = capture();
    assert.equal(main(['--root', root], { log: c.log }), 2);
    assert.match(c.out.join('\n'), /name a target/);
  } finally {
    cleanup(root);
  }
});

test('main: --config prints the configuration without running anything', () => {
  const root = makeRepo({ 'scripts/mutation-targets.json': TARGETS });
  try {
    const c = capture();
    const run = () => assert.fail('nothing runs');
    assert.equal(main(['--root', root, '--config', 'two'], { log: c.log, run }), 0);
    assert.equal(JSON.parse(c.out.join('\n')).thresholds.break, 70);
  } finally {
    cleanup(root);
  }
});

test('main runs Stryker per target with only that target tests, reports the score and fails when Stryker does', () => {
  const root = makeRepo({ 'scripts/mutation-targets.json': TARGETS });
  try {
    const calls = [];
    const run = (cmd, args) => {
      calls.push({ cmd, args });
      const name = path.basename(args[3], '.conf.json');
      write(root, `reports/mutation/${name}.json`, { files: { 'x.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] } } });
      return { status: name === 'two' ? 1 : 0 };
    };
    const c = capture();
    assert.equal(main(['--root', root, 'all'], { log: c.log, run }), 1);
    assert.equal(calls[0].cmd, 'pnpm');
    assert.deepEqual(calls[0].args.slice(0, 3), ['exec', 'stryker', 'run']);
    assert.match(c.out.join('\n'), /one: score 50\.0% \(1 killed, 0 timeout, 1 survived, 0 no coverage; break at 55%\)/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, '.stryker-tmp/one.conf.json'), 'utf8')).mutate);
  } finally {
    cleanup(root);
  }
});
