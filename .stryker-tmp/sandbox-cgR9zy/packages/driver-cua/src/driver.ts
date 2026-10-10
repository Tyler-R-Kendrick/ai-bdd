// @ts-nocheck
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Driver, DriverContext, DriverFactory, DriverSession, Policy, SessionOptions } from '@ai-bdd/sdk/contracts';
import { checkNavigation } from '@ai-bdd/sdk';
import { DEFAULT_CUA_LAUNCH, McpStdioCuaClient, desktopEnv } from './client.ts';
import type { CuaClient, CuaLaunch } from './client.ts';
import { parseElements } from './nodes.ts';
import { CuaSession, DEFAULT_TITLE_SUFFIX, DRIVER_ID, DRIVER_VERSION, capabilitiesFor } from './session.ts';
import type { Delivery, SessionConfig, WindowRef } from './session.ts';

export interface CuaAppLaunch {
  /** Executable of the application under test. */
  command: string;
  /** Arguments. `{url}` becomes the session's `baseURL` and `{profile}` a fresh throw-away directory per session. */
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CuaWindowMatch {
  /** Regular expression (source) matched against the window title. */
  title?: string;
  /** Regular expression (source) matched against the application name the driver reports. */
  app?: string;
}

export interface CuaOptions {
  /**
   * `browser`: a browser window (adds `navigate` and `back`, observes the page content only). `app`: any native
   * application. Default `app`.
   */
  kind?: 'browser' | 'app';
  /** Launch the application once per session (each session gets its own process and profile). Without it, `window` selects an already running window. */
  launch?: CuaAppLaunch;
  /** Which window to drive. With `launch` it narrows the windows of the launched process; without it it selects the running window. */
  window?: CuaWindowMatch;
  /** `content`: only the web content of a browser window; `window`: the whole window. Default `content` for `browser`, else `window`. */
  scope?: 'content' | 'window';
  /** `auto` (default): background input first, the foreground once the app refuses it. `background`, `foreground`: always. */
  delivery?: Delivery;
  /** How to start Cua Driver. Default `cua-driver mcp`. */
  cuaDriver?: { command?: string; args?: string[]; env?: Record<string, string> };
  /** Regular expression (source) removed from the end of the window title to form the route. Defaults to the common browser names. */
  titleSuffix?: string;
  /** Time to wait for the application's window to appear. Default 20000. */
  startTimeoutMs?: number;
  /** Time budget of one accessibility-tree walk. Default 3000. */
  treeTimeoutMs?: number;
  /** Time budget of one input action. Default 10000. */
  actionTimeoutMs?: number;
  /** Pause after an input action. Default 100. */
  settleMs?: number;
  /** Sessions allowed at once. Default 1: real input is global to the desktop. */
  maxSessions?: number;
  /** Programmatic only: connect to Cua Driver yourself (tests, embedding). */
  connect?: () => Promise<CuaClient>;
}

const REQUIRED_TOOLS = ['list_windows', 'get_window_state', 'click', 'type_text', 'press_key', 'scroll'];
const INSTALL_HINT = 'Install Cua Driver: https://cua.ai/docs/cua-driver/quickstart';

function windowRecords(structured: Record<string, unknown>): { pid: number; windowId: number; title: string; app: string; z: number; onScreen: boolean }[] {
  const rows = structured['windows'];
  if (!Array.isArray(rows)) return [];
  const out: { pid: number; windowId: number; title: string; app: string; z: number; onScreen: boolean }[] = [];
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['pid'] !== 'number' || typeof r['window_id'] !== 'number') continue;
    out.push({
      pid: r['pid'], windowId: r['window_id'],
      title: typeof r['title'] === 'string' ? r['title'] : '',
      app: typeof r['app_name'] === 'string' ? r['app_name'] : '',
      z: typeof r['z_index'] === 'number' ? r['z_index'] : -1,
      onScreen: r['is_on_screen'] !== false,
    });
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Launched { child: ChildProcess; profileDir: string; exit: Promise<number | null> }

class CuaDriver implements Driver {
  readonly id = DRIVER_ID;
  readonly version = DRIVER_VERSION;
  readonly capabilities;
  private client: Promise<CuaClient> | undefined;
  private readonly sessions = new Set<CuaSession>();
  private disposed = false;
  private readonly opts: CuaOptions;
  private readonly ctx: DriverContext;
  private readonly cfg: SessionConfig;
  private readonly titleMatch: RegExp | undefined;
  private readonly appMatch: RegExp | undefined;

  constructor(opts: CuaOptions, ctx: DriverContext) {
    this.opts = opts;
    this.ctx = ctx;
    const kind = opts.kind ?? 'app';
    this.capabilities = capabilitiesFor(kind, opts.maxSessions ?? 1);
    this.cfg = {
      kind,
      scope: opts.scope ?? (kind === 'browser' ? 'content' : 'window'),
      delivery: opts.delivery ?? 'auto',
      treeTimeoutMs: opts.treeTimeoutMs ?? 3000,
      actionTimeoutMs: opts.actionTimeoutMs ?? 10_000,
      settleMs: opts.settleMs ?? 100,
      titleSuffix: opts.titleSuffix === undefined ? (kind === 'browser' ? DEFAULT_TITLE_SUFFIX : undefined) : new RegExp(opts.titleSuffix),
    };
    this.titleMatch = opts.window?.title === undefined ? undefined : new RegExp(opts.window.title);
    this.appMatch = opts.window?.app === undefined ? undefined : new RegExp(opts.window.app);
  }

  private getClient(): Promise<CuaClient> {
    if (this.disposed) return Promise.reject(new AiBddError('DRIVER_UNAVAILABLE', 'driver is disposed'));
    if (this.client === undefined) {
      const launch: CuaLaunch = {
        command: this.opts.cuaDriver?.command ?? DEFAULT_CUA_LAUNCH.command,
        args: this.opts.cuaDriver?.args ?? DEFAULT_CUA_LAUNCH.args,
        env: this.opts.cuaDriver?.env ?? DEFAULT_CUA_LAUNCH.env,
      };
      const p = this.opts.connect === undefined ? McpStdioCuaClient.connect(launch) : this.opts.connect();
      this.client = p;
      p.catch(() => {
        if (this.client === p) this.client = undefined; // allow a retry after a failed start
      });
    }
    return this.client;
  }

  private matches(w: { title: string; app: string }): boolean {
    return (this.titleMatch === undefined || this.titleMatch.test(w.title)) && (this.appMatch === undefined || this.appMatch.test(w.app));
  }

  private async findWindow(client: CuaClient, pid: number | undefined, exited: () => number | null | undefined): Promise<WindowRef> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 20_000);
    let lastSeen = 0;
    for (;;) {
      const res = await client.callTool('list_windows', pid === undefined ? {} : { pid });
      if (res.failed) throw new AiBddError('DRIVER_ERROR', `list_windows: ${res.text.split('\n')[0] ?? 'failed'}`);
      const candidates = windowRecords(res.structured).filter((w) => (pid === undefined || w.pid === pid) && this.matches(w));
      lastSeen = windowRecords(res.structured).length;
      const best = candidates.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || b.z - a.z)[0];
      if (best !== undefined) return { pid: best.pid, windowId: best.windowId };
      const code = exited();
      if (code !== undefined) throw new AiBddError('DRIVER_UNAVAILABLE', `the application exited (code ${String(code)}) before it showed a window`);
      if (Date.now() > deadline) {
        const what = pid === undefined ? `no running window matches ${JSON.stringify(this.opts.window ?? {})}` : `the launched application (pid ${pid}) showed no window${this.opts.window === undefined ? '' : ` matching ${JSON.stringify(this.opts.window)}`}`;
        throw new AiBddError('DRIVER_UNAVAILABLE', `${what} within ${this.opts.startTimeoutMs ?? 20_000} ms (${lastSeen} window(s) visible to Cua Driver; is a display, a window manager and the accessibility bus running?)`);
      }
      await sleep(150);
    }
  }

  /** Wait until the window exposes accessible content, so the first observation is not an empty shell. */
  private async awaitContent(client: CuaClient, win: WindowRef): Promise<void> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const res = await client.callTool('get_window_state', { pid: win.pid, window_id: win.windowId, include_screenshot: false, timeout_ms: this.cfg.treeTimeoutMs }, { timeoutMs: this.cfg.treeTimeoutMs + 15_000 });
      if (!res.failed) {
        const elements = parseElements(res.structured);
        const ready = this.cfg.scope === 'content' ? elements.some((e) => e.in_web_content === true) : elements.length > 1;
        if (ready) return;
      }
      await sleep(200);
    }
  }

  private async launchApp(launch: CuaAppLaunch, baseURL: string | undefined, policy: Policy): Promise<Launched> {
    const profileDir = await mkdtemp(join(tmpdir(), 'ai-bdd-cua-'));
    const cleanup = (): Promise<void> => rm(profileDir, { recursive: true, force: true });
    const needsUrl = (launch.args ?? []).some((a) => a.includes('{url}'));
    let url = '';
    if (needsUrl) {
      if (baseURL === undefined) {
        await cleanup();
        throw new AiBddError('CONFIG_INVALID', 'driver-cua: launch.args uses {url} but there is no baseURL (set baseURL in the config)');
      }
      const verdict = checkNavigation(baseURL, undefined, policy);
      if (!verdict.ok) {
        await cleanup();
        throw new AiBddError('POLICY_DENIED', `start URL ${JSON.stringify(baseURL)} denied: ${verdict.reason}`, { details: { url: baseURL, reason: verdict.reason } });
      }
      url = verdict.url;
    }
    const args = (launch.args ?? []).map((a) => a.split('{url}').join(url).split('{profile}').join(profileDir));
    const child = spawn(launch.command, args, {
      env: { ...desktopEnv(), ...launch.env },
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      stdio: 'ignore',
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    const spawnError = await new Promise<Error | undefined>((resolve) => {
      child.once('error', (err) => resolve(err));
      child.once('spawn', () => resolve(undefined));
    });
    if (spawnError !== undefined) {
      await cleanup();
      throw new AiBddError('DRIVER_UNAVAILABLE', `cannot start ${JSON.stringify(launch.command)}: ${spawnError.message}`, { cause: spawnError });
    }
    return { child, profileDir, exit };
  }

  private async stopApp(app: Launched): Promise<void> {
    if (app.child.exitCode === null && app.child.signalCode === null) {
      app.child.kill('SIGTERM');
      const gone = await Promise.race([app.exit.then(() => true), sleep(3000).then(() => false)]);
      if (!gone) {
        app.child.kill('SIGKILL');
        await Promise.race([app.exit, sleep(2000)]);
      }
    }
    await rm(app.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async openSession(opts: SessionOptions): Promise<DriverSession> {
    const client = await this.getClient();
    if (this.opts.launch === undefined && this.opts.window === undefined) {
      throw new AiBddError('CONFIG_INVALID', 'driver-cua: set "launch" (start the app per session) or "window" (drive a running window)');
    }
    const policy: Policy = opts.policy ?? this.ctx.policy;
    const baseURL = opts.baseURL ?? this.ctx.baseURL;
    let app: Launched | undefined;
    try {
      let exitCode: number | null | undefined;
      if (this.opts.launch !== undefined) {
        app = await this.launchApp(this.opts.launch, baseURL, policy);
        void app.exit.then((c) => {
          exitCode = c;
        });
      }
      const win = await this.findWindow(client, app?.child.pid, () => exitCode);
      await this.awaitContent(client, win);
      const launched = app;
      const session = new CuaSession(
        client, win, { ...opts, policy }, { policy, ...(baseURL === undefined ? {} : { baseURL }) },
        this.cfg, this.capabilities,
        async () => {
          this.sessions.delete(session);
          if (launched !== undefined) await this.stopApp(launched);
        },
      );
      this.sessions.add(session);
      return session;
    } catch (err) {
      if (app !== undefined) await this.stopApp(app);
      throw err instanceof AiBddError ? err : new AiBddError('DRIVER_ERROR', `could not open a session: ${(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? ''}`, { cause: err });
    }
  }

  async selfCheck(): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    let client: CuaClient;
    try {
      client = await this.getClient();
    } catch (err) {
      return { ok: false, problems: [`${err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)}. ${INSTALL_HINT}`] };
    }
    const missing = REQUIRED_TOOLS.filter((t) => !client.tools.has(t));
    if (missing.length > 0) problems.push(`Cua Driver does not serve ${missing.join(', ')}; update it (${INSTALL_HINT})`);
    if (client.tools.has('health_report')) {
      try {
        const res = await client.callTool('health_report', {});
        const checks = Array.isArray(res.structured['checks']) ? (res.structured['checks'] as unknown[]) : [];
        for (const c of checks) {
          if (typeof c !== 'object' || c === null) continue;
          const row = c as Record<string, unknown>;
          if (row['status'] === 'fail') problems.push(`${String(row['name'])}: ${String(row['message'] ?? 'failed')}`);
        }
        if (problems.length === 0 && res.structured['overall'] !== undefined && res.structured['overall'] !== 'ok') {
          problems.push(`health_report overall: ${String(res.structured['overall'])}`);
        }
      } catch (err) {
        problems.push(`health_report failed: ${err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)}`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.sessions].map((s) => s.close().catch(() => undefined)));
    const c = this.client;
    this.client = undefined;
    if (c !== undefined) await (await c.catch(() => undefined))?.close().catch(() => undefined);
  }
}

export function cua(opts: CuaOptions = {}): DriverFactory {
  return {
    id: DRIVER_ID,
    async create(ctx: DriverContext): Promise<Driver> {
      return new CuaDriver(opts, ctx);
    },
  };
}

const bad = (msg: string): never => {
  throw new AiBddError('CONFIG_INVALID', `driver-cua: ${msg}`);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`"${what}" must be an array of strings`);
  return v as string[];
}
function stringMap(v: unknown, what: string): Record<string, string> {
  if (!isRecord(v) || Object.values(v).some((x) => typeof x !== 'string')) bad(`"${what}" must be an object of strings`);
  return v as Record<string, string>;
}
function regex(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) bad(`"${what}" must be a non-empty regular expression string`);
  try {
    new RegExp(v as string);
  } catch (err) {
    bad(`"${what}" is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return v as string;
}
function noExtra(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`unknown option "${where}${k}"`);
}
function positive(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) bad(`"${what}" must be a positive number`);
  return v as number;
}

/** Build a factory from JSON-compatible configuration (`{ use: '@ai-bdd/driver-cua', options }`). Unknown keys are rejected. */
export function createDriverFactory(options: Record<string, unknown> = {}): DriverFactory {
  noExtra(options, ['kind', 'launch', 'window', 'scope', 'delivery', 'cuaDriver', 'titleSuffix', 'startTimeoutMs', 'treeTimeoutMs', 'actionTimeoutMs', 'settleMs', 'maxSessions'], '');
  const out: CuaOptions = {};
  for (const [k, v] of Object.entries(options)) {
    switch (k) {
      case 'kind':
        if (v !== 'browser' && v !== 'app') bad('"kind" must be "browser" or "app"');
        out.kind = v as 'browser' | 'app';
        break;
      case 'scope':
        if (v !== 'content' && v !== 'window') bad('"scope" must be "content" or "window"');
        out.scope = v as 'content' | 'window';
        break;
      case 'delivery':
        if (v !== 'auto' && v !== 'background' && v !== 'foreground') bad('"delivery" must be "auto", "background" or "foreground"');
        out.delivery = v as Delivery;
        break;
      case 'launch': {
        if (!isRecord(v)) return bad('"launch" must be an object { command, args?, env?, cwd? }');
        noExtra(v, ['command', 'args', 'env', 'cwd'], 'launch.');
        if (typeof v['command'] !== 'string' || v['command'].length === 0) bad('"launch.command" must be a non-empty string');
        const launch: CuaAppLaunch = { command: v['command'] as string };
        if (v['args'] !== undefined) launch.args = strings(v['args'], 'launch.args');
        if (v['env'] !== undefined) launch.env = stringMap(v['env'], 'launch.env');
        if (v['cwd'] !== undefined) {
          if (typeof v['cwd'] !== 'string') bad('"launch.cwd" must be a string');
          launch.cwd = v['cwd'] as string;
        }
        out.launch = launch;
        break;
      }
      case 'window': {
        if (!isRecord(v)) return bad('"window" must be an object { title?, app? }');
        noExtra(v, ['title', 'app'], 'window.');
        const win: CuaWindowMatch = {};
        if (v['title'] !== undefined) win.title = regex(v['title'], 'window.title');
        if (v['app'] !== undefined) win.app = regex(v['app'], 'window.app');
        if (win.title === undefined && win.app === undefined) bad('"window" needs "title" or "app"');
        out.window = win;
        break;
      }
      case 'cuaDriver': {
        if (!isRecord(v)) return bad('"cuaDriver" must be an object { command?, args?, env? }');
        noExtra(v, ['command', 'args', 'env'], 'cuaDriver.');
        const d: NonNullable<CuaOptions['cuaDriver']> = {};
        if (v['command'] !== undefined) {
          if (typeof v['command'] !== 'string' || v['command'].length === 0) bad('"cuaDriver.command" must be a non-empty string');
          d.command = v['command'] as string;
        }
        if (v['args'] !== undefined) d.args = strings(v['args'], 'cuaDriver.args');
        if (v['env'] !== undefined) d.env = stringMap(v['env'], 'cuaDriver.env');
        out.cuaDriver = d;
        break;
      }
      case 'titleSuffix':
        out.titleSuffix = regex(v, 'titleSuffix');
        break;
      case 'startTimeoutMs':
      case 'treeTimeoutMs':
      case 'actionTimeoutMs':
        out[k] = positive(v, k);
        break;
      case 'settleMs':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad('"settleMs" must be a number >= 0');
        out.settleMs = v as number;
        break;
      case 'maxSessions':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) bad('"maxSessions" must be an integer >= 1');
        out.maxSessions = v as number;
        break;
      default:
        bad(`unknown option "${k}"`);
    }
  }
  if (out.launch === undefined && out.window === undefined) bad('set "launch" (start the app per session) or "window" (drive a running window)');
  return cua(out);
}
