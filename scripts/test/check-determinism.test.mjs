import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDeterminism, diffSnapshots, digestOf } from '../check-determinism.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

// The fake CLI is plain JavaScript saved as bin.ts (Node strips types, and there are none to strip).
const cli = (body) => `import fs from 'node:fs';\nimport path from 'node:path';\n${body}`;
const WRITE_PLAN = (content) =>
  `fs.mkdirSync('.ai-bdd/plans', { recursive: true });\nfs.writeFileSync(path.join('.ai-bdd/plans', 'billing.plan.json'), ${content});\n`;

const withCorpus = (bin) => ({
  'packages/testing/corpus/docs/billing.md': '# Billing\n',
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
