import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStubs } from '../check-stubs.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

test('allows notImplemented in the contracts file and in comments, flags calls elsewhere', () => {
  const root = makeRepo({
    'packages/sdk/src/contracts/index.ts': 'export function notImplemented(w: string): never { throw new Error(w); }',
    'packages/sdk/src/plan/index.ts': "// notImplemented('later')\nexport const ok = 1;",
    'packages/sdk/src/judge/index.ts': "import { notImplemented } from '../contracts/index.ts';\nexport function judge() {\n  return notImplemented('judge');\n}",
    'packages/sdk/test/x.test.ts': "notImplemented('tests are not scanned');",
  });
  try {
    const r = checkStubs(root);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, ['packages/sdk/src/judge/index.ts:3 notImplemented( call remains']);
  } finally {
    cleanup(root);
  }
});

test('passes on a tree without stubs', () => {
  const root = makeRepo({ 'packages/cli/src/bin.ts': 'export {};' });
  try {
    assert.equal(checkStubs(root).ok, true);
  } finally {
    cleanup(root);
  }
});
