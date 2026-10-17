import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkLicenses, isAllowedExpression, licenseExpression } from '../check-licenses.mjs';
import { cleanup, makeRepo } from './fixture.mjs';

test('SPDX expressions: OR needs one allowed side, AND needs all, unknown ids fail', () => {
  const ok = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'Python-2.0', 'CC0-1.0', 'mit',
    '(MIT OR GPL-3.0)', '(GPL-3.0 OR MIT)', '(MIT AND ISC)', '(MIT OR (GPL-2.0 AND LGPL-2.1))', 'MIT OR Apache-2.0', 'Apache-2.0 WITH LLVM-exception'];
  const bad = ['GPL-3.0', 'MPL-2.0', '(MIT AND GPL-3.0)', '(GPL-3.0 OR LGPL-2.1)', 'UNLICENSED', 'SEE LICENSE IN LICENSE', '', '(MIT', 'MIT OR', 'AND MIT', 'BSD'];
  for (const e of ok) assert.equal(isAllowedExpression(e), true, e);
  for (const e of bad) assert.equal(isAllowedExpression(e), false, e);
});

test('licenseExpression handles string, object and legacy array forms', () => {
  assert.equal(licenseExpression({ license: 'MIT' }), 'MIT');
  assert.equal(licenseExpression({ license: { type: 'ISC' } }), 'ISC');
  assert.equal(licenseExpression({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), '(MIT OR Apache-2.0)');
  assert.equal(licenseExpression({}), undefined);
});

const store = (name, version, pkgJson) => ({
  [`node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}/package.json`]: { name, version, ...pkgJson },
});

test('reports offenders from pnpm\'s store layout and honours the exceptions file', () => {
  const files = {
    ...store('good', '1.0.0', { license: 'MIT' }),
    ...store('@scope/dual', '2.0.0', { license: '(MIT OR GPL-3.0)' }),
    ...store('bad', '1.0.0', { license: 'GPL-3.0' }),
    ...store('nolic', '1.0.0', {}),
    ...store('weak', '3.0.0', { license: 'MPL-2.0' }),
  };
  const root = makeRepo(files);
  try {
    const r = checkLicenses(root);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => p.split(':')[0]), ['bad@1.0.0', 'nolic@1.0.0', 'weak@3.0.0']);
  } finally {
    cleanup(root);
  }
  const excepted = makeRepo({ ...files, 'scripts/license-exceptions.json': { bad: 'dev only', 'nolic@1.0.0': 'x', weak: 'file-level copyleft, dev only' } });
  try {
    assert.equal(checkLicenses(excepted).ok, true);
  } finally {
    cleanup(excepted);
  }
});

// a package.json at `dir`, named after the path below its last node_modules (or packages) directory
const manifest = (dir, version, pkgJson) => {
  const name = dir.split(/(?:^|\/)(?:node_modules|packages)\//).at(-1);
  return { [`${dir}/package.json`]: { name, version, ...pkgJson } };
};
const offenders = (r) => r.problems.map((p) => p.split(':')[0]);

test('reads a plain nested layout: every node_modules level, scoped packages included', () => {
  const root = makeRepo({
    ...manifest('node_modules/good', '1.0.0', { license: 'MIT' }),
    ...manifest('node_modules/good/node_modules/bad', '1.0.0', { license: 'GPL-3.0' }),
    ...manifest('node_modules/@scope/tool', '2.0.0', { license: 'ISC' }),
    ...manifest('node_modules/@scope/tool/node_modules/nolic', '1.0.0', {}),
    ...manifest('node_modules/@scope/tool/node_modules/good', '0.9.0', { license: 'MIT' }),
    'node_modules/.bin/tool': '#!/bin/sh',
    'node_modules/.package-lock.json': {},
  });
  try {
    const r = checkLicenses(root);
    assert.deepEqual(offenders(r), ['bad@1.0.0', 'nolic@1.0.0']);
    assert.equal(r.summary, '5 packages scanned');
  } finally {
    cleanup(root);
  }
});

test('follows symlinks to their targets, reads each real package once, and survives dangling links and cycles', () => {
  const root = makeRepo({
    ...manifest('store/weak-3.0.0/node_modules/weak', '3.0.0', { license: 'MPL-2.0' }),
    ...manifest('store/weak-3.0.0/node_modules/dep', '1.0.0', { license: 'GPL-2.0' }),
    ...manifest('store/good-1.0.0/node_modules/good', '1.0.0', { license: 'MIT' }),
    ...manifest('packages/sdk', '0.0.0', { license: 'MIT' }),
    ...manifest('packages/sdk/node_modules/inner', '1.0.0', { license: 'GPL-3.0' }),
    'node_modules/.keep': '',
  });
  try {
    const link = (target, at) => {
      fs.mkdirSync(path.dirname(path.join(root, at)), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(path.join(root, at)), path.join(root, target)), path.join(root, at), 'dir');
    };
    link('store/weak-3.0.0/node_modules/weak', 'node_modules/weak'); // the dependency `dep` sits beside the target, as pnpm puts it
    link('store/good-1.0.0/node_modules/good', 'node_modules/good');
    link('store/good-1.0.0/node_modules/good', 'node_modules/alias'); // a second link to the same package
    link('packages/sdk', 'node_modules/@ai-bdd/sdk'); // a workspace link: inner is reached only through its target
    link('store/missing', 'node_modules/dangling');
    link('node_modules', 'packages/sdk/node_modules/loop/node_modules'); // a cycle back to the root
    const r = checkLicenses(root);
    assert.deepEqual(offenders(r), ['dep@1.0.0', 'inner@1.0.0', 'weak@3.0.0']);
    assert.equal(r.summary, '5 packages scanned', 'good is counted once although two links lead to it');
  } finally {
    cleanup(root);
  }
});

test('a link that leaves the repository is refused by name, and nothing beyond it is read', () => {
  const root = makeRepo({ ...manifest('node_modules/good', '1.0.0', { license: 'MIT' }) });
  const outside = makeRepo({
    ...manifest('global/lib/node_modules/linked', '1.0.0', { license: 'MIT' }),
    ...manifest('global/lib/node_modules/unrelated-gpl', '1.0.0', { license: 'GPL-3.0' }),
  });
  try {
    fs.symlinkSync(path.join(outside, 'global/lib/node_modules/linked'), path.join(root, 'node_modules/linked'), 'dir');
    const r = checkLicenses(root);
    assert.deepEqual(r.problems, [`node_modules/linked: a link to ${fs.realpathSync(path.join(outside, 'global/lib/node_modules/linked'))}, outside the repository; not followed`]);
    assert.equal(r.summary, '1 packages scanned');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('a root node_modules that is itself a link to another directory is scanned there', () => {
  const root = makeRepo({});
  const elsewhere = makeRepo({ ...manifest('node_modules/good', '1.0.0', { license: 'MIT' }), ...manifest('node_modules/bad', '1.0.0', { license: 'GPL-3.0' }) });
  try {
    fs.symlinkSync(path.join(elsewhere, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const r = checkLicenses(root);
    assert.deepEqual(offenders(r), ['bad@1.0.0']);
    assert.equal(r.summary, '2 packages scanned');
  } finally {
    cleanup(root);
    cleanup(elsewhere);
  }
});

test('fails clearly when dependencies are not installed', () => {
  const root = makeRepo({});
  try {
    const r = checkLicenses(root);
    assert.equal(r.ok, false);
    assert.equal(r.problems[0], 'node_modules not found: install the dependencies first');
  } finally {
    cleanup(root);
  }
});
