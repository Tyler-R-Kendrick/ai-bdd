import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Policy } from '@ai-bdd/sdk/contracts';
import { createDriverFactory, discoverChromium, playwright } from '../src/index.ts';

const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const savedEnv = { chromiumPath: process.env['AI_BDD_CHROMIUM_PATH'] };
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ai-bdd-pw-opts-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  if (savedEnv.chromiumPath === undefined) delete process.env['AI_BDD_CHROMIUM_PATH'];
  else process.env['AI_BDD_CHROMIUM_PATH'] = savedEnv.chromiumPath;
});

function touchExecutable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}
/** A browsers directory with a single (nonsense) revision this high, so that it outranks anything installed on the machine. */
const HIGH_REV = 999_990;
const realChromium = discoverChromium(true);

describe('createDriverFactory option validation', () => {
  const rejected: [string, Record<string, unknown>, string][] = [
    ['an unknown key', { nope: 1 }, 'driver-playwright: unknown option "nope"'],
    ['a browser that is not a string', { browser: 5 }, 'driver-playwright: "browser" must be one of chromium, firefox, webkit'],
    ['an unsupported browser name', { browser: 'ie' }, 'driver-playwright: "browser" must be one of chromium, firefox, webkit'],
    ['a non-boolean headless', { headless: 'yes' }, 'driver-playwright: "headless" must be a boolean'],
    ['a non-boolean recordVideo', { recordVideo: 1 }, 'driver-playwright: "recordVideo" must be a boolean'],
    ['a null viewport', { viewport: null }, 'driver-playwright: "viewport" must be {width, height} integers'],
    ['a primitive viewport', { viewport: 800 }, 'driver-playwright: "viewport" must be {width, height} integers'],
    ['a fractional viewport width', { viewport: { width: 1.5, height: 600 } }, 'driver-playwright: "viewport" must be {width, height} integers'],
    ['a missing viewport height', { viewport: { width: 800 } }, 'driver-playwright: "viewport" must be {width, height} integers'],
    ['a null launchOptions', { launchOptions: null }, 'driver-playwright: "launchOptions" must be an object'],
    ['an array launchOptions', { launchOptions: [] }, 'driver-playwright: "launchOptions" must be an object'],
    ['a string launchOptions', { launchOptions: '--x' }, 'driver-playwright: "launchOptions" must be an object'],
    ['an empty executablePath', { executablePath: '' }, 'driver-playwright: "executablePath" must be a non-empty string'],
    ['a non-string executablePath', { executablePath: 7 }, 'driver-playwright: "executablePath" must be a non-empty string'],
    ['a zero actionTimeoutMs', { actionTimeoutMs: 0 }, 'driver-playwright: "actionTimeoutMs" must be a positive number'],
    ['a negative actionTimeoutMs', { actionTimeoutMs: -5 }, 'driver-playwright: "actionTimeoutMs" must be a positive number'],
    ['a string navigationTimeoutMs', { navigationTimeoutMs: '5' }, 'driver-playwright: "navigationTimeoutMs" must be a positive number'],
    ['a NaN navigationTimeoutMs', { navigationTimeoutMs: Number.NaN }, 'driver-playwright: "navigationTimeoutMs" must be a positive number'],
    ['an infinite actionTimeoutMs', { actionTimeoutMs: Number.POSITIVE_INFINITY }, 'driver-playwright: "actionTimeoutMs" must be a positive number'],
  ];
  it.each(rejected)('R-SDK2: %s is rejected with CONFIG_INVALID and a message naming the option', (_label, options, message) => {
    let thrown: unknown;
    try {
      createDriverFactory(options);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AiBddError);
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', message });
  });

  it('R-SDK2: every valid option is accepted together and yields a playwright factory; no options is valid too', () => {
    const f = createDriverFactory({
      browser: 'webkit', headless: false, recordVideo: true, viewport: { width: 640, height: 480 },
      launchOptions: { args: ['--no-sandbox'] }, executablePath: '/somewhere/chrome', actionTimeoutMs: 250, navigationTimeoutMs: 2500,
    });
    expect(f.id).toBe('playwright');
    expect(createDriverFactory().id).toBe('playwright');
  });

  it('R-SDK2: executablePath is merged into launchOptions (in either key order) and is the executable that gets launched', async () => {
    for (const options of [
      { executablePath: '/nonexistent/from-option/chrome' },
      { launchOptions: { args: [] }, executablePath: '/nonexistent/from-option/chrome' },
      { executablePath: '/nonexistent/from-option/chrome', launchOptions: { executablePath: '/nonexistent/from-option/chrome' } },
    ]) {
      const driver = await createDriverFactory(options).create({ projectRoot: '.', policy, artifactsDir: scratch });
      const check = await driver.selfCheck();
      expect(check.ok).toBe(false);
      expect(check.problems).toHaveLength(1);
      expect(check.problems[0]).toMatch(/^could not launch chromium: .*\/nonexistent\/from-option\/chrome/);
      await driver.dispose();
    }
  });
});

describe('browser launch failures', () => {
  it('V7: a browser that cannot be launched fails with DRIVER_UNAVAILABLE naming the browser, and selfCheck reports the same first line', async () => {
    for (const browser of ['firefox', 'webkit', 'chromium'] as const) {
      const driver = await playwright({ browser, launchOptions: { executablePath: `/nonexistent/${browser}` } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
      const err = await driver.openSession({ scenarioId: 's', policy, resolveValue: () => '' }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({ code: 'DRIVER_UNAVAILABLE', retryable: true });
      const message = (err as AiBddError).message;
      expect(message.startsWith(`could not launch ${browser}: `)).toBe(true);
      expect(message).toContain(`/nonexistent/${browser}`);
      expect(message).not.toContain('\n');
      expect(await driver.selfCheck()).toEqual({ ok: false, problems: [expect.stringContaining(`/nonexistent/${browser}`)] });
      await driver.dispose();
    }
  });

  it('V7: AI_BDD_CHROMIUM_PATH is used for chromium only: a bad value fails chromium and is ignored for firefox', async () => {
    process.env['AI_BDD_CHROMIUM_PATH'] = '/nonexistent/env/chrome';
    const chromiumDriver = await playwright().create({ projectRoot: '.', policy, artifactsDir: scratch });
    const check = await chromiumDriver.selfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/^could not launch chromium: .*\/nonexistent\/env\/chrome/);
    await chromiumDriver.dispose();

    const firefoxDriver = await playwright({ browser: 'firefox', launchOptions: { executablePath: '/nonexistent/ff' } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    const ff = await firefoxDriver.selfCheck();
    expect(ff.problems[0]).toMatch(/^could not launch firefox: .*\/nonexistent\/ff/);
    expect(ff.problems[0]).not.toContain('/nonexistent/env/chrome');
    await firefoxDriver.dispose();
  });

  it('V7: an explicit executablePath wins over AI_BDD_CHROMIUM_PATH', async () => {
    process.env['AI_BDD_CHROMIUM_PATH'] = '/nonexistent/env/chrome';
    const driver = await playwright({ launchOptions: { executablePath: '/nonexistent/explicit/chrome' } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    const check = await driver.selfCheck();
    expect(check.problems[0]).toContain('/nonexistent/explicit/chrome');
    expect(check.problems[0]).not.toContain('/nonexistent/env/chrome');
    await driver.dispose();
  });

  it('V7: an empty AI_BDD_CHROMIUM_PATH counts as unset', async () => {
    process.env['AI_BDD_CHROMIUM_PATH'] = '';
    const driver = await playwright({ launchOptions: { executablePath: '/nonexistent/explicit/chrome' } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    expect((await driver.selfCheck()).problems[0]).toContain('/nonexistent/explicit/chrome');
    await driver.dispose();
  });

  it('V7: an executable that exits at once is a launch failure, not a hang', async () => {
    const exe = touchExecutable(join(scratch, 'dies', 'chrome'));
    const driver = await playwright({ launchOptions: { executablePath: exe } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    await expect(driver.openSession({ scenarioId: 's', policy, resolveValue: () => '' })).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    await driver.dispose();
  });

  it('V7: after dispose(), openSession fails with DRIVER_UNAVAILABLE "driver is disposed" without launching anything; dispose is idempotent', async () => {
    const driver = await playwright({ launchOptions: { executablePath: '/nonexistent/chrome' } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    await driver.dispose();
    await expect(driver.openSession({ scenarioId: 's', policy, resolveValue: () => '' })).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'driver is disposed' });
    expect(await driver.selfCheck()).toEqual({ ok: false, problems: ['driver is disposed'] });
    await expect(driver.dispose()).resolves.toBeUndefined();
  });

  it.skipIf(realChromium === undefined)('V7: a malformed policy that breaks session setup is reported as DRIVER_ERROR "could not open a session"', async () => {
    const real = realChromium as string;
    const driver = await playwright({ launchOptions: { executablePath: real } }).create({ projectRoot: '.', policy, artifactsDir: scratch });
    const broken = { denyVerbs: [] } as unknown as Policy; // allowHosts missing, as a JS config could produce
    const err = await driver.openSession({ scenarioId: 's', policy: broken, resolveValue: () => '' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect(err).toMatchObject({ code: 'DRIVER_ERROR' });
    expect((err as AiBddError).message.startsWith('could not open a session: ')).toBe(true);
    await driver.dispose();
  });
});

describe('discoverChromium', () => {
  const baseline = discoverChromium(true, { PLAYWRIGHT_BROWSERS_PATH: undefined });
  const rooted = (root: string): Record<string, string> => ({ PLAYWRIGHT_BROWSERS_PATH: root });

  it('R-SDK2: ignores unset, empty and "0" browser paths and roots that do not exist', () => {
    expect(discoverChromium(true, { PLAYWRIGHT_BROWSERS_PATH: '' })).toBe(baseline);
    expect(discoverChromium(true, { PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(baseline);
    expect(discoverChromium(true, rooted(join(scratch, 'does-not-exist')))).toBe(baseline);
    expect(discoverChromium(false, rooted(join(scratch, 'does-not-exist')))).toBe(baseline);
  });

  it('R-SDK2: finds chrome-linux/chrome and chrome-linux64/chrome of a full Chromium and prefers the higher revision', () => {
    const root = join(scratch, 'full');
    const low = touchExecutable(join(root, `chromium-${HIGH_REV}`, 'chrome-linux', 'chrome'));
    expect(discoverChromium(true, rooted(root))).toBe(low);
    const high = touchExecutable(join(root, `chromium-${HIGH_REV + 5}`, 'chrome-linux64', 'chrome'));
    expect(discoverChromium(true, rooted(root))).toBe(high);
    // The revision is compared as a number, not as a string.
    touchExecutable(join(root, `chromium-${HIGH_REV + 5 - 4}`, 'chrome-linux', 'chrome'));
    expect(discoverChromium(true, rooted(root))).toBe(high);
  });

  it('R-SDK2: entries that are not chromium revisions, or have no executable, are ignored', () => {
    const root = join(scratch, 'noise');
    mkdirSync(join(root, `chromium-${HIGH_REV + 50}`), { recursive: true }); // no executable inside
    touchExecutable(join(root, `chromium-abc`, 'chrome-linux', 'chrome'));
    touchExecutable(join(root, `chromium-${HIGH_REV + 50}-extra`, 'chrome-linux', 'chrome'));
    touchExecutable(join(root, `firefox-${HIGH_REV + 50}`, 'chrome-linux', 'chrome'));
    touchExecutable(join(root, `chromium-${HIGH_REV + 50}x`, 'chrome-linux64', 'chrome'));
    touchExecutable(join(root, `chromium-${HIGH_REV + 50}`, 'wrong-dir', 'chrome'));
    writeFileSync(join(root, 'chromium-1000000'), 'a file, not a directory');
    expect(discoverChromium(true, rooted(root))).toBe(baseline);
  });

  it('R-SDK2: a full Chromium is preferred over a headless shell of a higher revision', () => {
    const root = join(scratch, 'prefer-full');
    const shell = touchExecutable(join(root, `chromium_headless_shell-${HIGH_REV + 10}`, 'chrome-linux', 'headless_shell'));
    const full = touchExecutable(join(root, `chromium-${HIGH_REV}`, 'chrome-linux', 'chrome'));
    expect(discoverChromium(true, rooted(root))).toBe(full);
    expect(discoverChromium(false, rooted(root))).toBe(full);
    expect(full).not.toBe(shell);
  });

  it('R-SDK2: a headless shell (either layout) is used when no full Chromium is installed anywhere', () => {
    const root = join(scratch, 'shell-only');
    const a = touchExecutable(join(root, `chromium_headless_shell-${HIGH_REV}`, 'chrome-linux', 'headless_shell'));
    const b = touchExecutable(join(root, `chromium_headless_shell-${HIGH_REV + 1}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    const found = discoverChromium(true, rooted(root));
    if (baseline !== undefined && !/headless/.test(baseline)) {
      // The machine has a full Chromium, which outranks any shell: the shell layouts are exercised but cannot win.
      expect(found).toBe(baseline);
    } else {
      expect(found).toBe(b);
      rmSync(join(root, `chromium_headless_shell-${HIGH_REV + 1}`), { recursive: true });
      expect(discoverChromium(true, rooted(root))).toBe(a);
    }
  });
});
