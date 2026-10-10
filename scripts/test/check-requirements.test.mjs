import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRequirements, idPattern } from '../check-requirements.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

const reqs = [
  { id: 'R-EX1', text: 'one' },
  { id: 'R-EX10', text: 'ten' },
];

test('idPattern does not match longer ids', () => {
  assert.ok(idPattern('R-EX1').test("it('R-EX1: x')"));
  assert.ok(!idPattern('R-EX1').test("it('R-EX10: x')"));
  assert.ok(!idPattern('R-EX1').test('XR-EX1'));
});

test('passes when every id is in a test title under packages/*/test or tests/', () => {
  const root = makeRepo({
    'docs/requirements.json': reqs,
    'packages/sdk/test/a/a.test.ts': "it('R-EX1: works', () => {});",
    'tests/acceptance/b.test.ts': 'describe(`R-EX10 matrix`, () => {});',
  });
  try {
    const r = checkRequirements(root);
    assert.equal(r.ok, true, r.problems.join('\n'));
  } finally {
    cleanup(root);
  }
});

test('an id only in a comment, in a non-test file, or as a prefix of another id does not count', () => {
  const root = makeRepo({
    'docs/requirements.json': reqs,
    'packages/sdk/test/a.test.ts': "// R-EX1 mentioned in a comment only\nit('R-EX10: only ten', () => {});",
    'packages/sdk/test/helper.ts': "export const t = 'R-EX1';",
    'packages/sdk/src/x.test.ts': "it('R-EX1', () => {});",
  });
  try {
    const r = checkRequirements(root);
    assert.equal(r.ok, false);
    assert.deepEqual(r.uncovered, ['R-EX1']);
  } finally {
    cleanup(root);
  }
});

test('an id in the test file name counts', () => {
  const root = makeRepo({
    'docs/requirements.json': [{ id: 'R-EX1', text: 'one' }],
    'tests/acceptance/R-EX1.test.ts': 'export {};',
  });
  try {
    assert.equal(checkRequirements(root).ok, true);
  } finally {
    cleanup(root);
  }
});

test('reports a malformed or missing requirements file, and duplicates', () => {
  const missing = makeRepo({});
  const dup = makeRepo({ 'docs/requirements.json': [{ id: 'R-EX1', text: 'a' }, { id: 'R-EX1', text: 'b' }, { id: 'bad' }] });
  try {
    assert.equal(checkRequirements(missing).ok, false);
    const r = checkRequirements(dup);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('duplicate')));
    assert.ok(r.problems.some((p) => p.includes('invalid requirement entry')));
  } finally {
    cleanup(missing);
    cleanup(dup);
  }
});
