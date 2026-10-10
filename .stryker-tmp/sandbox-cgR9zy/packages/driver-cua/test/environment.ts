// @ts-nocheck
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';

/**
 * What the real-product tests need: a Linux desktop session (an X display, a window manager, the AT-SPI bus), the `cua-driver`
 * executable and a Chromium that exposes its accessibility tree. `realEnvironment()` says whether they are present; the tests
 * that need them are skipped otherwise (see `.github/workflows/ci.yml`, job `cua`, for a runner that provides all of it).
 */
export interface RealEnvironment { cuaDriver: string; chromium: string }

export function cuaDriverBinary(): string {
  return process.env['CUA_DRIVER_BIN'] ?? 'cua-driver';
}

export function findChromium(): string | undefined {
  const explicit = process.env['AI_BDD_CHROMIUM_PATH'];
  if (explicit !== undefined && explicit.length > 0 && existsSync(explicit)) return explicit;
  for (const root of [process.env['PLAYWRIGHT_BROWSERS_PATH'], '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright')]) {
    if (root === undefined || !existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const p = join(root, d, sub, 'chrome');
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

/** Why the real-product tests cannot run here, or `undefined` when they can. */
export function unavailableReason(): string | undefined {
  if (process.platform !== 'linux') return `platform ${process.platform} is not linux`;
  const display = process.env['DISPLAY'];
  if (display === undefined || display.length === 0) return 'no X display (DISPLAY is not set)';
  const probe = spawnSync(cuaDriverBinary(), ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return `${cuaDriverBinary()} is not installed (https://cua.ai/docs/cua-driver/quickstart)`;
  if (findChromium() === undefined) return 'no Chromium found (set AI_BDD_CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH)';
  return undefined;
}

export function realEnvironment(): RealEnvironment | undefined {
  if (unavailableReason() !== undefined) return undefined;
  return { cuaDriver: cuaDriverBinary(), chromium: findChromium() as string };
}

/** Chromium arguments that give each session its own profile and publish the page to the accessibility bus. */
export function chromiumArgs(): string[] {
  return [
    '--no-sandbox',
    '--force-renderer-accessibility',
    '--user-data-dir={profile}',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--window-position=0,0',
    '--window-size=1100,760',
    '{url}',
  ];
}

const PAGES: Record<string, string> = {
  '/': `<!doctype html><html><head><title>Probe</title></head><body>
<h1>Hello</h1>
<label>Name <input id="n" value="Bob"></label>
<button onclick="document.getElementById('o').textContent = 'Hi ' + document.getElementById('n').value">Greet</button>
<p id="o"></p>
<a href="/two">Settings page</a>
</body></html>`,
  '/two': `<!doctype html><html><head><title>Settings</title></head><body>
<h2>Settings</h2>
<label><input type="checkbox" id="c" checked> Subscribe</label>
<label><input type="checkbox" id="c2"> Terms</label>
<label>Password <input type="password" id="p"></label>
<button disabled>Disabled one</button>
<div style="height:2400px">tall</div>
<button onclick="document.getElementById('r').textContent = 'bottom clicked'">Bottom</button>
<p id="r"></p>
<a href="/">Home link</a>
</body></html>`,
};

export interface Fixture { url: string; close(): Promise<void> }

/** A tiny page server on loopback: the application under test for the real-product tests. */
export async function startFixture(): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const body = PAGES[path];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
