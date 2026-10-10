import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { anchorsOf, checkDocs, checkLinks, classifyBlock, docFiles, extractBlocks, extractLinks, slugOf } from '../check-docs.mjs';
import { cleanup, makeRepo, write } from './fixture.mjs';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('extractBlocks reads info strings, indentation and tilde fences', () => {
  const md = ['# T', '', '```ts check', 'const a = 1;', '```', '', '- item', '', '  ```sh run in=project exit=4', '  ai-bdd status', '  ```', '', '~~~text', 'x', '~~~'].join('\n');
  const blocks = extractBlocks(md);
  assert.deepEqual(
    blocks.map((b) => [b.lang, b.tags, b.code, b.line]),
    [
      ['ts', ['check'], 'const a = 1;', 3],
      ['sh', ['run', 'in=project', 'exit=4'], 'ai-bdd status', 9],
      ['text', [], 'x', 13],
    ],
  );
});

test('a longer fence can contain a shorter one', () => {
  const blocks = extractBlocks('````md\n```ts check\nnot a block\n```\n````\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, 'md');
  assert.match(blocks[0].code, /not a block/);
});

test('classifyBlock accepts the two tags and rejects typos and wrong languages', () => {
  const c = (info) => {
    const [lang, ...tags] = info.split(' ');
    return classifyBlock({ lang, tags });
  };
  assert.deepEqual(c('ts check'), { kind: 'ts-check' });
  assert.deepEqual(c('sh run'), { kind: 'sh-run', in: 'root', exit: 0 });
  assert.deepEqual(c('sh run in=project exit=2'), { kind: 'sh-run', in: 'project', exit: 2 });
  assert.deepEqual(c('ts'), { kind: null });
  assert.match(c('sh run in=nowhere').problem, /unknown tag/);
  assert.match(c('ts check strict').problem, /unknown tag/);
  assert.match(c('python run').problem, /only valid on/);
  assert.match(c('ts run').problem, /only valid on/);
});

test('slugOf and anchorsOf follow GitHub rules, including duplicates and code fences', () => {
  assert.equal(slugOf('`ai-bdd run` & friends (v2)'), 'ai-bdd-run--friends-v2');
  assert.equal(slugOf('Why a separate compile step?'), 'why-a-separate-compile-step');
  const md = '# One\n\n## Same\n\n## Same\n\n```md\n## Not a heading\n```\n\n### [Linked](x.md) *title*\n';
  assert.deepEqual([...anchorsOf(md)].sort(), ['linked-title', 'one', 'same', 'same-1']);
});

test('extractLinks skips code spans and fenced code, and reads reference definitions', () => {
  const md = ['See [a](docs/a.md) and `[b](nope.md)`.', '![img](pic.png "t")', '```', '[c](nope2.md)', '```', '[ref]: other.md#x'].join('\n');
  assert.deepEqual(
    extractLinks(md).map((l) => l.target),
    ['docs/a.md', 'pic.png', 'other.md#x'],
  );
});

test('docFiles scans README and docs/*.md but not generated or foreign-owned files', () => {
  const root = makeRepo({
    'README.md': '# R',
    'docs/a.md': '# A',
    'docs/errors.md': '# E',
    'docs/adversarial-findings.md': '# X',
    'docs/integration-notes/n.md': '# N',
  });
  try {
    assert.deepEqual(docFiles(root), ['README.md', 'docs/a.md']);
  } finally {
    cleanup(root);
  }
});

test('checkLinks flags missing files and anchors, ignores external links and accepts valid ones', () => {
  const root = makeRepo({
    'README.md': '# Top\n\n[ok](docs/a.md#section-one) [self](#top) [ext](https://example.com/x) [mail](mailto:a@b.c)\n[bad file](docs/missing.md)\n[bad anchor](docs/a.md#nope)\n[outside](../elsewhere.md)\n',
    'docs/a.md': '# A\n\n## Section one\n\n[up](../README.md)\n',
  });
  try {
    const problems = checkLinks(root, ['README.md', 'docs/a.md']);
    assert.deepEqual(problems, [
      'README.md:4: broken link docs/missing.md',
      'README.md:5: no heading for anchor #nope in docs/a.md',
      'README.md:6: link leaves the repository: ../elsewhere.md',
    ]);
  } finally {
    cleanup(root);
  }
});

// A stand-in for packages/testing/src/test-config/index.ts: writes a config file that records the options it was given.
const TEST_CONFIG_STUB = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'export function writeTestConfig(opts) {',
  "  const file = path.join(opts.projectDir, 'ai-bdd.config.test.mjs');",
  '  fs.writeFileSync(file, JSON.stringify(opts));',
  '  return file;',
  '}',
].join('\n');

/** A fake repository whose CLI prints its arguments and environment so that sandbox behavior can be asserted. */
function fakeRepo(extra = {}) {
  return makeRepo({
    'packages/cli/src/bin.ts': [
      "import fs from 'node:fs';",
      'const args = process.argv.slice(2);',
      "const cfg = args[0] === '-c' && fs.existsSync(args[1]) ? JSON.parse(fs.readFileSync(args[1], 'utf8')) : undefined;",
      "const command = args[0] === '-c' ? args.slice(2) : args;",
      "console.log('cli', command.join(' '), 'config=' + (cfg ? cfg.projectDir.split('/').slice(-1)[0] : 'none'), 'rules=' + (cfg ? cfg.rulesDir.split('/').slice(-2).join('/') : 'none'), 'aibddenv=' + Object.keys(process.env).filter((k) => k.startsWith('AI_BDD_')).length, 'ci=' + (process.env.CI ?? 'unset'));",
      "if (command[0] === 'fail') process.exit(3);",
      "if (command[0] === 'touch') fs.writeFileSync('touched.txt', 'x');",
    ].join('\n'),
    'packages/testing/src/test-config/index.ts': TEST_CONFIG_STUB,
    'packages/testing/package.json': { type: 'module' },
    'packages/testing/corpus/docs/one.md': '# One\n',
    'packages/testing/corpus/fake-model/rules.json': '{}',
    'package.json': { type: 'module' },
    ...extra,
  });
}

test('sh run blocks run in a repository mirror, share state per file, and honor exit=N', () => {
  const root = fakeRepo({
    'docs/guide.md': [
      '# Guide',
      '',
      '```sh run',
      'test -d packages/testing/corpus/docs',
      'cp -r packages/testing/corpus packages/testing/.copy',
      'echo marker > created-by-first-block.txt',
      '```',
      '',
      '```sh run',
      'test -f created-by-first-block.txt && test -d packages/testing/.copy/docs',
      'test -L packages/cli',
      '```',
      '',
      '```sh run in=project',
      'ai-bdd touch',
      'test -f touched.txt',
      'test -z "${AI_BDD_LEAK_PROBE:-}"',
      '```',
      '',
      '```sh run in=project exit=3',
      'ai-bdd fail',
      '```',
      '',
    ].join('\n'),
  });
  try {
    const r = checkDocs(root, { ts: false, links: false });
    assert.deepEqual(r.problems, []);
    assert.equal(r.stats.shBlocks, 4);
    // The real work tree is untouched: nothing was copied into it.
    assert.equal(fs.existsSync(path.join(root, 'packages', 'testing', '.copy')), false);
    assert.equal(fs.existsSync(path.join(root, 'created-by-first-block.txt')), false);
  } finally {
    cleanup(root);
  }
});

test('project blocks get an ai-bdd shim that injects -c <generated test config>; root blocks get neither; outer CI and AI_BDD_* do not leak', () => {
  const root = fakeRepo({
    'docs/env.md': [
      '```sh run in=project',
      'out=$(ai-bdd status --x)',
      'echo "$out"',
      'echo "$out" | grep -q "^cli status --x config=.docs-project rules=.docs-project/fake-model aibddenv=0 ci=unset"',
      '# a -c given by the document comes after the injected one and wins (the stub CLI only reads the first)',
      'ai-bdd -c other.mjs status | grep -q "^cli -c other.mjs status"',
      '```',
      '',
      '```sh run',
      'test -z "${AI_BDD_LEAK_PROBE:-}"',
      'test -z "${CI:-}"',
      '! command -v ai-bdd',
      '```',
      '',
    ].join('\n'),
  });
  const saved = { CI: process.env.CI, AI_BDD_LEAK_PROBE: process.env.AI_BDD_LEAK_PROBE };
  process.env.CI = '1';
  process.env.AI_BDD_LEAK_PROBE = '1';
  try {
    const r = checkDocs(root, { ts: false, links: false });
    assert.deepEqual(r.problems, []);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup(root);
  }
});

test('a failing sh block is reported with its output and stops later blocks of that file only', () => {
  const root = fakeRepo();
  const marker = path.join(root, 'marker.txt');
  write(root, 'docs/a.md', `\`\`\`sh run\necho before-failure\nexit 7\n\`\`\`\n\n\`\`\`sh run\necho never-runs > "${marker}"\n\`\`\`\n`);
  write(root, 'docs/b.md', '```sh run exit=5\nexit 5\n```\n\n```sh run\ntrue\n```\n');
  write(root, 'docs/c.md', '```sh run\nexit 0\n```\n\n```sh run in=project exit=2\nexit 0\n```\n');
  try {
    const r = checkDocs(root, { ts: false, links: false });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0], /^docs\/a\.md:1: sh run block exited 7, expected 0\n\s+\| before-failure/);
    assert.match(r.problems[1], /^docs\/c\.md:5: sh run block exited 0, expected 2/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    cleanup(root);
  }
});

test('tag problems are reported with file and line', () => {
  const root = fakeRepo({ 'docs/t.md': '# T\n\n```sh runn\nls\n```\n\n```py run\nx\n```\n\n```ts check strict\nx\n```\n' });
  try {
    const r = checkDocs(root, { ts: false, run: false, links: false });
    // "runn" is not a recognized tag, so that block is simply untagged.
    assert.equal(r.problems.length, 2);
    assert.match(r.problems[0], /^docs\/t\.md:7: tag "run" is only valid/);
    assert.match(r.problems[1], /^docs\/t\.md:11: unknown tag\(s\) on ts check block: strict/);
  } finally {
    cleanup(root);
  }
});

test('ts check blocks are typechecked with the repository settings and errors map to the markdown line', { skip: !fs.existsSync(path.join(REAL_ROOT, 'node_modules', 'typescript')) }, () => {
  const make = (code) => {
    const root = makeRepo({ 'docs/ts.md': `# Types\n\nText.\n\n\`\`\`ts check\n${code}\n\`\`\`\n` });
    fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.copyFileSync(path.join(REAL_ROOT, 'tsconfig.base.json'), path.join(root, 'tsconfig.base.json'));
    return root;
  };
  const good = make("import { normalizeText } from '@ai-bdd/sdk';\nconst s: string = normalizeText(' a  b ');\nconsole.log(s);");
  const noImports = make('const n: number = 1;\nconsole.log(n);');
  const bad = make("import { normalizeText } from '@ai-bdd/sdk';\n\nconst n: number = normalizeText('x');\nconsole.log(n);");
  try {
    // @ai-bdd/sdk resolves through the symlinked node_modules of the real checkout.
    assert.deepEqual(checkDocs(good, { run: false, links: false }).problems, []);
    assert.deepEqual(checkDocs(noImports, { run: false, links: false }).problems, []);
    const r = checkDocs(bad, { run: false, links: false });
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /^docs\/ts\.md:8: error TS2322/); // fence on line 5, error on block line 3
  } finally {
    for (const r of [good, noImports, bad]) cleanup(r);
  }
});

test('the repository documentation passes the link check', () => {
  const r = checkDocs(REAL_ROOT, { ts: false, run: false });
  assert.deepEqual(r.problems, []);
  assert.ok(r.stats.files >= 1);
});

test('write helper sanity (fixture files are created below the root)', () => {
  const root = makeRepo({});
  try {
    write(root, 'a/b.txt', 'x');
    assert.equal(fs.readFileSync(path.join(root, 'a', 'b.txt'), 'utf8'), 'x');
  } finally {
    cleanup(root);
  }
});
