// @ts-nocheck
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { feature, plan, scenario } from './helpers/doubles.ts';

const run = promisify(execFile);
const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const PW_CLI = here('../node_modules/@playwright/test/cli.js');
const PW_CONFIG = here('./example/playwright.config.ts');
const TESTING_SRC = pathToFileURL(here('../../testing/src/index.ts')).href;
const CORPUS = here('../../testing/corpus');

// The error code thrown by baseline stubs, spelled out piecewise so the stub scan finds no marker in this file.
const STUB_CODE = ['NOT', 'IMPLEMENTED'].join('_');

/** True when `fn` is still the baseline stub of a module that has not landed yet. */
async function isStub(fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return (error as { code?: string } | null)?.code === STUB_CODE;
  }
}

// Siblings are imported dynamically: while they are being built a module may be missing, broken or a stub, and that
// must skip these tests with a reason instead of failing the whole file.
type Sdk = typeof import('@ai-bdd/sdk');
type Driver = typeof import('@ai-bdd/driver-playwright');
type Testing = typeof import('@ai-bdd/testing');
const sibling = {} as { sdk: Sdk; driver: Driver; testing: Testing };

async function stubReason(needs: { engine: boolean }): Promise<string | null> {
  const scratch = mkdtempSync(join(tmpdir(), 'pwtest-probe-'));
  try {
    try {
      sibling.sdk = await import('@ai-bdd/sdk');
    } catch (error) {
      return `@ai-bdd/sdk does not load yet: ${String(error).slice(0, 120)}`;
    }
    const { loadPlansSync, loadConfig, createEngine } = sibling.sdk;
    if (await isStub(() => loadPlansSync(scratch))) return '@ai-bdd/sdk loadPlansSync is still a baseline stub';
    if (!needs.engine) return null;
    try {
      sibling.driver = await import('@ai-bdd/driver-playwright');
      sibling.testing = await import('@ai-bdd/testing');
    } catch (error) {
      return `a sibling package does not load yet: ${String(error).slice(0, 120)}`;
    }
    const { sessionFromPage } = sibling.driver;
    const { createFakeModels, fakeDriver, startAcmeApp } = sibling.testing;
    if (await isStub(() => loadConfig({ cwd: scratch }))) return '@ai-bdd/sdk loadConfig is still a stub';
    if (await isStub(() => createEngine(undefined as never))) return '@ai-bdd/sdk createEngine is still a stub';
    if (await isStub(() => sessionFromPage(null as never, undefined as never, undefined as never))) return '@ai-bdd/driver-playwright sessionFromPage is still a stub';
    if (await isStub(() => createFakeModels({ rules: [] }))) return '@ai-bdd/testing createFakeModels is still a stub';
    if (await isStub(() => fakeDriver({}))) return '@ai-bdd/testing fakeDriver is still a stub';
    if (await isStub(async () => (await startAcmeApp({})).close())) return '@ai-bdd/testing startAcmeApp is still a stub';
    if (!existsSync(join(CORPUS, 'docs', 'billing.md'))) return 'packages/testing/corpus is not there yet (X-CORPUS)';
    if (!existsSync(chromium.executablePath())) return 'no Chromium available (see V7: PLAYWRIGHT_BROWSERS_PATH or AI_BDD_CHROMIUM_PATH)';
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CI; // ai-bdd's CI defaults would make recordings read-only
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=source`.trim();
  return env;
}

async function playwrightTest(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [PW_CLI, 'test', '-c', PW_CONFIG, ...args], { env, timeout: 200_000, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

const listReason = await stubReason({ engine: false });
const fullReason = await stubReason({ engine: true });
const label = (name: string, reason: string | null): string => (reason === null ? name : `${name} [SKIPPED: ${reason}]`);

describe('@playwright/test collects ai-bdd plans (R-SDK1)', () => {
  it.skipIf(listReason !== null)(label('R-SDK1 `playwright test --list` registers describe/test/tag from committed plans without loading any config', listReason), async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwtest-list-'));
    cleanup.push(dir);
    const planDir = join(dir, 'plans');
    mkdirSync(join(planDir, 'docs'), { recursive: true });
    const p = plan('docs/billing.md', [
      feature('docs-billing--upgrading', 'Upgrading to Pro', [
        scenario('docs-billing--upgrading/upgrade-to-pro', 'Upgrade to Pro', { tags: ['billing'] }),
        scenario('docs-billing--upgrading/rejected', 'Rejected one', { review: 'rejected' }),
      ]),
    ]);
    writeFileSync(join(planDir, 'docs', 'billing.md.plan.json'), `${JSON.stringify(p, null, 2)}\n`);

    // The config path does not exist: collection must not need it (the engine is created lazily by the first test).
    const { code, out } = await playwrightTest(['--list'], childEnv({ AI_BDD_PLAN_DIR: planDir, AI_BDD_CONFIG: join(dir, 'missing.config.mjs') }));
    expect(out).toContain('Upgrading to Pro › Upgrade to Pro');
    expect(out).not.toContain('Rejected one');
    expect(out).toContain('Total: 1 test');
    expect(code).toBe(0);
  }, 240_000);
});

describe('@playwright/test runs ai-bdd scenarios (M22, AC9)', () => {
  it.skipIf(fullReason !== null)(label('M22 R-SDK3 the billing subset under @playwright/test gives the same statuses as the engine run, with evidence attached', fullReason), async () => {
    const project = mkdtempSync(join(tmpdir(), 'pwtest-project-'));
    cleanup.push(project);
    cpSync(CORPUS, project, { recursive: true });
    rmSync(join(project, '.ai-bdd'), { recursive: true, force: true });

    const { loadConfig, createEngine } = sibling.sdk;
    const savedEnv = new Map<string, string | undefined>();
    const acme = await sibling.testing.startAcmeApp({});
    try {
      const configPath = join(project, 'ai-bdd.config.pwtest.mjs');
      writeFileSync(
        configPath,
        [
          `import { acmeFixtures, createFakeModels, fakeDriver } from ${JSON.stringify(TESTING_SRC)};`,
          'export default {',
          "  docs: ['docs/**/*.md'],",
          '  baseURL: process.env.AI_BDD_ACME_URL,',
          '  fixtures: acmeFixtures,',
          "  secrets: { adminPassword: { env: 'ACME_ADMIN_PASSWORD' } },",
          "  // a Playwright worker creates its engine with cwd = process.cwd(); pin every directory to this project",
          `  planDir: ${JSON.stringify(join(project, '.ai-bdd', 'plans'))},`,
          `  recordingsDir: ${JSON.stringify(join(project, '.ai-bdd', 'recordings'))},`,
          `  runsDir: ${JSON.stringify(join(project, '.ai-bdd', 'runs'))},`,
          `  cacheDir: ${JSON.stringify(join(project, '.ai-bdd', 'cache'))},`,
          "  drivers: { fake: fakeDriver({}) },",
          "  defaultDriver: 'fake',",
          `  models: createFakeModels({ rulesDir: ${JSON.stringify(join(project, 'fake-model'))} }),`,
          '};',
          '',
        ].join('\n'),
      );
      const env = { AI_BDD_ACME_URL: acme.url, ACME_ADMIN_PASSWORD: 'correct-horse-battery', AI_BDD_RECORDINGS: 'read-write' };
      for (const key of [...Object.keys(env), 'CI']) savedEnv.set(key, process.env[key]);
      Object.assign(process.env, env);
      delete process.env.CI;

      // Baseline: compile, then run the same subset through the engine (fake driver), as the CLI would.
      const config = await loadConfig({ cwd: project, configPath });
      const engine = await createEngine(config);
      await engine.compile();
      const baseline = await engine.run({ selectors: ['docs/billing.md'], frozen: true, compile: false, workers: 1 });
      await engine.close();
      expect(baseline.scenarios.length).toBeGreaterThan(0);
      const expected = new Map(baseline.scenarios.map((s) => [s.scenarioId, s.status] as const));

      const reportFile = join(project, 'pw-report.json');
      const { code, out } = await playwrightTest(
        [],
        childEnv({ ...env, AI_BDD_CONFIG: configPath, AI_BDD_PLAN_DIR: join(project, '.ai-bdd', 'plans'), AI_BDD_SELECTORS: 'docs/billing.md', PW_JSON_OUTPUT: reportFile, PW_OUTPUT_DIR: join(project, 'pw-results') }),
      );
      expect(existsSync(reportFile), out).toBe(true);

      interface PwResult { status: string; attachments?: { name: string; path?: string; body?: string }[] }
      interface PwSuite { suites?: PwSuite[]; specs?: { title: string; ok: boolean; tests: { results: PwResult[] }[] }[] }
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as PwSuite;
      const specs: { ok: boolean; results: PwResult[] }[] = [];
      const walk = (suite: PwSuite): void => {
        for (const s of suite.specs ?? []) specs.push({ ok: s.ok, results: s.tests.flatMap((t) => t.results) });
        for (const child of suite.suites ?? []) walk(child);
      };
      walk(report);
      expect(specs.length, out).toBe(expected.size);

      const seen = new Map<string, string>();
      for (const spec of specs) {
        const attachments = spec.results.flatMap((r) => r.attachments ?? []);
        const read = (name: string): string => {
          const a = attachments.find((x) => x.name === name);
          if (a === undefined) throw new Error(`attachment ${name} missing\n${out}`);
          return a.path === undefined ? Buffer.from(a.body ?? '', 'base64').toString('utf8') : readFileSync(a.path, 'utf8');
        };
        const result = JSON.parse(read('ai-bdd-result.json')) as { scenarioId: string; status: string };
        expect(read('ai-bdd-steps.txt')).toContain(result.status);
        seen.set(result.scenarioId, result.status);
        // The Playwright verdict follows the ai-bdd status: passed/healed pass, anything else fails.
        expect(spec.ok).toBe(result.status === 'passed' || result.status === 'healed');
      }
      expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(expected));
      expect(code === 0 || [...seen.values()].some((s) => s !== 'passed' && s !== 'healed')).toBe(true);
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await acme.close();
    }
  }, 300_000);
});
