import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDeterminism, diffSnapshots, digestOf } from '../check-determinism.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

// The fake CLI is plain JavaScript saved as bin.ts (Node strips types, and there are none to strip). It insists on being
// started as `bin.ts -c <generated test config> compile`.
const PRELUDE = [
  "const [flag, config, command] = process.argv.slice(2);",
  "if (flag !== '-c' || command !== 'compile' || !fs.existsSync(config)) { console.error('bad invocation: ' + process.argv.slice(2).join(' ')); process.exit(2); }",
  "if (!fs.readFileSync(config, 'utf8').includes('packages/testing/corpus/fake-model')) { console.error('config does not point at the fake-model rules'); process.exit(2); }",
].join('\n');
const cli = (body) => `import fs from 'node:fs';\nimport path from 'node:path';\n${PRELUDE}\n${body}`;
const WRITE_PLAN = (content) =>
  `fs.mkdirSync('.ai-bdd/plans', { recursive: true });\nfs.writeFileSync(path.join('.ai-bdd/plans', 'billing.plan.json'), ${content});\n`;

// A stand-in for packages/testing/src/test-config/index.ts: writes a config file that records the options it was given.
const TEST_CONFIG_STUB = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'export function writeTestConfig(opts) {',
  "  const file = path.join(opts.projectDir, 'ai-bdd.config.test.mjs');",
  '  fs.writeFileSync(file, `// stub test config\\n// ${JSON.stringify(opts)}\\n`);',
  '  return file;',
  '}',
].join('\n');

const withCorpus = (bin) => ({
  'packages/testing/corpus/docs/billing.md': '# Billing\n',
  'packages/testing/package.json': { type: 'module' },
  'packages/testing/src/test-config/index.ts': TEST_CONFIG_STUB,
  'packages/cli/src/bin.ts': bin,
});

test('digest and diff helpers', () => {
  const a = new Map([['x', Buffer.from('1')], ['y', Buffer.from('2')]]);
  const b = new Map([['x', Buffer.from('1')], ['y', Buffer.from('3')], ['z', Buffer.from('4')]]);
  assert.deepEqual(diffSnapshots(a, b), ['y: bytes differ', 'z: only in second snapshot']);
  assert.equal(digestOf(a), digestOf(new Map([...a].reverse())));
  assert.notEqual(digestOf(a), digestOf(b));
});

test('skips when the corpus or the cli is missing, exiting ok only when skipping is allowed', () => {
  const root = makeRepo({});
  try {
    const strict = checkDeterminism(root);
    assert.equal(strict.ok, false);
    assert.match(strict.skipped, /not ready/);
    const lenient = checkDeterminism(root, { allowSkip: true });
    assert.equal(lenient.ok, true);
    assert.match(lenient.skipped, /not ready/);
  } finally {
    cleanup(root);
  }
});

test('skips when the test config helper of @ai-bdd/testing is missing', () => {
  const root = makeRepo({ 'packages/testing/corpus/docs/billing.md': '# Billing\n', 'packages/cli/src/bin.ts': cli('') });
  try {
    const r = checkDeterminism(root);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'test config helper not ready');
  } finally {
    cleanup(root);
  }
});

test('skips with "cli not ready" when compile throws NOT_IMPLEMENTED', () => {
  const root = makeRepo(withCorpus(cli("console.error('NOT_IMPLEMENTED: compile'); process.exit(3);")));
  try {
    const strict = checkDeterminism(root);
    assert.equal(strict.ok, false);
    assert.equal(strict.skipped, 'cli not ready');
    assert.equal(checkDeterminism(root, { allowSkip: true }).ok, true);
  } finally {
    cleanup(root);
  }
});

test('passes when plans are byte-identical across incremental and fresh runs', () => {
  const root = makeRepo(withCorpus(cli(WRITE_PLAN("'{\"a\":1}\\n'"))));
  try {
    const r = checkDeterminism(root);
    assert.equal(r.ok, true, r.problems.join('\n'));
    assert.match(r.digest, /^[0-9a-f]{64}$/);
  } finally {
    cleanup(root);
  }
});

test('fails when the plan bytes differ between runs', () => {
  const root = makeRepo(withCorpus(cli(WRITE_PLAN('String(Math.random())'))));
  try {
    const r = checkDeterminism(root);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('billing.plan.json: bytes differ')));
  } finally {
    cleanup(root);
  }
});

test('fails when compile errors for another reason or writes no plans', () => {
  const broken = makeRepo(withCorpus(cli("console.error('kaboom'); process.exit(2);")));
  const empty = makeRepo(withCorpus(cli('')));
  try {
    const a = checkDeterminism(broken, { allowSkip: true });
    assert.equal(a.ok, false);
    assert.match(a.problems[0], /compile failed \(exit 2\).*kaboom/);
    const b = checkDeterminism(empty, { allowSkip: true });
    assert.equal(b.ok, false);
    assert.match(b.problems[0], /no files/);
  } finally {
    cleanup(broken);
    cleanup(empty);
  }
});
