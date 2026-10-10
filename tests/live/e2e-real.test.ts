// Real end-to-end test: NO test doubles. The real CLI compiles and runs the Acme corpus with real models
// (@ai-bdd/models-ai-sdk, configured by the corpus' own ai-bdd.config.mjs) and the real Playwright driver (Chromium)
// against the Acme app started in this process. Only structural guarantees are asserted, never exact model output.
//
//   pnpm build && AI_BDD_LIVE=1 AI_GATEWAY_API_KEY=... pnpm exec vitest run -c tests/live/vitest.live.config.ts
//
// Skipped (with the reason in the suite name) unless AI_BDD_LIVE=1, a provider key, a Chromium and the built packages are available.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverChromium } from '@ai-bdd/driver-playwright';
import { loadPlansSync, normalizeForQuote } from '@ai-bdd/sdk';
import { startAcmeApp } from '@ai-bdd/testing';
import { CORPUS_DIR, REPO_ROOT, WORK_ROOT } from '../acceptance/helpers/paths.ts';
import { findSecret } from '../acceptance/helpers/scan.ts';

// The BUILT binary (`pnpm build` first). `node --conditions=source packages/cli/src/bin.ts` cannot be used here: third-party
// packages such as the AI SDK's dependencies also publish a `source` export condition that points at TypeScript, which Node
// refuses to strip under node_modules.
const CLI_DIST_BIN = `${REPO_ROOT}/packages/cli/dist/bin.js`;
const PROVIDER_KEYS = ['AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
const ADMIN_PASSWORD = 'live-e2e-correct-horse-battery';
const MODEL = process.env['AI_BDD_MODEL'] ?? 'anthropic/claude-sonnet-5.5';

function skipReason(): string | null {
  if (process.env['AI_BDD_LIVE'] !== '1') return 'AI_BDD_LIVE=1 is not set';
  if (!PROVIDER_KEYS.some((k) => (process.env[k] ?? '') !== '')) return `no provider credentials (${PROVIDER_KEYS.join(', ')})`;
  if (!existsSync(CLI_DIST_BIN)) return 'packages are not built (run pnpm build)';
  const explicit = process.env['AI_BDD_CHROMIUM_PATH'];
  if (explicit !== undefined && explicit !== '' ? !existsSync(explicit) : discoverChromium(true) === undefined) {
    return 'no Chromium found (set AI_BDD_CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH)';
  }
  return null;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The real built binary, no `-c`: the project's own ai-bdd.config.mjs (Playwright driver + AI SDK models) is found by name. */
function cli(cwd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST_BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ai-bdd ${args.join(' ')} timed out after ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const output = (r: CliResult): string => `exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

const reason = skipReason();

describe.skipIf(reason !== null)(reason === null ? 'real end-to-end: real CLI, real models, real Playwright driver' : `real end-to-end [SKIPPED: ${reason}]`, () => {
  let dir = '';
  let acme: { url: string; close(): Promise<void> } | undefined;
  let env: Record<string, string> = {};

  beforeAll(async () => {
    // Inside the repo so the config's `import '@ai-bdd/sdk'` and `{ use: '@ai-bdd/driver-playwright' }` resolve through the workspace links.
    mkdirSync(WORK_ROOT, { recursive: true });
    dir = mkdtempSync(join(WORK_ROOT, 'live-'));
    mkdirSync(join(dir, 'docs'));
    cpSync(join(CORPUS_DIR, 'ai-bdd.config.mjs'), join(dir, 'ai-bdd.config.mjs'));
    for (const doc of ['billing', 'login']) cpSync(join(CORPUS_DIR, 'docs', `${doc}.md`), join(dir, 'docs', `${doc}.md`));
    acme = await startAcmeApp({ adminPassword: ADMIN_PASSWORD });
    env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || k === 'CI' || k === 'ACME_URL' || k === 'ACME_ADMIN_PASSWORD' || k === 'AI_BDD_RECORDINGS') continue;
      env[k] = v;
    }
    env['NODE_NO_WARNINGS'] = '1';
    env['ACME_URL'] = acme.url;
    env['ACME_ADMIN_PASSWORD'] = ADMIN_PASSWORD;
    env['AI_BDD_MODEL'] = MODEL;
  });

  afterAll(async () => {
    await acme?.close();
    if (dir !== '' && process.env['AI_BDD_KEEP_WORK'] !== '1') rmSync(dir, { recursive: true, force: true });
  });

  it('compiles billing.md and login.md into grounded plans, then runs them with a real browser', async () => {
    const compiled = await cli(dir, ['compile'], env, 600_000);
    expect(compiled.code, output(compiled)).toBeLessThan(2); // 0 compiled; 1 a section the model could not ground (kept out of the plan)

    const plans = loadPlansSync(join(dir, '.ai-bdd', 'plans'));
    expect(plans.length, output(compiled)).toBeGreaterThan(0);
    const features = plans.flatMap((p) => p.features);
    expect(features.length, output(compiled)).toBeGreaterThan(0);
    // grounding holds whatever the model said: every kept feature cites a chunk with a verbatim quote
    for (const f of features) {
      const quoted = f.sources.filter((s) => s.relation === 'source');
      expect(quoted.length, f.title).toBeGreaterThan(0);
      for (const s of quoted) if (s.quote !== undefined) expect(normalizeForQuote(s.quote).length).toBeGreaterThan(0);
    }

    const run = await cli(dir, ['run', '--no-compile'], env, 1_200_000);
    // 0: everything passed; 1: a scenario failed or was inconclusive (a model may misjudge). 3 would be an infrastructure
    // error (model unavailable, driver unavailable, ...) and 2 a usage/config error: neither may happen with a working setup.
    expect([0, 1], output(run)).toContain(run.code);

    const runsDir = join(dir, '.ai-bdd', 'runs');
    expect(existsSync(runsDir), output(run)).toBe(true);
    const runDirs = readdirSync(runsDir);
    expect(runDirs.length, output(run)).toBeGreaterThan(0);
    for (const name of runDirs) expect(existsSync(join(runsDir, name, 'report.json')), name).toBe(true);
    const report = JSON.parse(readFileSync(join(runsDir, runDirs.sort().at(-1) as string, 'report.json'), 'utf8')) as { scenarios: { status: string; driver?: string }[] };
    expect(report.scenarios.length).toBeGreaterThan(0);
    for (const s of report.scenarios) expect(s.status).not.toBe('error');

    // secrets never reach disk, in any encoding (R-SE1)
    expect(findSecret([join(dir, '.ai-bdd')], ADMIN_PASSWORD)).toEqual([]);
    expect(run.stdout + run.stderr + compiled.stdout + compiled.stderr).not.toContain(ADMIN_PASSWORD);
  });
});
