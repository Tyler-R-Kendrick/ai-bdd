import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findChromium } from '../ensure-chromium.mjs';
import { cleanup, makeRepo, write } from './fixture.mjs';

test('an existing AI_BDD_CHROMIUM_PATH wins without loading playwright-core', () => {
  const root = makeRepo({});
  try {
    const exe = write(root, 'chrome', '#!/bin/sh\n');
    assert.equal(findChromium({ cwd: root, env: { AI_BDD_CHROMIUM_PATH: exe } }), exe);
  } finally {
    cleanup(root);
  }
});

test('uses playwright-core executablePath() and reports a missing browser as null', () => {
  const root = makeRepo({
    'node_modules/playwright-core/package.json': { name: 'playwright-core', version: '0.0.0', main: 'index.js' },
    'node_modules/playwright-core/index.js': "module.exports = { chromium: { executablePath: () => '/definitely/not/here/chrome' } };",
  });
  try {
    assert.equal(findChromium({ cwd: root, env: {} }), null);
    assert.equal(findChromium({ cwd: root, env: {}, exists: () => true }), '/definitely/not/here/chrome');
  } finally {
    cleanup(root);
  }
});
