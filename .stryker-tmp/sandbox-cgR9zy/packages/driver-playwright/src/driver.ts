// @ts-nocheck
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Driver, DriverContext, DriverFactory, DriverSession, Policy, SessionOptions } from '@ai-bdd/sdk/contracts';
import { chromium, firefox, webkit } from 'playwright-core';
import type { Browser, LaunchOptions, Page } from 'playwright-core';
import { windowOpenGuardScript } from './guard.ts';
import { CAPABILITIES, DRIVER_ID, DRIVER_VERSION, PlaywrightSession } from './session.ts';

export interface PlaywrightOptions {
  browser?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  launchOptions?: LaunchOptions;
  viewport?: { width: number; height: number };
  recordVideo?: boolean;
  /** Per-action timeout (click, fill, ...) in milliseconds. Default 5000. */
  actionTimeoutMs?: number;
  /** Timeout for navigations in milliseconds. Default 15000. */
  navigationTimeoutMs?: number;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * Look for an installed Chromium when the revision Playwright expects is not present (preinstalled browser images
 * often carry another revision). Never downloads anything.
 */
export function discoverChromium(headless: boolean, env: Record<string, string | undefined> = process.env): string | undefined {
  const roots = [env['PLAYWRIGHT_BROWSERS_PATH'], '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright')]
    .filter((r): r is string => typeof r === 'string' && r.length > 0 && r !== '0');
  const found: { rev: number; path: string; shell: boolean }[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const m = /^(chromium|chromium_headless_shell)-(\d+)$/.exec(e);
      if (m === null) continue;
      const shell = m[1] === 'chromium_headless_shell';
      const rev = Number(m[2]);
      const candidates = shell
        ? [join(root, e, 'chrome-linux', 'headless_shell'), join(root, e, 'chrome-headless-shell-linux64', 'chrome-headless-shell')]
        : [join(root, e, 'chrome-linux', 'chrome'), join(root, e, 'chrome-linux64', 'chrome')];
      for (const c of candidates) if (existsSync(c)) found.push({ rev, path: c, shell });
    }
  }
  // Full Chromium runs headless fine, so prefer it; the shell is the fallback (and the preference when it is the only one).
  void headless;
  found.sort((a, b) => Number(a.shell) - Number(b.shell) || b.rev - a.rev);
  return found[0]?.path;
}

async function launchBrowser(opts: PlaywrightOptions): Promise<Browser> {
  const name = opts.browser ?? 'chromium';
  const type = name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium;
  const base: LaunchOptions = { headless: opts.headless ?? true, ...opts.launchOptions };
  const envPath = process.env['AI_BDD_CHROMIUM_PATH'];
  const explicit = base.executablePath ?? (name === 'chromium' && envPath !== undefined && envPath.length > 0 ? envPath : undefined);
  try {
    return await type.launch(explicit === undefined ? base : { ...base, executablePath: explicit });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (explicit === undefined && name === 'chromium' && /Executable doesn't exist/i.test(msg)) {
      const alt = discoverChromium(base.headless ?? true);
      if (alt !== undefined) {
        try {
          return await type.launch({ ...base, executablePath: alt });
        } catch (err2) {
          throw new AiBddError('DRIVER_UNAVAILABLE', `could not launch Chromium at ${alt}: ${(err2 instanceof Error ? err2.message : String(err2)).split('\n')[0] ?? ''}`, { cause: err2 });
        }
      }
      throw new AiBddError('DRIVER_UNAVAILABLE', 'Chromium is not installed. Set PLAYWRIGHT_BROWSERS_PATH to a directory containing it or AI_BDD_CHROMIUM_PATH to the executable.', { cause: err });
    }
    throw new AiBddError('DRIVER_UNAVAILABLE', `could not launch ${name}: ${msg.split('\n')[0] ?? ''}`, { cause: err });
  }
}

class PlaywrightDriver implements Driver {
  readonly id = DRIVER_ID;
  readonly version = DRIVER_VERSION;
  readonly capabilities = CAPABILITIES;
  private browser: Promise<Browser> | undefined;
  private readonly sessions = new Set<PlaywrightSession>();
  private disposed = false;

  private readonly opts: PlaywrightOptions;
  private readonly ctx: DriverContext;

  constructor(opts: PlaywrightOptions, ctx: DriverContext) {
    this.opts = opts;
    this.ctx = ctx;
  }

  private getBrowser(): Promise<Browser> {
    if (this.disposed) return Promise.reject(new AiBddError('DRIVER_UNAVAILABLE', 'driver is disposed'));
    if (this.browser === undefined) {
      const p = launchBrowser(this.opts);
      this.browser = p;
      p.catch(() => {
        if (this.browser === p) this.browser = undefined; // allow a retry after a failed launch
      });
    }
    return this.browser;
  }

  async openSession(opts: SessionOptions): Promise<DriverSession> {
    const browser = await this.getBrowser();
    const record = opts.recordVideo ?? this.opts.recordVideo ?? false;
    const baseURL = opts.baseURL ?? this.ctx.baseURL;
    const context = await browser.newContext({
      viewport: this.opts.viewport ?? DEFAULT_VIEWPORT,
      serviceWorkers: 'block',
      acceptDownloads: false,
      ...(record ? { recordVideo: { dir: join(this.ctx.artifactsDir, 'video') } } : {}),
    });
    try {
      const policy: Policy = opts.policy ?? this.ctx.policy;
      await context.addInitScript(windowOpenGuardScript(policy.allowHosts));
      const page = await context.newPage();
      const session = new PlaywrightSession(page, { ...opts, policy }, { policy, ...(baseURL === undefined ? {} : { baseURL }) }, {
        ownsContext: true,
        ...(this.opts.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: this.opts.actionTimeoutMs }),
        ...(this.opts.navigationTimeoutMs === undefined ? {} : { navigationTimeoutMs: this.opts.navigationTimeoutMs }),
      }, () => this.sessions.delete(session));
      await session.install();
      this.sessions.add(session);
      return session;
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err instanceof AiBddError ? err : new AiBddError('DRIVER_ERROR', `could not open a session: ${(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? ''}`, { cause: err });
    }
  }

  async selfCheck(): Promise<{ ok: boolean; problems: string[] }> {
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext();
      try {
        const page: Page = await context.newPage();
        await page.goto('about:blank');
        return { ok: true, problems: [] };
      } finally {
        await context.close().catch(() => undefined);
      }
    } catch (err) {
      return { ok: false, problems: [err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)] };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.sessions].map((s) => s.close().catch(() => undefined)));
    const b = this.browser;
    this.browser = undefined;
    if (b !== undefined) await (await b.catch(() => undefined))?.close().catch(() => undefined);
  }
}

export function playwright(opts: PlaywrightOptions = {}): DriverFactory {
  return {
    id: DRIVER_ID,
    async create(ctx: DriverContext): Promise<Driver> {
      return new PlaywrightDriver(opts, ctx);
    },
  };
}

const BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

/** Build a factory from JSON-compatible configuration (used by `use: [...]` config entries). Unknown keys are rejected. */
export function createDriverFactory(options: Record<string, unknown> = {}): DriverFactory {
  const bad = (msg: string): never => {
    throw new AiBddError('CONFIG_INVALID', `driver-playwright: ${msg}`);
  };
  const out: PlaywrightOptions = {};
  for (const [k, v] of Object.entries(options)) {
    switch (k) {
      case 'browser':
        if (typeof v !== 'string' || !BROWSERS.has(v)) bad(`"browser" must be one of chromium, firefox, webkit`);
        out.browser = v as NonNullable<PlaywrightOptions['browser']>;
        break;
      case 'headless':
      case 'recordVideo':
        if (typeof v !== 'boolean') bad(`"${k}" must be a boolean`);
        out[k] = v as boolean;
        break;
      case 'viewport': {
        const vp = v as { width?: unknown; height?: unknown } | null;
        if (vp === null || typeof vp !== 'object' || !Number.isInteger(vp.width) || !Number.isInteger(vp.height)) bad('"viewport" must be {width, height} integers');
        out.viewport = { width: (vp as { width: number }).width, height: (vp as { height: number }).height };
        break;
      }
      case 'launchOptions':
        if (v === null || typeof v !== 'object' || Array.isArray(v)) bad('"launchOptions" must be an object');
        out.launchOptions = v as LaunchOptions;
        break;
      case 'executablePath':
        if (typeof v !== 'string' || v.length === 0) bad('"executablePath" must be a non-empty string');
        out.launchOptions = { ...out.launchOptions, executablePath: v as string };
        break;
      case 'actionTimeoutMs':
      case 'navigationTimeoutMs':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) bad(`"${k}" must be a positive number`);
        out[k] = v as number;
        break;
      default:
        bad(`unknown option "${k}"`);
    }
  }
  return playwright(out);
}
