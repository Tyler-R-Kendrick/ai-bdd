// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { describeCode, generateErrorsDoc, groupOf, parseContracts, run } from '../gen-errors-doc.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

const CONTRACTS = `
export const ERROR_CODES = [
  'USAGE', 'CONFIG_INVALID',
  'DRIVER_ERROR', 'PLAN_STALE',
  'NOT_IMPLEMENTED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['DRIVER_ERROR']);
`;

const base = () => ({
  'packages/sdk/src/contracts/index.ts': CONTRACTS,
  'packages/sdk/src/config/index.ts': "throw new AiBddError('CONFIG_INVALID', 'x');",
  'packages/sdk/test/plan.test.ts': "expect(e.code).toBe('PLAN_STALE');",
});

test('parseContracts reads codes and the retryable set', () => {
  const { codes, retryable } = parseContracts(CONTRACTS);
  assert.deepEqual(codes, ['USAGE', 'CONFIG_INVALID', 'DRIVER_ERROR', 'PLAN_STALE', 'NOT_IMPLEMENTED']);
  assert.deepEqual([...retryable], ['DRIVER_ERROR']);
  assert.throws(() => parseContracts('export const X = 1;'), /ERROR_CODES/);
});

test('group and description derive from the code name', () => {
  assert.equal(groupOf('EXTRACT_MODEL_OUTPUT_INVALID'), 'extract');
  assert.equal(groupOf('USAGE'), 'general');
  assert.equal(describeCode('ACT_TARGET_AMBIGUOUS'), 'Act target ambiguous.');
});

test('generates a table with retryable flags and reserved markers', () => {
  const root = makeRepo(base());
  try {
    const doc = generateErrorsDoc(root);
    assert.match(doc, /\| `DRIVER_ERROR` \| yes \| driver \| Driver error\. \| reserved \|/);
    assert.match(doc, /\| `CONFIG_INVALID` \| no \| config \| Config invalid\. \| referenced \|/);
    assert.match(doc, /\| `PLAN_STALE` \| no \| plan \| Plan stale\. \| referenced \|/);
    assert.match(doc, /\| `USAGE` \| no \| general \| Usage\. \| reserved \|/);
    assert.equal(generateErrorsDoc(root), doc, 'deterministic');
  } finally {
    cleanup(root);
  }
});

test('the contracts file itself does not count as a reference', () => {
  const root = makeRepo({ 'packages/sdk/src/contracts/index.ts': `${CONTRACTS}\nnew AiBddError('USAGE', 'in contracts');` });
  try {
    assert.match(generateErrorsDoc(root), /`USAGE` \| no \| general \| Usage\. \| reserved \|/);
  } finally {
    cleanup(root);
  }
});

test('--check fails when the file is missing or drifts, and passes after writing', () => {
  const root = makeRepo(base());
  try {
    assert.equal(run(root, { check: true }).ok, false);
    assert.equal(run(root).ok, true);
    assert.equal(run(root, { check: true }).ok, true);
    fs.appendFileSync(path.join(root, 'docs', 'errors.md'), 'hand edit\n');
    const drift = run(root, { check: true });
    assert.equal(drift.ok, false);
    assert.match(drift.problems[0], /out of date/);
    run(root);
    assert.equal(run(root, { check: true }).ok, true);
    // a new reference elsewhere flips the status, which is drift too
    fs.writeFileSync(path.join(root, 'packages/sdk/test/new.test.ts'), "it('x', () => expect(c).toBe('USAGE'));");
    assert.equal(run(root, { check: true }).ok, false);
  } finally {
    cleanup(root);
  }
});
