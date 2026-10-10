import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { startAcmeApp } from '@ai-bdd/testing';
import { cliOutput, runCli } from './helpers/cli.ts';
import { describePlaywright } from './helpers/parity.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD, REPO_ROOT } from './helpers/paths.ts';
import { createProject, FAST_REAL, type Project } from './helpers/project.ts';
import { latestRunDir, readRunReport } from './helpers/runs.ts';

const run = promisify(execFile);
const PW_CLI = `${REPO_ROOT}/packages/playwright-test/node_modules/@playwright/test/cli.js`;
const PW_CONFIG = `${REPO_ROOT}/packages/playwright-test/test/example/playwright.config.ts`;

let project: Project | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

interface PwResult {
  status: string;
  attachments?: { name: string; path?: string; body?: string }[];
}
interface PwSuite {
  suites?: PwSuite[];
  specs?: { title: string; ok: boolean; tests: { results: PwResult[] }[] }[];
}

describePlaywright('M22 [P] @ai-bdd/playwright-test on the billing subset', () => {
  it('M22 [P] R-SDK1 R-SDK3: @playwright/test gives the same statuses as the CLI run and attaches evidence', async () => {
    const p = createProject({ docs: ['billing'], options: FAST_REAL });
    project = p;

    // baseline: the CLI with the fake driver (compiles the plans as a side effect)
    const cli = await runCli(p, ['run', 'docs/billing.md']);
    expect(cli.code, cliOutput(cli)).toBe(0);
    const baseline = new Map(readRunReport(latestRunDir(p)).scenarios.map((s) => [s.scenarioId, s.status] as const));
    expect(baseline.size).toBe(5);

    writeFileSync(
      p.path('ai-bdd.config.pwtest.mjs'),
      [
        "import { fileURLToPath } from 'node:url';",
        "import base from './ai-bdd.config.mjs';",
        "import { createFakeModels, fakeDriver } from '@ai-bdd/testing';",
        'export default {',
        '  ...base,',
        '  baseURL: process.env.ACME_URL,',
        "  // the engine of a Playwright worker is created with cwd = process.cwd(); pin everything to this project",
        "  planDir: fileURLToPath(new URL('./.ai-bdd/plans', import.meta.url)),",
        "  recordingsDir: fileURLToPath(new URL('./.ai-bdd/recordings', import.meta.url)),",
        "  runsDir: fileURLToPath(new URL('./.ai-bdd/runs', import.meta.url)),",
        "  cacheDir: fileURLToPath(new URL('./.ai-bdd/cache', import.meta.url)),",
        "  drivers: { fake: fakeDriver({}) },",
        "  defaultDriver: 'fake',",
        '  models: createFakeModels({ rulesDir: process.env.AI_BDD_FAKE_RULES }),',
        '};',
        '',
      ].join('\n'),
    );

    const acme = await startAcmeApp({});
    try {
      const reportFile = p.path('pw-report.json');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ACME_URL: acme.url,
        ACME_ADMIN_PASSWORD: ACME_DEFAULT_ADMIN_PASSWORD,
        AI_BDD_FAKE_RULES: p.rulesDir,
        // Finding (docs/integration-notes/X-CORPUS.md): with sessionFactory the confirm run is handed the SAME page, which already
        // holds the upgraded state, so a characterization run under read-write ends in CHARACTERIZATION_UNSTABLE.
        AI_BDD_RECORDINGS: 'read-only',
        AI_BDD_CONFIG: p.path('ai-bdd.config.pwtest.mjs'),
        AI_BDD_PLAN_DIR: p.plansDir,
        AI_BDD_SELECTORS: 'docs/billing.md',
        PW_JSON_OUTPUT: reportFile,
        PW_OUTPUT_DIR: p.path('pw-results'),
        NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --conditions=source`.trim(),
      };
      delete env['CI'];
      let out = '';
      try {
        const { stdout, stderr } = await run(process.execPath, [PW_CLI, 'test', '-c', PW_CONFIG], { env, timeout: 280_000, maxBuffer: 32 * 1024 * 1024 });
        out = `${stdout}\n${stderr}`;
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      }
      expect(existsSync(reportFile), out).toBe(true);

      const specs: { ok: boolean; results: PwResult[] }[] = [];
      const walk = (suite: PwSuite): void => {
        for (const s of suite.specs ?? []) specs.push({ ok: s.ok, results: s.tests.flatMap((t) => t.results) });
        for (const child of suite.suites ?? []) walk(child);
      };
      walk(JSON.parse(readFileSync(reportFile, 'utf8')) as PwSuite);
      expect(specs.length, out).toBe(baseline.size);

      const seen = new Map<string, string>();
      const details: string[] = [];
      for (const spec of specs) {
        const attachments = spec.results.flatMap((r) => r.attachments ?? []);
        const read = (name: string): string => {
          const a = attachments.find((x) => x.name === name);
          if (a === undefined) throw new Error(`attachment ${name} missing; have ${attachments.map((x) => x.name).join(', ')}\n${out.slice(-3000)}`);
          return a.path === undefined ? Buffer.from(a.body ?? '', 'base64').toString('utf8') : readFileSync(a.path, 'utf8');
        };
        const result = JSON.parse(read('ai-bdd-result.json')) as { scenarioId: string; status: string };
        const steps = read('ai-bdd-steps.txt');
        expect(steps.length).toBeGreaterThan(0);
        if (result.status !== 'passed') details.push(`${result.scenarioId}\n${steps}`);
        seen.set(result.scenarioId, result.status);
        expect(spec.ok).toBe(result.status === 'passed' || result.status === 'healed');
      }
      expect(Object.fromEntries(seen), details.join('\n')).toEqual(Object.fromEntries(baseline));
    } finally {
      await acme.close();
    }
  }, 300_000);
});
