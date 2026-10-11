import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '@ai-bdd/sdk/contracts';

/**
 * Playwright fixes its browsers directory when it is first loaded. This file sets PLAYWRIGHT_BROWSERS_PATH to an empty
 * directory before anything imports it (each test file runs in its own process), so the revision Playwright expects
 * is never there and driver.ts has to fall back to `discoverChromium`, exactly as on a machine with a pre-installed
 * browser of another revision. Discovery itself reads the variable on every call, so each test points it at a
 * directory laid out like a Playwright browsers directory.
 */
const pw = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  const originalBrowsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  const emptyRegistry = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bdd-pw-registry-'));
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = emptyRegistry;
  return { originalBrowsersPath, emptyRegistry };
});

const { createDriverFactory, discoverChromium, playwright } = await import('../src/index.ts');

const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const scratch = mkdtempSync(join(tmpdir(), 'ai-bdd-pw-discovery-'));
/** The Chromium that really exists on this machine (found the way a pre-installed image would have it). */
const real = discoverChromium(true, { PLAYWRIGHT_BROWSERS_PATH: pw.originalBrowsersPath });
const saved = process.env['AI_BDD_CHROMIUM_PATH'];

afterEach(() => {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = pw.emptyRegistry;
  if (saved === undefined) delete process.env['AI_BDD_CHROMIUM_PATH'];
  else process.env['AI_BDD_CHROMIUM_PATH'] = saved;
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(pw.emptyRegistry, { recursive: true, force: true });
});

/** Install `body` as the executable `<root>/chromium-<rev>/chrome-linux/chrome`. */
function installLauncher(root: string, rev: number, body: string): string {
  const exe = join(root, `chromium-${rev}`, 'chrome-linux', 'chrome');
  mkdirSync(join(exe, '..'), { recursive: true });
  writeFileSync(exe, `#!/bin/sh\n${body}\n`);
  chmodSync(exe, 0o755);
  return exe;
}
/** A launcher that records each start in `marker` and then runs the real Chromium. */
const recording = (marker: string): string => `echo started >> '${marker}'\nexec '${real}' "$@"`;
const open = (d: Awaited<ReturnType<ReturnType<typeof playwright>['create']>>) => d.openSession({ scenarioId: 's', policy, resolveValue: () => '' });

describe('Chromium discovery when the expected revision is not installed', () => {
  it('V7: Playwright really looks in the empty registry (precondition for the tests below)', async () => {
    expect(existsSync(pw.emptyRegistry)).toBe(true);
    const { chromium } = await import('playwright-core');
    expect(chromium.executablePath().startsWith(pw.emptyRegistry)).toBe(true);
  });

  it.skipIf(real === undefined)('V7: launches the discovered Chromium of another revision and the session works', async () => {
    const root = mkdtempSync(join(scratch, 'ok-'));
    const marker = join(root, 'marker');
    installLauncher(root, 999_991, recording(marker));
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = root;
    const driver = await playwright().create({ projectRoot: '.', policy, artifactsDir: scratch });
    expect(await driver.selfCheck()).toEqual({ ok: true, problems: [] });
    expect(readFileSync(marker, 'utf8')).toBe('started\n');
    const session = await open(driver);
    expect(session.driverId).toBe('playwright');
    await session.close();
    expect(readFileSync(marker, 'utf8')).toBe('started\n'); // one browser for selfCheck and the session
    await driver.dispose();
  });

  it.skipIf(real === undefined)('V7: a discovered Chromium that fails to start is DRIVER_UNAVAILABLE naming its path; a later retry on the same driver can succeed', async () => {
    const bad = mkdtempSync(join(scratch, 'bad-'));
    const good = mkdtempSync(join(scratch, 'good-'));
    const badExe = installLauncher(bad, 999_992, 'echo "boom from fake chrome" >&2\nexit 3');
    const marker = join(good, 'marker');
    installLauncher(good, 999_993, recording(marker));

    process.env['PLAYWRIGHT_BROWSERS_PATH'] = bad;
    const driver = await playwright().create({ projectRoot: '.', policy, artifactsDir: scratch });
    const err = await open(driver).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    const message = (err as Error).message;
    expect(message.startsWith(`could not launch Chromium at ${badExe}: `)).toBe(true);
    expect(message).not.toContain('\n');
    expect((err as Error).cause).toBeInstanceOf(Error);

    // The failed launch is not cached: pointing discovery at a working install lets the same driver recover.
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = good;
    const session = await open(driver);
    expect(readFileSync(marker, 'utf8')).toBe('started\n');
    await session.close();
    await driver.dispose();
  });

  it('V7: AI_BDD_CHROMIUM_PATH selects the executable directly: no discovery, and a bad value is never silently replaced', async () => {
    const root = mkdtempSync(join(scratch, 'env-'));
    const marker = join(root, 'marker');
    const exe = real === undefined ? '/nonexistent/chrome' : installLauncher(root, 999_994, recording(marker));
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = root; // discovery would find the same launcher
    process.env['AI_BDD_CHROMIUM_PATH'] = '/nonexistent/env-chrome';
    const failing = await playwright().create({ projectRoot: '.', policy, artifactsDir: scratch });
    const check = await failing.selfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/^could not launch chromium: .*\/nonexistent\/env-chrome/);
    await failing.dispose();
    if (real !== undefined) expect(existsSync(marker)).toBe(false);

    if (real === undefined) return;
    process.env['AI_BDD_CHROMIUM_PATH'] = exe;
    const working = await playwright().create({ projectRoot: '.', policy, artifactsDir: scratch });
    expect(await working.selfCheck()).toEqual({ ok: true, problems: [] });
    expect(readFileSync(marker, 'utf8')).toBe('started\n');
    await working.dispose();
  });

  it('V7: an explicit executablePath that is missing does not trigger discovery either', async () => {
    const root = mkdtempSync(join(scratch, 'explicit-'));
    const marker = join(root, 'marker');
    if (real !== undefined) installLauncher(root, 999_995, recording(marker));
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = root;
    const driver = await createDriverFactory({ executablePath: '/nonexistent/explicit-chrome' }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    const check = await driver.selfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/^could not launch chromium: .*\/nonexistent\/explicit-chrome/);
    expect(existsSync(marker)).toBe(false);
    await driver.dispose();
  });

  // Only meaningful where no Chromium is installed at all (a fresh CI image). With one present, discovery always finds it.
  it.skipIf(real !== undefined)('V7: with no Chromium anywhere the error says how to point ai-bdd at one', async () => {
    const driver = await playwright().create({ projectRoot: '.', policy, artifactsDir: scratch });
    const err = await open(driver).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'Chromium is not installed. Set PLAYWRIGHT_BROWSERS_PATH to a directory containing it or AI_BDD_CHROMIUM_PATH to the executable.',
    });
    expect(await driver.selfCheck()).toEqual({
      ok: false,
      problems: ['Chromium is not installed. Set PLAYWRIGHT_BROWSERS_PATH to a directory containing it or AI_BDD_CHROMIUM_PATH to the executable.'],
    });
    await driver.dispose();
  });
});
