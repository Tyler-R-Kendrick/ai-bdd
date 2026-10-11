import assert from 'node:assert/strict';
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

test('reports offenders from the pnpm store and honours the exceptions file', () => {
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

test('fails clearly when dependencies are not installed', () => {
  const root = makeRepo({});
  try {
    const r = checkLicenses(root);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /pnpm install/);
  } finally {
    cleanup(root);
  }
});
