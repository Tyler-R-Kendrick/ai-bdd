import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildOrder, main, readPackages, scriptEnv, workspacePatterns } from '../build-packages.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

const manifest = (name, build, deps = {}, dev = {}) => ({ name, version: '0.0.0', scripts: build === undefined ? {} : { build }, dependencies: deps, devDependencies: dev });

function capture() {
  const out = [];
  return { out, log: { log: (m) => out.push(String(m)), error: (m) => out.push(String(m)) } };
}

test('readPackages lists packages/*/package.json in directory order and ignores directories without a manifest', () => {
  const root = makeRepo({
    'packages/b/package.json': manifest('@x/b', 'tsc'),
    'packages/a/package.json': manifest('@x/a', 'tsc'),
    'packages/notes/README.md': 'no manifest',
  });
  try {
    assert.deepEqual(readPackages(root).map((p) => [p.name, path.basename(p.dir)]), [['@x/a', 'a'], ['@x/b', 'b']]);
    assert.deepEqual(readPackages(path.join(root, 'missing')), []);
  } finally {
    cleanup(root);
  }
});

test('workspacePatterns reads the packages list of pnpm-workspace.yaml, block or flow, and nothing else', () => {
  const block = ['# the workspace', 'packages:', "  - 'apps/*'   # apps", '  - "tools/x"', '', '  - libs/**', "  - '!libs/old'", 'overrides:', '  qs: ">=6"'].join('\n');
  assert.deepEqual(workspacePatterns(block), ['apps/*', 'tools/x', 'libs/**', '!libs/old']);
  assert.deepEqual(workspacePatterns("packages: ['a/*', \"b\"]  # flow\n"), ['a/*', 'b']);
  assert.deepEqual(workspacePatterns("packages:\r\n  - 'it''s/*'\r\n"), ["it's/*"]);
  assert.equal(workspacePatterns('overrides:\n  qs: x\n'), undefined);
});

test('readPackages takes the packages pnpm-workspace.yaml lists, with globs and exclusions, and never the root', () => {
  const root = makeRepo({
    'pnpm-workspace.yaml': ['packages:', "  - 'apps/*'", '  - tools/x', '  - libs/**', "  - '!libs/old'", '  - .'].join('\n'),
    'package.json': manifest('root', 'node scripts/build-packages.mjs'),
    'apps/web/package.json': manifest('@x/web', 'tsc'),
    'apps/notes/README.md': 'no manifest',
    'tools/x/package.json': manifest('@x/tool', 'tsc'),
    'tools/y/package.json': manifest('@x/not-listed', 'tsc'),
    'libs/a/b/package.json': manifest('@x/deep', 'tsc'),
    'libs/old/package.json': manifest('@x/old', 'tsc'),
    'libs/a/node_modules/dep/package.json': manifest('dep', 'tsc'),
    'packages/sdk/package.json': manifest('@x/sdk', 'tsc'),
  });
  try {
    assert.deepEqual(readPackages(root).map((p) => [p.name, p.where]), [['@x/web', 'apps/web'], ['@x/deep', 'libs/a/b'], ['@x/tool', 'tools/x']]);
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'overrides:\n  qs: x\n');
    assert.throws(() => readPackages(root), /^Error: pnpm-workspace\.yaml has no packages list$/);
    fs.rmSync(path.join(root, 'pnpm-workspace.yaml'));
    assert.deepEqual(readPackages(root).map((p) => p.where), ['packages/sdk'], 'with no pnpm-workspace.yaml, packages/* is the workspace');
  } finally {
    cleanup(root);
  }
});

test("this repository's workspace is pnpm-workspace.yaml's packages/*: the eight packages", () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  assert.deepEqual(workspacePatterns(fs.readFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'utf8')), ['packages/*']);
  const dirs = fs.readdirSync(path.join(repo, 'packages')).filter((d) => fs.existsSync(path.join(repo, 'packages', d, 'package.json'))).sort();
  assert.deepEqual(readPackages(repo).map((p) => p.where), dirs.map((d) => `packages/${d}`));
});

test('buildOrder puts every package after the workspace packages it depends on, in any dependency field and with any range', () => {
  const pkgs = [
    { name: '@x/app', manifest: manifest('@x/app', 'tsc', { '@x/sdk': 'workspace:*', '@x/ui': '0.0.0' }) },
    { name: '@x/sdk', manifest: manifest('@x/sdk', 'tsc', { zod: '^4' }) },
    { name: '@x/test', manifest: manifest('@x/test', 'tsc', {}, { '@x/app': 'workspace:^' }) },
    { name: '@x/ui', manifest: { ...manifest('@x/ui', 'tsc'), peerDependencies: { '@x/sdk': '*' } } },
    { name: '@x/zz', manifest: manifest('@x/zz', 'tsc') },
  ];
  // sdk and zz have no workspace dependency; ui needs sdk (peer); app needs sdk and ui; test needs app (dev)
  assert.deepEqual(buildOrder(pkgs).map((p) => p.name), ['@x/sdk', '@x/zz', '@x/ui', '@x/app', '@x/test']);
  // listed the other way round, independent packages keep the listed order, and dependencies still come first
  assert.deepEqual(buildOrder([...pkgs].reverse()).map((p) => p.name), ['@x/zz', '@x/sdk', '@x/ui', '@x/app', '@x/test']);
});

test('buildOrder refuses a dependency cycle and names its members', () => {
  const pkgs = [
    { name: 'a', manifest: manifest('a', 'tsc', { b: '*' }) },
    { name: 'b', manifest: manifest('b', 'tsc', { c: '*' }) },
    { name: 'c', manifest: manifest('c', 'tsc', { a: '*' }) },
    { name: 'free', manifest: manifest('free', 'tsc') },
  ];
  assert.throws(() => buildOrder(pkgs), /dependency cycle among a, b, c$/);
});

test('two packages with the same name are refused, naming both directories, before anything is built', () => {
  const root = makeRepo({
    'packages/dup-a/package.json': manifest('@x/dup', 'tsc', { '@x/lib': 'workspace:*' }),
    'packages/dup-b/package.json': manifest('@x/dup', 'tsc'),
    'packages/lib/package.json': manifest('@x/lib', 'tsc'),
  });
  try {
    assert.throws(() => buildOrder(readPackages(root)), /^Error: two workspace packages are named @x\/dup: packages\/dup-a and packages\/dup-b$/);
    const c = capture();
    assert.equal(main(['--root', root], { log: c.log, run: () => assert.fail('nothing runs'), env: {} }), 1);
    assert.match(c.out.join('\n'), /build-packages: two workspace packages are named @x\/dup: packages\/dup-a and packages\/dup-b/);
  } finally {
    cleanup(root);
  }
});

test('a malformed package.json is reported with its path', () => {
  const root = makeRepo({ 'packages/a/package.json': '{ "name": "a", }' });
  try {
    const c = capture();
    assert.equal(main(['--root', root], { log: c.log, run: () => assert.fail('nothing runs'), env: {} }), 1);
    assert.match(c.out.join('\n'), /^build-packages: packages\/a\/package\.json is not valid JSON: /m);
  } finally {
    cleanup(root);
  }
});

test('scriptEnv puts each node_modules/.bin from the package up to the root first on PATH', () => {
  const root = path.resolve('/repo');
  const dir = path.join(root, 'packages', 'sdk');
  const env = scriptEnv(root, dir, { PATH: '/usr/bin', HOME: '/h' }, 'linux');
  assert.deepEqual(env.PATH.split(':'), [path.join(dir, 'node_modules/.bin'), path.join(root, 'packages/node_modules/.bin'), path.join(root, 'node_modules/.bin'), '/usr/bin']);
  assert.equal(env.HOME, '/h');
  // Windows: the existing Path variable is extended, with ';', and no second PATH is added
  const win = scriptEnv(root, dir, { Path: 'C:\\Windows' }, 'win32');
  assert.deepEqual(Object.keys(win), ['Path']);
  assert.equal(win.Path.split(';').at(-1), 'C:\\Windows');
  assert.equal(win.Path.split(';').length, 4);
});

test('main runs each build script through the shell in its package directory, in dependency order', () => {
  const root = makeRepo({
    'packages/cli/package.json': manifest('@x/cli', 'tsc -p tsconfig.build.json', { '@x/sdk': 'workspace:*' }),
    'packages/docs/package.json': manifest('@x/docs', undefined),
    'packages/sdk/package.json': manifest('@x/sdk', 'tsc -p tsconfig.build.json && echo done'),
  });
  try {
    const calls = [];
    const run = (command, opts) => {
      calls.push({ command, cwd: opts.cwd, shell: opts.shell, path: opts.env.PATH });
      return { status: 0 };
    };
    const c = capture();
    assert.equal(main(['--root', root], { log: c.log, run, env: { PATH: '/usr/bin' }, platform: 'linux' }), 0);
    assert.deepEqual(calls.map((x) => [x.command, path.basename(x.cwd), x.shell]), [
      ['tsc -p tsconfig.build.json && echo done', 'sdk', true],
      ['tsc -p tsconfig.build.json', 'cli', true],
    ]);
    assert.equal(calls[0].path.split(':')[0], path.join(root, 'packages', 'sdk', 'node_modules', '.bin'));
    assert.ok(calls[0].path.split(':').includes(path.join(root, 'node_modules', '.bin')));
    assert.match(c.out.join('\n'), /@x\/docs \(packages\/docs\) has no build script, skipped/);
    assert.match(c.out.join('\n'), /2 package\(s\) built/);
  } finally {
    cleanup(root);
  }
});

test('main stops at the first failing build and names the package', () => {
  const root = makeRepo({
    'packages/a/package.json': manifest('@x/a', 'exit 3'),
    'packages/b/package.json': manifest('@x/b', 'tsc', { '@x/a': 'workspace:*' }),
  });
  try {
    const ran = [];
    const c = capture();
    const run = (command, opts) => {
      ran.push(path.basename(opts.cwd));
      return { status: 3 };
    };
    assert.equal(main(['--root', root], { log: c.log, run, env: {}, platform: 'linux' }), 1);
    assert.deepEqual(ran, ['a'], 'nothing that depends on the failed package is built');
    assert.match(c.out.join('\n'), /build-packages: @x\/a \(packages\/a\) failed: exit code 3/);
    // a script that could not be started, or that was killed, is a failure too
    const spawnFailed = capture();
    assert.equal(main(['--root', root], { log: spawnFailed.log, run: () => ({ status: null, error: new Error('spawn sh ENOENT') }), env: {} }), 1);
    assert.match(spawnFailed.out.join('\n'), /@x\/a \(packages\/a\) failed: spawn sh ENOENT/);
    const killed = capture();
    assert.equal(main(['--root', root], { log: killed.log, run: () => ({ status: null, signal: 'SIGTERM' }), env: {} }), 1);
    assert.match(killed.out.join('\n'), /@x\/a \(packages\/a\) failed: signal SIGTERM/);
  } finally {
    cleanup(root);
  }
});

test('main reports a dependency cycle instead of building anything', () => {
  const root = makeRepo({
    'packages/a/package.json': manifest('@x/a', 'tsc', { '@x/b': '*' }),
    'packages/b/package.json': manifest('@x/b', 'tsc', { '@x/a': '*' }),
  });
  try {
    const c = capture();
    assert.equal(main(['--root', root], { log: c.log, run: () => assert.fail('nothing runs'), env: {} }), 1);
    assert.match(c.out.join('\n'), /dependency cycle among @x\/a, @x\/b/);
  } finally {
    cleanup(root);
  }
});

test('main really runs the scripts: a failing shell command fails the build (no package manager involved)', () => {
  const root = makeRepo({
    'packages/a/package.json': manifest('@x/a', 'node -e "require(\'fs\').writeFileSync(\'built.txt\', process.cwd())"'),
    'packages/b/package.json': manifest('@x/b', 'node -e "process.exit(5)"', { '@x/a': 'workspace:*' }),
  });
  try {
    const c = capture();
    assert.equal(main(['--root', root], { log: c.log }), 1);
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(root, 'packages/a/built.txt'), 'utf8')), fs.realpathSync(path.join(root, 'packages/a')));
    assert.match(c.out.join('\n'), /@x\/b \(packages\/b\) failed: exit code 5/);
  } finally {
    cleanup(root);
  }
});

test('the root build script needs no package manager', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'node scripts/build-packages.mjs');
  for (const p of readPackages(root)) {
    for (const [name, script] of Object.entries(p.manifest.scripts ?? {})) assert.doesNotMatch(script, /\b(pnpm|npx|yarn|npm)\b/, `${p.name} ${name}`);
  }
});
