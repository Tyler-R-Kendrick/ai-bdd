#!/usr/bin/env node
// @ts-nocheck
// Installs Playwright's Chromium (with system dependencies) only when it is missing.
// Run from a package that depends on playwright-core, e.g.:
//   pnpm --filter @ai-bdd/driver-playwright exec node ../../scripts/ensure-chromium.mjs
// An existing browser is detected through AI_BDD_CHROMIUM_PATH or playwright-core's own executablePath().
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isMain } from './lib.mjs';

/** Returns the path of a usable Chromium executable, or null. */
export function findChromium({ cwd = process.cwd(), env = process.env, exists = fs.existsSync } = {}) {
  if (env.AI_BDD_CHROMIUM_PATH && exists(env.AI_BDD_CHROMIUM_PATH)) return env.AI_BDD_CHROMIUM_PATH;
  const require = createRequire(path.join(cwd, 'noop.js'));
  const { chromium } = require('playwright-core');
  const exe = chromium.executablePath();
  return exe && exists(exe) ? exe : null;
}

export function ensureChromium(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const found = findChromium(options);
  if (found) return { installed: false, executable: found };
  const require = createRequire(path.join(cwd, 'noop.js'));
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', '--with-deps', 'chromium'], { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`playwright-core install chromium failed with exit code ${r.status}`);
  return { installed: true, executable: findChromium(options) };
}

if (isMain(import.meta.url)) {
  try {
    const r = ensureChromium();
    console.log(r.installed ? `chromium installed: ${r.executable}` : `chromium present: ${r.executable}`);
  } catch (e) {
    console.error(`ensure-chromium: ${e.message}`);
    process.exit(1);
  }
}
