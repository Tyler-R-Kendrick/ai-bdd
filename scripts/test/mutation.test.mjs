import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { binPath, buildConfig, loadTargets, main, scoreOf, shellQuote } from '../mutation.mjs';
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
    // the ratchet: every target was measured at 100 % with its equivalent mutants marked, so a lower break is a weakened gate
    assert.ok(t.break >= 95, `${name}: break ${t.break} is below the 95 floor`);
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
  // vitest runs from the repository's node_modules/.bin, through no package manager
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const vitest = path.join(repo, 'node_modules', '.bin', 'vitest');
  assert.equal(
    buildConfig('one', TARGETS.one, { platform: 'linux' }).commandRunner.command,
    `MUTATION_TESTS='packages/a/test/**/*.test.ts' FC_RUNS=40 '${vitest}' run -c vitest.mutation.config.ts --bail 1 --reporter=dot`,
  );
  assert.match(buildConfig('one', TARGETS.two, { fcRuns: 7 }).commandRunner.command, /MUTATION_TESTS='packages\/b\/test\/x\.test\.ts,packages\/b\/test\/y\.test\.ts' FC_RUNS=7 /);
  assert.equal(buildConfig('one', TARGETS.one, { root: '/r o', platform: 'win32' }).commandRunner.command.split(' FC_RUNS=40 ')[1].split(' run ')[0], `"${path.join('/r o', 'node_modules', '.bin', 'vitest.cmd')}"`);
});

test('binPath names the binary in node_modules/.bin, and its .cmd shim on Windows; shellQuote quotes for sh and for cmd.exe', () => {
  assert.equal(binPath('/r', 'stryker', 'linux'), path.join('/r', 'node_modules', '.bin', 'stryker'));
  assert.equal(binPath('/r', 'stryker', 'darwin'), path.join('/r', 'node_modules', '.bin', 'stryker'));
  assert.equal(binPath('/r', 'stryker', 'win32'), path.join('/r', 'node_modules', '.bin', 'stryker.cmd'));
  assert.equal(shellQuote("/a b/it's", 'linux'), `'/a b/it'\\''s'`);
  assert.equal(shellQuote('C:\\a b\\x.cmd', 'win32'), '"C:\\a b\\x.cmd"');
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
  const root = makeRepo({ 'scripts/mutation-targets.json': TARGETS, 'node_modules/.bin/stryker': '#!/bin/sh' });
  try {
    const calls = [];
    const run = (cmd, args) => {
      calls.push({ cmd, args });
      const name = path.basename(args[1], '.conf.json');
      write(root, `reports/mutation/${name}.json`, { files: { 'x.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }] } } });
      return { status: name === 'two' ? 1 : 0 };
    };
    const c = capture();
    assert.equal(main(['--root', root, 'all'], { log: c.log, run, platform: 'linux' }), 1);
    assert.equal(calls[0].cmd, path.join(root, 'node_modules', '.bin', 'stryker'));
    assert.deepEqual(calls[0].args, ['run', path.join(root, '.stryker-tmp', 'one.conf.json')]);
    assert.match(c.out.join('\n'), /one: score 50\.0% \(1 killed, 0 timeout, 1 survived, 0 no coverage; break at 55%\)/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, '.stryker-tmp/one.conf.json'), 'utf8')).mutate);
  } finally {
    cleanup(root);
  }
});

test('main on Windows runs the stryker.cmd shim through the shell, quoted; and with no stryker installed it says so', () => {
  const root = makeRepo({ 'scripts/mutation-targets.json': TARGETS, 'node_modules/.bin/stryker.cmd': '@echo off' });
  try {
    const calls = [];
    const run = (cmd, opts) => {
      calls.push({ cmd, opts });
      return { status: 0 };
    };
    assert.equal(main(['--root', root, 'one'], { log: capture().log, run, platform: 'win32' }), 0);
    assert.equal(calls[0].cmd, `"${path.join(root, 'node_modules', '.bin', 'stryker.cmd')}" run "${path.join(root, '.stryker-tmp', 'one.conf.json')}"`);
    assert.equal(calls[0].opts.shell, true);
    const c = capture();
    assert.equal(main(['--root', root, 'one'], { log: c.log, run: () => assert.fail('nothing runs'), platform: 'linux' }), 2);
    assert.match(c.out.join('\n'), /node_modules\/\.bin\/stryker not found: install the dependencies first/);
  } finally {
    cleanup(root);
  }
});

test('the nightly workflow runs exactly the targets of the table', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const text = fs.readFileSync(path.join(root, '.github', 'workflows', 'mutation.yml'), 'utf8');
  const listed = /target: \[([^\]]+)\]/.exec(text)?.[1].split(',').map((t) => t.trim()).sort();
  assert.deepEqual(listed, Object.keys(loadTargets(root)).sort());
});
