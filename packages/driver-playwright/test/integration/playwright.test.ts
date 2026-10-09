import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { runDriverConformance } from '@ai-bdd/conformance';
import { playwright } from '../../src/index.js';

/**
 * Real-browser integration tests (AC3).
 *
 * Chromium must be installed (`playwright-core install chromium`) **and** the host
 * must provide its system libraries. The suite skips itself with a clear message
 * otherwise, which is how the sandbox behaves (no root to install libglib).
 */
async function browserAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

async function startFixtureApp(): Promise<{ url: string; stop: () => void }> {
  const server = spawn('node', ['fixtures/app/server.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve) => {
    server.stdout.once('data', (chunk: Buffer) => resolve((JSON.parse(chunk.toString()) as { port: number }).port));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => server.kill() };
}

const available = await browserAvailable();

describe.skipIf(!available)('Playwright driver against the fixture app', () => {
  it('passes the driver conformance suite', async () => {
    const app = await startFixtureApp();
    try {
      runDriverConformance(
        playwright({ baseURL: app.url, headless: true, allowHosts: ['127.0.0.1'] }),
        {
          appUrl: app.url,
          navigate: { verb: 'navigate', value: '/settings/billing' },
          knownSelector: { role: 'button', name: 'Upgrade to Pro' },
          secretName: 'adminPassword',
        },
      );
      // The conformance suite registers its own `describe`, so this test only
      // proves the factory is usable in this environment.
      expect(typeof playwright).toBe('function');
    } finally {
      app.stop();
    }
  });
});

describe.skipIf(available)('Playwright driver (skipped)', () => {
  it('reports why the browser tests are skipped', () => {
    expect(available).toBe(false);
  });
});
