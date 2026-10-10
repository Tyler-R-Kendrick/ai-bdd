// @ts-nocheck
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { writeTestConfig } from '@ai-bdd/testing';
import { runCli } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const bin = join(repoRoot, 'packages', 'cli', 'src', 'bin.ts');
const corpus = join(repoRoot, 'packages', 'testing', 'corpus');
/** Inside the repo (under the ignored node_modules) so `@ai-bdd/*` imports of the generated config resolve through the workspace links. */
const workRoot = join(repoRoot, 'node_modules', '.cache', 'ai-bdd-cli-tests');

const FAKE_ENV = { AI_BDD_FAKE: '1', AI_BDD_FAKE_RULES: '/rules', AI_BDD_FAKE_FLAGS: 'v2,bug-upgrade-noop', AI_BDD_FAKE_LOG: '/log.jsonl' };

describe('there is no fake mode in the CLI', () => {
  it('AI_BDD_FAKE* variables change nothing: the loaded config alone is handed to createEngine', async () => {
    const plain = await runCli(['status'], { env: {}, config: { defaultDriver: 'web' } });
    const withEnv = await runCli(['status'], { env: FAKE_ENV, config: { defaultDriver: 'web' } });
    expect(withEnv.code).toBe(0);
    expect(withEnv.stderr).toBe('');
    expect(withEnv.stdout).toBe(plain.stdout);
    expect(withEnv.createEngine).toHaveBeenCalledTimes(1);
    // exactly the loaded config object, no overrides for models or drivers
    expect(withEnv.createEngine.mock.calls[0]).toEqual([withEnv.config]);
    expect(withEnv.createEngine.mock.calls[0]?.[0]).toBe(withEnv.config);
    expect(withEnv.config.defaultDriver).toBe('web');
  });

  it.each(['compile', 'show', 'prune', 'doctor', 'run'])('`%s` prints no FAKE banner and keeps the config driver under AI_BDD_FAKE=1', async (cmd) => {
    const h = await runCli([cmd], { env: FAKE_ENV });
    expect(h.stderr).not.toMatch(/fake/i);
    expect(h.stdout).not.toMatch(/fake/i);
    expect(h.createEngine.mock.calls[0]).toEqual([h.config]);
    expect(h.config.drivers).toEqual({});
    expect(h.config.defaultDriver).toBe('web');
  });

  it('`run` without --driver passes no driver to the engine even with AI_BDD_FAKE=1', async () => {
    const h = await runCli(['run'], { env: FAKE_ENV });
    const opts = (h.engine.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { driver?: string } | undefined;
    expect(opts?.driver).toBeUndefined();
  });

  it('a missing config is exit 2 (CONFIG_NOT_FOUND) with or without AI_BDD_FAKE; nothing falls back to defaults', async () => {
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_NOT_FOUND', 'none');
    });
    for (const env of [{}, FAKE_ENV]) {
      for (const argv of [['status'], ['compile'], ['run'], ['show'], ['review', 'accept', 'x'], ['prune'], ['doctor']]) {
        const h = await runCli(argv, { env, deps: { loadConfig } });
        expect(h.code, `${argv.join(' ')} ${JSON.stringify(env)}`).toBe(2);
        expect(h.createEngine).not.toHaveBeenCalled();
      }
    }
  });

  it('`-c <missing file>` is exit 2 for every command, verify-run included', async () => {
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_NOT_FOUND', 'no such config file');
    });
    const verifyRun = vi.fn(async () => ({ ok: true, problems: [] }));
    for (const argv of [['status'], ['compile'], ['run'], ['show'], ['prune'], ['doctor'], ['verify-run', 'r']]) {
      const h = await runCli(['-c', 'nope.mjs', ...argv], { env: FAKE_ENV, deps: { loadConfig, verifyRun } });
      expect(h.code, argv.join(' ')).toBe(2);
      expect(verifyRun).not.toHaveBeenCalled();
    }
  });

  it('verify-run still falls back to the standalone SDK function when there is no default config', async () => {
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_NOT_FOUND', 'none');
    });
    const verifyRun = vi.fn(async () => ({ ok: true, problems: [] }));
    const h = await runCli(['verify-run', 'r'], { deps: { loadConfig, verifyRun } });
    expect(h.code).toBe(0);
    expect(verifyRun).toHaveBeenCalledWith('/proj/r');
  });
});

// ───────────────────────── spawned bin against real config files

const projects: string[] = [];
afterAll(() => {
  for (const d of projects) rmSync(d, { recursive: true, force: true });
});

/** A throw-away copy of the corpus: the real config, one doc and the deterministic model rules. */
function makeProject(doc = 'billing'): { dir: string; rulesDir: string } {
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'p-'));
  projects.push(dir);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  cpSync(join(corpus, 'ai-bdd.config.mjs'), join(dir, 'ai-bdd.config.mjs'));
  cpSync(join(corpus, 'docs', `${doc}.md`), join(dir, 'docs', `${doc}.md`));
  const rulesDir = join(dir, '.rules');
  mkdirSync(rulesDir, { recursive: true });
  for (const f of readdirSync(join(corpus, 'fake-model')).filter((n) => n.endsWith('.json'))) cpSync(join(corpus, 'fake-model', f), join(rulesDir, f));
  return { dir, rulesDir };
}

function spawnCli(cwd: string, args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'CI' && !k.startsWith('AI_BDD_')) base[k] = v;
  return spawnSync(process.execPath, ['--conditions=source', bin, ...args], { cwd, encoding: 'utf8', env: { ...base, NODE_NO_WARNINGS: '1', ...env }, timeout: 120_000 });
}

const out = (r: SpawnSyncReturns<string>): string => `exit ${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

describe('spawned bin: configs choose the drivers and models', { timeout: 120_000 }, () => {
  it('AI_BDD_FAKE* in the environment does not activate any test double: the real config is what gets loaded', () => {
    const { dir } = makeProject();
    // The real corpus config registers the Playwright driver and AI SDK models. With the fake variables set, `status` (no model
    // calls) must print no banner and must load that config, not a fake one.
    const r = spawnCli(dir, ['status', '--json'], { ...FAKE_ENV, AI_BDD_FAKE_RULES: join(dir, '.rules'), AI_BDD_FAKE_LOG: join(dir, 'calls.jsonl') });
    expect(r.stderr, out(r)).not.toMatch(/fake/i);
    expect(r.stdout, out(r)).not.toMatch(/fake/i);
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false);
    const doctor = spawnCli(dir, ['doctor', '--offline'], FAKE_ENV);
    expect(doctor.stdout + doctor.stderr).not.toMatch(/FAKE models\/driver/);
  });

  it('with AI_BDD_FAKE=1 and no config file the CLI still exits 2 with CONFIG_NOT_FOUND', () => {
    mkdirSync(workRoot, { recursive: true });
    const dir = mkdtempSync(join(workRoot, 'empty-'));
    projects.push(dir);
    const r = spawnCli(dir, ['status'], FAKE_ENV);
    expect(r.status, out(r)).toBe(2);
    expect(r.stderr).toContain('CONFIG_NOT_FOUND');
    expect(r.stderr).not.toMatch(/FAKE models/);
  });

  it('`-c <missing file>` exits 2 through the real process (also for verify-run)', () => {
    const { dir } = makeProject();
    for (const args of [['status'], ['compile'], ['run'], ['verify-run', '.ai-bdd/runs/none']]) {
      const r = spawnCli(dir, ['-c', 'does-not-exist.mjs', ...args]);
      expect(r.status, `${args.join(' ')}\n${out(r)}`).toBe(2);
      expect(r.stderr).toContain('CONFIG_NOT_FOUND');
    }
  });

  it('`-c <config registering fakeDriver/createFakeModels>` compiles and runs the corpus end to end', () => {
    const { dir, rulesDir } = makeProject('billing');
    const logPath = join(dir, 'fake-calls.jsonl');
    const config = writeTestConfig({
      projectDir: dir,
      rulesDir,
      logPath,
      overrides: { characterize: { probeMs: 100 }, settle: { quietMs: 100, intervalMs: 30, timeoutMs: 5000 } },
    });
    expect(existsSync(config)).toBe(true);

    const compile = spawnCli(dir, ['-c', config, 'compile', 'docs/billing.md']);
    expect(compile.status, out(compile)).toBe(0);
    expect(compile.stderr).not.toMatch(/FAKE models/);
    expect(existsSync(join(dir, '.ai-bdd', 'plans'))).toBe(true);
    expect(readdirSync(join(dir, '.ai-bdd', 'plans')).length).toBeGreaterThan(0);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8').length).toBeGreaterThan(0);

    const status = spawnCli(dir, ['-c', config, 'status', '--json']);
    expect(status.status, out(status)).toBe(0);

    const run = spawnCli(dir, ['-c', config, 'run', '--no-compile', '--reporter', 'json']);
    expect(run.status, out(run)).toBe(0);
    expect(readdirSync(join(dir, '.ai-bdd', 'runs')).length).toBe(1);
  });

  it('the generated test config selects the fake driver; `--driver` naming an unregistered driver is rejected', () => {
    const { dir, rulesDir } = makeProject('billing');
    const config = writeTestConfig({ projectDir: dir, rulesDir });
    expect(spawnCli(dir, ['-c', config, 'compile', 'docs/billing.md']).status).toBe(0);
    const r = spawnCli(dir, ['-c', config, 'run', '--no-compile', '--driver', 'web']);
    expect(r.status, out(r)).not.toBe(0);
  });
});
