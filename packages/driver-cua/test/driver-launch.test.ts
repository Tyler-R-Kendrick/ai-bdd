import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { cua } from '../src/index.ts';
import type { CuaOptions } from '../src/index.ts';
import { PAGE, ScriptedClient, okResult, snapshot } from './scripted.ts';
import type { Handler } from './scripted.ts';

const APP = fileURLToPath(new URL('./fake-app.mjs', import.meta.url));
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({
  scenarioId: 's', baseURL: 'http://localhost:4000', policy,
  resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : ''), ...over,
});

/** The scripted desktop: one window per queried pid, showing PAGE. */
const appDesktop: Handler = (tool, args) => {
  if (tool === 'list_windows') return okResult({ windows: [{ app_name: 'FakeApp', pid: args['pid'] ?? 600, window_id: 7, title: 'Fake window', z_index: 0, is_on_screen: true }] });
  if (tool === 'get_window_state') return snapshot(PAGE);
  return undefined;
};

let tmpRoot: string;
let savedTmpdir: string | undefined;
const drivers: Driver[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), 'ai-bdd-cua-test-'));
  savedTmpdir = process.env['TMPDIR'];
  process.env['TMPDIR'] = tmpRoot; // every profile directory the driver creates lands here
});
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.dispose();
  if (savedTmpdir === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmpdir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const profiles = (): string[] => readdirSync(tmpRoot).filter((n) => n.startsWith('ai-bdd-cua-'));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
interface Report { pid: number; argv: string[]; cwd: string; env: Record<string, string> }
async function reportOf(file: string): Promise<Report> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 10_000, interval: 25 });
  await vi.waitFor(() => expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow(), { timeout: 10_000, interval: 25 });
  return JSON.parse(readFileSync(file, 'utf8')) as Report;
}
async function driverFor(o: CuaOptions, handler: Handler = appDesktop, baseURL: string | null = 'http://localhost:4000'): Promise<{ driver: Driver; client: ScriptedClient }> {
  const client = new ScriptedClient(handler);
  const driver = await cua({ settleMs: 0, startTimeoutMs: 5000, connect: async () => client, ...o })
    .create({ projectRoot: '.', policy, artifactsDir: '.', ...(baseURL === null ? {} : { baseURL }) });
  drivers.push(driver);
  return { driver, client };
}

describe('launching the application', () => {
  it('substitutes {url} and {profile} in every argument, applies cwd and env, and keeps provider keys out of the app', async () => {
    const report = join(tmpRoot, 'report.json');
    const cwd = join(tmpRoot, 'work');
    mkdirSync(cwd);
    process.env['OPENAI_API_KEY'] = 'sk-must-not-reach-the-app';
    try {
      const { driver } = await driverFor({
        launch: { command: process.execPath, args: [APP, '--url={url}', '--profile={profile}', '--both={url}|{profile}|{url}', 'plain'], env: { FAKE_APP_REPORT: report, APP_FLAG: 'yes' }, cwd },
      });
      const session = await driver.openSession(opts());
      const seen = await reportOf(report);
      const dirs = profiles();
      expect(dirs).toHaveLength(1);
      const profile = join(tmpRoot, dirs[0] as string);
      expect(existsSync(profile)).toBe(true);
      expect(seen.argv).toEqual(['--url=http://localhost:4000/', `--profile=${profile}`, `--both=http://localhost:4000/|${profile}|http://localhost:4000/`, 'plain']);
      expect(realpathSync(seen.cwd)).toBe(realpathSync(cwd));
      expect(seen.env['APP_FLAG']).toBe('yes');
      expect(seen.env['PATH']).toBe(process.env['PATH']);
      expect(seen.env['OPENAI_API_KEY']).toBeUndefined();
      await session.close();
      expect(alive(seen.pid)).toBe(false);
      expect(profiles()).toEqual([]);
    } finally {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('gives every session its own process and profile directory, and removes them as the sessions close', async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver } = await driverFor({ launch: { command: process.execPath, args: [APP, '{profile}'], env: { FAKE_APP_REPORT: report } }, maxSessions: 2 });
    const a = await driver.openSession(opts());
    const first = await reportOf(report);
    rmSync(report);
    const b = await driver.openSession(opts());
    const second = await reportOf(report);
    expect(second.pid).not.toBe(first.pid);
    expect(second.argv[0]).not.toBe(first.argv[0]);
    expect(profiles()).toHaveLength(2);
    await a.close();
    expect(alive(first.pid)).toBe(false);
    expect(alive(second.pid)).toBe(true);
    expect(profiles()).toHaveLength(1);
    await b.close();
    expect(alive(second.pid)).toBe(false);
    expect(profiles()).toEqual([]);
  });

  it('a launch without {url} needs no baseURL, and arguments are passed through untouched', async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver } = await driverFor({ launch: { command: process.execPath, args: [APP, '--flag', 'a b'], env: { FAKE_APP_REPORT: report } } }, appDesktop, null);
    const { baseURL: _drop, ...noBase } = opts();
    const session = await driver.openSession(noBase);
    expect((await reportOf(report)).argv).toEqual(['--flag', 'a b']);
    await session.close();
  });

  it('SIGTERM stops a well-behaved application', async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver } = await driverFor({ launch: { command: process.execPath, args: [APP], env: { FAKE_APP_REPORT: report } } });
    const session = await driver.openSession(opts());
    const seen = await reportOf(report);
    await session.close();
    expect(alive(seen.pid)).toBe(false);
    expect(readFileSync(`${report}.term`, 'utf8')).toBe('term\n');
  });

  it('an application that ignores SIGTERM is killed with SIGKILL after the grace period', { timeout: 30_000 }, async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver } = await driverFor({ launch: { command: process.execPath, args: [APP, '--ignore-term'], env: { FAKE_APP_REPORT: report } } });
    const session = await driver.openSession(opts());
    const seen = await reportOf(report);
    expect(alive(seen.pid)).toBe(true);
    await session.close();
    expect(alive(seen.pid)).toBe(false);
    expect(readFileSync(`${report}.term`, 'utf8')).toBe('term\n'); // it was asked nicely first
    expect(profiles()).toEqual([]);
  });

  it('closing after the application has already gone just removes the profile', async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver } = await driverFor({ launch: { command: process.execPath, args: [APP, '{profile}'], env: { FAKE_APP_REPORT: report } } });
    const session = await driver.openSession(opts());
    const seen = await reportOf(report);
    process.kill(seen.pid, 'SIGKILL');
    await vi.waitFor(() => expect(alive(seen.pid)).toBe(false), { timeout: 10_000, interval: 25 });
    expect(profiles()).toHaveLength(1);
    await session.close();
    expect(profiles()).toEqual([]);
  });

  it('dispose() stops applications of sessions that are still open', async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver, client } = await driverFor({ launch: { command: process.execPath, args: [APP], env: { FAKE_APP_REPORT: report } } });
    await driver.openSession(opts());
    const seen = await reportOf(report);
    await driver.dispose();
    expect(alive(seen.pid)).toBe(false);
    expect(profiles()).toEqual([]);
    expect(client.closed).toBe(true);
  });
});

describe('a launch that cannot become a session leaves nothing behind', () => {
  it('an executable that does not exist', async () => {
    const { driver } = await driverFor({ launch: { command: '/definitely/not/an/app', args: ['{profile}'] } });
    const err = await driver.openSession(opts()).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'cannot start "/definitely/not/an/app": spawn /definitely/not/an/app ENOENT' });
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(profiles()).toEqual([]);
  });

  it('{url} without a baseURL', async () => {
    const { driver } = await driverFor({ launch: { command: process.execPath, args: ['-e', '0', '{url}'] } }, appDesktop, null);
    const { baseURL: _drop, ...noBase } = opts();
    await expect(driver.openSession(noBase)).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: 'driver-cua: launch.args uses {url} but there is no baseURL (set baseURL in the config)' });
    expect(profiles()).toEqual([]);
  });

  it('a start URL outside the policy', async () => {
    const { driver } = await driverFor({ launch: { command: process.execPath, args: ['-e', '0', '{url}'] } });
    const err = await driver.openSession(opts({ baseURL: 'https://evil.example/' })).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'POLICY_DENIED', details: { url: 'https://evil.example/' } });
    expect((err as Error).message).toContain('start URL "https://evil.example/" denied: ');
    expect(profiles()).toEqual([]);
  });

  it('an application that exits before it shows a window', async () => {
    const { driver } = await driverFor({ launch: { command: process.execPath, args: ['-e', 'process.exit(3)', '{profile}'] } }, (tool) => (tool === 'list_windows' ? okResult({ windows: [] }) : undefined));
    await expect(driver.openSession(opts())).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'the application exited (code 3) before it showed a window' });
    expect(profiles()).toEqual([]);
  });

  it('an application that never shows a window is stopped, with a message that counts what Cua Driver could see', async () => {
    const report = join(tmpRoot, 'r.json');
    const other = { app_name: 'Other', pid: 1, window_id: 1, title: 't', z_index: 0, is_on_screen: true };
    const { driver } = await driverFor(
      { launch: { command: process.execPath, args: [APP, '{profile}'], env: { FAKE_APP_REPORT: report } }, startTimeoutMs: 400, window: { title: 'never matches' } },
      (tool) => (tool === 'list_windows' ? okResult({ windows: [other, other] }) : undefined),
    );
    const err = await driver.openSession(opts()).then(() => undefined, (e: unknown) => e);
    const seen = await reportOf(report);
    expect(err).toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    expect((err as Error).message).toBe(
      `the launched application (pid ${seen.pid}) showed no window matching {"title":"never matches"} within 400 ms (2 window(s) visible to Cua Driver; is a display, a window manager and the accessibility bus running?)`,
    );
    expect(alive(seen.pid)).toBe(false);
    expect(profiles()).toEqual([]);
  });

  it('without a window filter the message names only the pid', async () => {
    const report = join(tmpRoot, 'r.json');
    const { driver } = await driverFor({ launch: { command: process.execPath, args: [APP], env: { FAKE_APP_REPORT: report } }, startTimeoutMs: 300 }, (tool) => (tool === 'list_windows' ? okResult({ windows: [] }) : undefined));
    const err = await driver.openSession(opts()).then(() => undefined, (e: unknown) => e);
    const seen = await reportOf(report);
    expect((err as Error).message).toBe(`the launched application (pid ${seen.pid}) showed no window within 300 ms (0 window(s) visible to Cua Driver; is a display, a window manager and the accessibility bus running?)`);
  });

  it('a Cua Driver call that throws while the window is looked up stops the app and is reported as DRIVER_ERROR', async () => {
    const report = join(tmpRoot, 'r.json');
    const client = new ScriptedClient(appDesktop);
    client.callTool = async (): Promise<never> => {
      await vi.waitFor(() => expect(existsSync(report)).toBe(true), { timeout: 10_000, interval: 25 }); // let the app get going first
      throw new Error('socket hang up\nsecond line');
    };
    const driver = await cua({ launch: { command: process.execPath, args: [APP, '{profile}'], env: { FAKE_APP_REPORT: report } }, connect: async () => client })
      .create({ projectRoot: '.', policy, artifactsDir: '.', baseURL: 'http://localhost:4000' });
    drivers.push(driver);
    const err = await driver.openSession(opts()).then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'DRIVER_ERROR', message: 'could not open a session: socket hang up' });
    const seen = await reportOf(report);
    expect(alive(seen.pid)).toBe(false);
    expect(profiles()).toEqual([]);
  });
});

describe('connecting to Cua Driver', () => {
  it('a failed start is not cached: the next openSession tries again', async () => {
    let attempts = 0;
    const driver = await cua({
      window: { title: 'Fake' }, startTimeoutMs: 300, settleMs: 0,
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first attempt fails');
        return new ScriptedClient(appDesktop);
      },
    }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    drivers.push(driver);
    await expect(driver.openSession(opts())).rejects.toThrow('first attempt fails');
    const session = await driver.openSession(opts());
    expect(attempts).toBe(2);
    await session.close();
  });

  it('after dispose() the driver neither connects nor opens sessions, and disposing twice is harmless', async () => {
    let attempts = 0;
    const driver = await cua({ window: { title: 'Fake' }, connect: async () => { attempts += 1; return new ScriptedClient(appDesktop); } }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    await driver.dispose();
    await driver.dispose();
    await expect(driver.openSession(opts())).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'driver is disposed' });
    expect(await driver.selfCheck()).toMatchObject({ ok: false, problems: [expect.stringContaining('driver is disposed')] });
    expect(attempts).toBe(0);
  });

  it('the configured cuaDriver command, args and env reach the connection (defaults are cua-driver mcp)', async () => {
    const driver = await cua({ window: { title: 'x' }, cuaDriver: { command: '/no/such/cua', args: ['serve', '--flag'], env: { A: 'b' } } }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    drivers.push(driver);
    const check = await driver.selfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toBe('cannot start "/no/such/cua": not found. install Cua Driver (https://cua.ai/docs/cua-driver/quickstart) or set the "cuaDriver.command" option.. Install Cua Driver: https://cua.ai/docs/cua-driver/quickstart');
  });
});

describe('selfCheck', () => {
  const check = async (handler: Handler, tools?: string[]) => {
    const client = new ScriptedClient(handler, tools);
    const driver = await cua({ window: { title: 'x' }, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    drivers.push(driver);
    return driver.selfCheck();
  };

  it('an overall status other than ok is a problem when no check failed; unusable rows are ignored; a failing check without a message says "failed"', async () => {
    expect(await check((t) => (t === 'health_report' ? okResult({ overall: 'degraded', checks: [null, 'x', { name: 'a', status: 'pass' }] }) : undefined)))
      .toEqual({ ok: false, problems: ['health_report overall: degraded'] });
    expect(await check((t) => (t === 'health_report' ? okResult({ overall: 'degraded', checks: [{ name: 'dbus', status: 'fail' }] }) : undefined)))
      .toEqual({ ok: false, problems: ['dbus: failed'] });
    expect(await check((t) => (t === 'health_report' ? okResult({ checks: 'not a list' }) : undefined))).toEqual({ ok: true, problems: [] });
  });

  it('a health_report call that throws is a problem, and missing tools are listed together with the install hint', async () => {
    const throwing = new ScriptedClient(() => undefined);
    throwing.callTool = (): Promise<never> => Promise.reject(new Error('pipe closed\nmore'));
    const driver = await cua({ window: { title: 'x' }, connect: async () => throwing }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    drivers.push(driver);
    expect(await driver.selfCheck()).toEqual({ ok: false, problems: ['health_report failed: pipe closed'] });

    const missing = await check(() => undefined, ['list_windows', 'click', 'health_report']);
    expect(missing.problems[0]).toBe('Cua Driver does not serve get_window_state, type_text, press_key, scroll; update it (Install Cua Driver: https://cua.ai/docs/cua-driver/quickstart)');
    const noHealth = await check(() => undefined, ['list_windows', 'get_window_state', 'click', 'type_text', 'press_key', 'scroll']);
    expect(noHealth).toEqual({ ok: true, problems: [] });
  });
});

describe('createDriverFactory messages', async () => {
  const { createDriverFactory } = await import('../src/index.ts');
  const win = { window: { title: 'x' } };
  const cases: [string, Record<string, unknown>, string][] = [
    ['no launch or window', {}, 'driver-cua: set "launch" (start the app per session) or "window" (drive a running window)'],
    ['an unknown top-level key', { ...win, wat: 1 }, 'driver-cua: unknown option "wat"'],
    ['a non-object launch', { launch: 'chromium' }, 'driver-cua: "launch" must be an object { command, args?, env?, cwd? }'],
    ['an unknown launch key', { launch: { command: 'x', extra: 1 } }, 'driver-cua: unknown option "launch.extra"'],
    ['an empty launch command', { launch: { command: '' } }, 'driver-cua: "launch.command" must be a non-empty string'],
    ['launch args that are not strings', { launch: { command: 'x', args: ['a', 1] } }, 'driver-cua: "launch.args" must be an array of strings'],
    ['launch args that are not an array', { launch: { command: 'x', args: 'a' } }, 'driver-cua: "launch.args" must be an array of strings'],
    ['launch env that is not strings', { launch: { command: 'x', env: { A: 1 } } }, 'driver-cua: "launch.env" must be an object of strings'],
    ['launch env that is an array', { launch: { command: 'x', env: ['A'] } }, 'driver-cua: "launch.env" must be an object of strings'],
    ['a non-string cwd', { launch: { command: 'x', cwd: 5 } }, 'driver-cua: "launch.cwd" must be a string'],
    ['a non-object window', { window: 'x' }, 'driver-cua: "window" must be an object { title?, app? }'],
    ['an unknown window key', { window: { title: 'x', nope: 1 } }, 'driver-cua: unknown option "window.nope"'],
    ['an empty window', { window: {} }, 'driver-cua: "window" needs "title" or "app"'],
    ['an invalid window.title regex', { window: { title: '(' } }, expect.stringMatching(/^driver-cua: "window.title" is not a valid regular expression: /) as unknown as string],
    ['an empty window.app', { window: { app: '' } }, 'driver-cua: "window.app" must be a non-empty regular expression string'],
    ['a non-object cuaDriver', { ...win, cuaDriver: 'x' }, 'driver-cua: "cuaDriver" must be an object { command?, args?, env? }'],
    ['an unknown cuaDriver key', { ...win, cuaDriver: { argz: [] } }, 'driver-cua: unknown option "cuaDriver.argz"'],
    ['an empty cuaDriver.command', { ...win, cuaDriver: { command: '' } }, 'driver-cua: "cuaDriver.command" must be a non-empty string'],
    ['cuaDriver.args that are not strings', { ...win, cuaDriver: { args: [1] } }, 'driver-cua: "cuaDriver.args" must be an array of strings'],
    ['cuaDriver.env that is not strings', { ...win, cuaDriver: { env: { A: 2 } } }, 'driver-cua: "cuaDriver.env" must be an object of strings'],
    ['a bad kind', { ...win, kind: 'phone' }, 'driver-cua: "kind" must be "browser" or "app"'],
    ['a bad scope', { ...win, scope: 'all' }, 'driver-cua: "scope" must be "content" or "window"'],
    ['a bad delivery', { ...win, delivery: 'sometimes' }, 'driver-cua: "delivery" must be "auto", "background" or "foreground"'],
    ['a bad titleSuffix', { ...win, titleSuffix: '[' }, expect.stringMatching(/^driver-cua: "titleSuffix" is not a valid regular expression: /) as unknown as string],
    ['a non-string titleSuffix', { ...win, titleSuffix: 3 }, 'driver-cua: "titleSuffix" must be a non-empty regular expression string'],
    ['a zero startTimeoutMs', { ...win, startTimeoutMs: 0 }, 'driver-cua: "startTimeoutMs" must be a positive number'],
    ['a string treeTimeoutMs', { ...win, treeTimeoutMs: '5' }, 'driver-cua: "treeTimeoutMs" must be a positive number'],
    ['an infinite actionTimeoutMs', { ...win, actionTimeoutMs: Number.POSITIVE_INFINITY }, 'driver-cua: "actionTimeoutMs" must be a positive number'],
    ['a negative settleMs', { ...win, settleMs: -1 }, 'driver-cua: "settleMs" must be a number >= 0'],
    ['a NaN settleMs', { ...win, settleMs: Number.NaN }, 'driver-cua: "settleMs" must be a number >= 0'],
    ['a fractional maxSessions', { ...win, maxSessions: 1.5 }, 'driver-cua: "maxSessions" must be an integer >= 1'],
  ];
  it.each(cases)('%s is rejected with CONFIG_INVALID and an exact message', (_label, options, message) => {
    let thrown: unknown;
    try {
      createDriverFactory(options);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', message });
  });

  it('accepts every option, including settleMs 0 and a launch without args, and applies them', async () => {
    const f = createDriverFactory({
      kind: 'app', scope: 'content', delivery: 'background', titleSuffix: ' - App$', startTimeoutMs: 10, treeTimeoutMs: 20, actionTimeoutMs: 30, settleMs: 0, maxSessions: 3,
      launch: { command: 'x', cwd: '/tmp' }, window: { title: 'a', app: 'b' }, cuaDriver: { command: 'c', args: [], env: {} },
    });
    const driver = await f.create({ projectRoot: '.', policy, artifactsDir: '.' });
    expect(driver.capabilities.maxSessions).toBe(3);
    expect(driver.capabilities.verbs).toEqual(['click', 'fill', 'press', 'check', 'scroll', 'wait']);
  });
});
