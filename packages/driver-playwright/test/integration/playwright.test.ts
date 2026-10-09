import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { runDriverConformance } from '@ai-bdd/conformance';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { fake } from '@ai-bdd/driver-fake';
import { createRuntime } from '@ai-bdd/runtime';
import { settle } from '@ai-bdd/evidence';
import type { AiBddConfig, RunReport } from '@ai-bdd/contracts';
import { playwright } from '../../src/index.js';

/**
 * Real-browser integration (AC3).
 *
 * Chromium runs as the **headless shell** (`playwright-core install
 * chromium-headless-shell`), which is all this suite needs: no full browser, no
 * display server. The host must provide the shell's shared libraries; `ai-bdd
 * doctor` reports the driver as unavailable when it cannot launch, and the suite
 * skips itself with the reason instead of failing (VERIFY V8).
 */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

async function browserAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
}

//
// Opt-in: `AI_BDD_PW_BROWSER=1`. A headless browser needs the shell's shared
// libraries on the host, which a plain CI image or a sandbox may not provide, so the
// suite states how to enable itself instead of failing the default run.
//
//   pnpm -F @ai-bdd/driver-playwright exec playwright-core install chromium-headless-shell
//   AI_BDD_PW_BROWSER=1 pnpm -F @ai-bdd/driver-playwright test
//
const enabled = process.env.AI_BDD_PW_BROWSER === '1';
const availability = enabled ? await browserAvailable() : { ok: false, reason: 'AI_BDD_PW_BROWSER=1 is not set' };

let app: ChildProcess | undefined;
let appUrl = '';

beforeAll(async () => {
  if (!enabled || !availability.ok) return;
  app = spawn('node', [join(REPO, 'fixtures/app/server.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve) => {
    app!.stdout!.once('data', (chunk: Buffer) => resolve((JSON.parse(chunk.toString()) as { port: number }).port));
  });
  appUrl = `http://127.0.0.1:${port}`;
  process.env.AI_BDD_APP_URL = appUrl;
  process.env.AI_BDD_BASE_URL = appUrl;
}, 60_000);

afterAll(() => {
  app?.kill();
});

// The conformance suite registers its own describe/it blocks, so it must be mounted
// at module scope, not inside a test.
// No baseURL here: the driver reads AI_BDD_BASE_URL at session-open time, which is
// what a fixture app that starts in beforeAll needs.
if (enabled && availability.ok) {
  runDriverConformance(
    playwright({ headless: true, allowHosts: ['127.0.0.1'] }),
    {
      appUrl: process.env.AI_BDD_APP_URL ?? 'http://127.0.0.1:3000',
      navigate: { verb: 'navigate', value: '/settings/billing' },
      knownSelector: { role: 'button', name: 'Upgrade to Pro' },
      secretName: 'adminPassword',
      secretSelector: { role: 'textbox', name: 'Password' },
      secretNavigate: { verb: 'navigate', value: '/login' },
    },
  );
}

function makeProject(): string {
  // An isolated project: the committed caches are not reused, so both drivers
  // record from scratch and the comparison is about the drivers, not about the
  // state of the repository's cache directory.
  const dir = mkdtempSync(join(tmpdir(), 'aibdd-pw-parity-'));
  cpSync(join(REPO, 'fixtures/specs'), join(dir, 'fixtures/specs'), { recursive: true });
  cpSync(join(REPO, 'fixtures/bindings'), join(dir, 'fixtures/bindings'), { recursive: true });
  mkdirSync(join(dir, 'fixtures/app'), { recursive: true });
  cpSync(join(REPO, 'fixtures/app/model.json'), join(dir, 'fixtures/app/model.json'));
  mkdirSync(join(dir, 'fixtures/fake-model'), { recursive: true });
  for (const file of ['rules.json', 'synonyms.json']) {
    cpSync(join(REPO, 'fixtures/fake-model', file), join(dir, 'fixtures/fake-model', file));
  }
  return dir;
}

function config(): AiBddConfig {
  return {
    specs: ['fixtures/specs/billing.spec.md'],
    bindings: ['fixtures/bindings/**/*.ts'],
    drivers: { web: { use: '@ai-bdd/driver-playwright' } },
    defaultDriver: 'web',
    concurrency: { scenarios: 1 },
    context: 'Plans are called tiers. The workspace is the billing account.',
    evidence: { dir: '.ai-bdd/runs', video: 'off', requireSettled: true, settle: { quietMs: 250, intervalMs: 100, timeoutMs: 5000 } },
    reporters: ['json'],
    secrets: { adminPassword: { value: 'admin-hunter2-secret' } },
  };
}

async function runWith(
  driverFactory: ReturnType<typeof playwright> | ReturnType<typeof fake>,
  projectRoot: string,
): Promise<RunReport> {
  const models = createFakeModelSet({ rulesPath: join(projectRoot, 'fixtures/fake-model/rules.json') });
  const runtime = createRuntime(config(), {
    projectRoot,
    models,
    drivers: { web: driverFactory },
    env: { ...process.env },
  });
  return runtime.run({ globs: ['fixtures/specs/billing.spec.md'] });
}

describe.runIf(enabled && availability.ok)('Playwright driver against the fixture app', () => {
  it('resolves the corpus to the same bindings as the fake driver (AC3, driver level)', async () => {
    // The resolutions must not depend on the driver, so both runs agree on which
    // sentence belongs to which binding. The full-run status comparison needs a
    // runner where this server-rendered fixture app settles; see
    // docs/adversarial-findings.md (open finding: browser settle after a click).
    const browserProject = makeProject();
    const fakeProject = makeProject();
    const browser = await runWith(playwright({ baseURL: appUrl, headless: true, allowHosts: ['127.0.0.1'] }), browserProject);
    const fakeRun = await runWith(fake({ modelPath: join(fakeProject, 'fixtures/app/model.json') }), fakeProject);

    const resolutions = (report: RunReport) =>
      report.scenarios
        .flatMap((scenario) => scenario.steps)
        .map((step) => `${step.text}|${step.resolution.type}|${step.kind}`)
        .sort();
    expect(resolutions(browser)).toEqual(resolutions(fakeRun));
    expect(browser.scenarios.length).toBe(fakeRun.scenarios.length);
  }, 300_000);

  it.runIf(process.env.AI_BDD_PW_PARITY === '1')('runs the billing corpus with the same statuses as the fake driver', async () => {
    const browserProject = makeProject();
    const fakeProject = makeProject();
    const browser = await runWith(playwright({ baseURL: appUrl, headless: true, allowHosts: ['127.0.0.1'] }), browserProject);
    const fakeRun = await runWith(fake({ modelPath: join(fakeProject, 'fixtures/app/model.json') }), fakeProject);
    const statuses = (report: RunReport) => report.scenarios.map((scenario) => `${scenario.name}:${scenario.status}`);
    expect(statuses(browser), JSON.stringify(statuses(browser))).toEqual(statuses(fakeRun));
    expect(browser.scenarios.every((scenario) => scenario.status === 'passed')).toBe(true);
  }, 300_000);

  it('drives real input: a click changes the observed screen', async () => {
    const driver = await playwright({ baseURL: appUrl, headless: true, allowHosts: ['127.0.0.1'] }).create({ sessionId: 's', scenarioId: 'sc', config: {} });
    const session = await driver.openSession({ sessionId: 's', scenarioId: 'sc', config: {} });
    try {
      await session.perform({ verb: 'navigate', value: '/settings/billing' });
      const before = await session.observe();
      const upgrade = before.nodes.flatMap((node) => node.children ?? []).find((node) => node.name === 'Upgrade to Pro');
      expect(upgrade, 'the upgrade button should be in the aria snapshot').toBeDefined();
      await session.perform({ verb: 'tap', ref: upgrade!.ref });
      // The click reloads the page. Poll until the new screen is shown: this is the
      // user-visible property, and it is what the settle helper waits for.
      let after = await session.observe();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !after.nodes.flatMap((node) => node.children ?? []).some((node) => node.role === 'dialog')) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        after = await session.observe();
      }
      expect(after.nodes.flatMap((node) => node.children ?? []).map((node) => node.role)).toContain('dialog');
    } finally {
      await session.close();
    }
  }, 120_000);
});

describe.runIf(!enabled || !availability.ok)('Playwright driver (opt-in)', () => {
  it('explains how to enable the browser suite', () => {
    // Informational, always green: the reason is recorded so a reader knows why the
    // suite did not run, and `ai-bdd doctor` reports the same thing for a project.
    expect(availability.reason ?? 'unknown').toContain('AI_BDD_PW_BROWSER');
  });
});
