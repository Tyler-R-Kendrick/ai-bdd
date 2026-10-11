import { describe, expect, it, vi } from 'vitest';
import { AiBddError, ERROR_CODES, type ExitCode } from '@ai-bdd/sdk/contracts';
import { EXIT_BY_ERROR_CODE, exitCodeForError } from '../src/exit.ts';
import { makeReport, runCli } from './helpers.ts';

const runOf = (h: Awaited<ReturnType<typeof runCli>>) => (h.engine.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

describe('run: argument parsing table (G8)', () => {
  const cases: [string, string[], Record<string, unknown>][] = [
    ['no flags', ['run'], { frozen: false, compile: true, strict: false, updateRecordings: false, noAgent: false, audit: false }],
    ['selectors', ['run', 'a/b', 'docs/*.md'], { selectors: ['a/b', 'docs/*.md'] }],
    ['--tag comma list', ['run', '--tag', 'a,b'], { tags: ['a', 'b'] }],
    ['--tag repeated + comma', ['run', '--tag', 'a', '--tag', 'b,c'], { tags: ['a', 'b', 'c'] }],
    ['--tag before selectors keeps selectors', ['run', '--tag', 'smoke', 'billing--'], { tags: ['smoke'], selectors: ['billing--'] }],
    ['--grep', ['run', '--grep', 'Upgrade'], { grep: 'Upgrade' }],
    ['--driver', ['run', '--driver', 'fake'], { driver: 'fake' }],
    ['--frozen', ['run', '--frozen'], { frozen: true, compile: false }],
    ['--no-compile', ['run', '--no-compile'], { frozen: false, compile: false }],
    ['--strict', ['run', '--strict'], { strict: true }],
    ['-u', ['run', '-u'], { updateRecordings: true }],
    ['--update-recordings', ['run', '--update-recordings'], { updateRecordings: true }],
    ['--no-agent', ['run', '--no-agent'], { noAgent: true }],
    ['--audit', ['run', '--audit'], { audit: true }],
    ['--workers', ['run', '--workers', '8'], { workers: 8 }],
    ['--reporter repeated', ['run', '--reporter', 'json', '--reporter', 'junit'], { reporters: ['json', 'junit'] }],
    ['--reporter comma', ['run', '--reporter', 'json,markdown'], { reporters: ['json', 'markdown'] }],
  ];
  it.each(cases)('R-RN3: %s', async (_name, argv, expected) => {
    const h = await runCli(argv);
    expect(h.code).toBe(0);
    expect(runOf(h)).toMatchObject(expected);
  });

  it('omits optional options that were not given', async () => {
    const h = await runCli(['run']);
    const o = runOf(h);
    for (const k of ['selectors', 'tags', 'grep', 'driver', 'workers', 'reporters', 'signal']) expect(o).not.toHaveProperty(k);
  });

  it('forwards the SIGINT abort signal from deps', async () => {
    const ac = new AbortController();
    const h = await runCli(['run'], { deps: { signal: ac.signal } });
    expect(runOf(h).signal).toBe(ac.signal);
  });

  const bad: [string, string[]][] = [
    ['--workers 0', ['run', '--workers', '0']],
    ['--workers abc', ['run', '--workers', 'abc']],
    ['--workers -2', ['run', '--workers=-2']],
    ['unknown reporter', ['run', '--reporter', 'html']],
    ['unknown option', ['run', '--bogus']],
    ['missing option value', ['run', '--grep']],
  ];
  it.each(bad)('R-RN3: %s is a usage error (exit 2) and nothing runs', async (_n, argv) => {
    const h = await runCli(argv);
    expect(h.code).toBe(2);
    expect(h.engine.run).not.toHaveBeenCalled();
  });
});

describe('run: CI defaults (R-RN4)', () => {
  it('R-RN4: CI=1 defaults run to --frozen and never compiles', async () => {
    const h = await runCli(['run'], { env: { CI: '1' } });
    expect(runOf(h)).toMatchObject({ frozen: true, compile: false });
  });

  it('R-RN4: CI=true is recognized too', async () => {
    const h = await runCli(['run'], { env: { CI: 'true' } });
    expect(runOf(h)).toMatchObject({ frozen: true });
  });

  it('R-RN4: CI unset or other values leave --frozen off and compile on', async () => {
    for (const env of [{}, { CI: '0' }, { CI: 'false' }, { CI: '' }]) {
      const h = await runCli(['run'], { env });
      expect(runOf(h)).toMatchObject({ frozen: false, compile: true });
    }
  });

  it('R-RN4: CI adds no implicit --strict', async () => {
    const h = await runCli(['run'], { env: { CI: '1' } });
    expect(runOf(h)).toMatchObject({ strict: false });
  });

  it('M24 R-CH6 R-RN4: CI=1 run -u fails with RECORDING_READ_ONLY (exit 2) before running anything', async () => {
    const h = await runCli(['run', '-u'], { env: { CI: '1' } });
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('RECORDING_READ_ONLY');
    expect(h.engine.run).not.toHaveBeenCalled();
    expect(h.engine.close).toHaveBeenCalled();
  });

  it('R-CH6 R-RN4: AI_BDD_RECORDINGS=read-write lets -u through in CI', async () => {
    const h = await runCli(['run', '-u'], { env: { CI: '1', AI_BDD_RECORDINGS: 'read-write' }, config: { recordingsMode: 'read-write' } });
    expect(h.code).toBe(0);
    expect(runOf(h)).toMatchObject({ updateRecordings: true, frozen: true });
  });

  it('R-RN4: -u locally (read-write) is allowed', async () => {
    const h = await runCli(['run', '-u']);
    expect(h.code).toBe(0);
    expect(runOf(h)).toMatchObject({ updateRecordings: true });
  });

  it('R-RN4: --frozen locally behaves like the CI default', async () => {
    const h = await runCli(['run', '--frozen']);
    expect(runOf(h)).toMatchObject({ frozen: true, compile: false });
  });

  it('R-RN4: the engine config decides CI when the env hint is absent', async () => {
    const h = await runCli(['run'], { config: { ci: true, recordingsMode: 'read-only' } });
    expect(runOf(h)).toMatchObject({ frozen: true });
  });
});

describe('exit-code matrix (R-RN3)', () => {
  it.each([0, 1, 3, 4] as ExitCode[])('R-RN3: run exits with the report exit code %i', async (exitCode) => {
    const h = await runCli(['run'], { engine: { run: vi.fn(async () => makeReport({ exitCode })) } });
    expect(h.code).toBe(exitCode);
  });

  it('R-RN3: M15 a frozen violation reported by the engine is exit 4 and prints the code', async () => {
    const run = vi.fn(async () => {
      throw new AiBddError('PLAN_STALE', 'docs/billing.md is stale');
    });
    const h = await runCli(['run', '--frozen'], { engine: { run } });
    expect(h.code).toBe(4);
    expect(h.stderr).toContain('ai-bdd: error [PLAN_STALE]: docs/billing.md is stale');
  });

  const expectations: Record<string, ExitCode> = {
    USAGE: 2, CONFIG_INVALID: 2, CONFIG_NOT_FOUND: 2, CONFIG_TS_UNSUPPORTED: 2, SECRET_MISSING: 2, SECRET_TOO_SHORT: 2,
    DOC_READ_FAILED: 2, PLAN_CORRUPT: 2, PLAN_SCHEMA_UNSUPPORTED: 2, SCENARIO_NOT_FOUND: 2, RECORDING_READ_ONLY: 2, POLICY_DENIED: 2,
    PLAN_STALE: 4,
    DRIVER_UNAVAILABLE: 3, DRIVER_ERROR: 3, MODEL_UNAVAILABLE: 3, MODEL_OUTPUT_INVALID: 3, MODEL_NO_RULE: 3, SESSION_LIMIT: 3,
    INTERNAL: 3, NOT_IMPLEMENTED: 3, ABORTED: 3,
    EXTRACT_MODEL_OUTPUT_INVALID: 1, EXTRACT_SECTION_FAILED: 1, CHECK_FAILED: 1, JUDGE_FAILED: 1, FIXTURE_REQUIRED: 1, EVIDENCE_CORRUPT: 1,
  };
  it.each(Object.entries(expectations))('R-RN3: an engine error %s maps to exit %i', async (code, exit) => {
    const run = vi.fn(async () => {
      throw new AiBddError(code as never, 'boom');
    });
    const h = await runCli(['run'], { engine: { run } });
    expect(h.code).toBe(exit);
    expect(h.stderr).toContain(`[${code}]`);
  });

  it('R-RN3: every error code has a mapping onto the five documented exit codes', () => {
    for (const c of ERROR_CODES) expect([0, 1, 2, 3, 4]).toContain(EXIT_BY_ERROR_CODE[c]);
  });

  it('R-RN3: a non-AiBddError is an infrastructure failure (exit 3) and never crashes the CLI', async () => {
    const run = vi.fn(async () => {
      throw new TypeError('kaput');
    });
    const h = await runCli(['run'], { engine: { run } });
    expect(h.code).toBe(3);
    expect(h.stderr).toContain('ai-bdd: internal error: kaput');
    expect(exitCodeForError('string thrown')).toBe(3);
  });

  it('R-RN3: errors from loadConfig are mapped before any engine exists', async () => {
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_INVALID', 'bad key');
    });
    const h = await runCli(['status'], { deps: { loadConfig } });
    expect(h.code).toBe(2);
    expect(h.createEngine).not.toHaveBeenCalled();
  });

  it('R-RN3: errors from createEngine (e.g. driver unavailable) map to 3', async () => {
    const createEngine = vi.fn(async () => {
      throw new AiBddError('DRIVER_UNAVAILABLE', 'no browser');
    });
    const h = await runCli(['run'], { deps: { createEngine } });
    expect(h.code).toBe(3);
  });

  it('R-RN3: the engine is closed even when the command throws', async () => {
    const h = await runCli(['run'], { engine: { run: vi.fn(async () => { throw new AiBddError('MODEL_UNAVAILABLE', 'down'); }) } });
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('R-RN3: usage errors from commander (unknown command, missing argument) are exit 2', async () => {
    expect((await runCli(['frobnicate'])).code).toBe(2);
    expect((await runCli(['review', 'accept'])).code).toBe(2);
    expect((await runCli(['verify-run'])).code).toBe(2);
    expect((await runCli([])).code).toBe(2);
  });

  it('R-RN3: --help and --version exit 0', async () => {
    expect((await runCli(['--help'])).code).toBe(0);
    expect((await runCli(['run', '--help'])).code).toBe(0);
    const v = await runCli(['--version']);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('secrets are never printed (R-SE1)', () => {
  it('R-SE1: secret values known from config.secrets are scrubbed from all output', async () => {
    const report = makeReport({
      exitCode: 1,
      scenarios: [{
        scenarioId: 's', featureId: 'f', docUri: 'd', title: 't', driver: 'web', status: 'error', mode: 'replay', review: 'accepted',
        steps: [], recording: 'none', usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 }, durationMs: 1,
        error: { code: 'DRIVER_ERROR', message: 'typed hunter2-secret-value into the field', retryable: false },
      }],
    });
    const h = await runCli(['run'], {
      env: { ADMIN_PASSWORD: 'hunter2-secret-value' },
      config: { secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } } },
      engine: { run: vi.fn(async () => report) },
    });
    expect(h.stdout).not.toContain('hunter2-secret-value');
    expect(h.stdout).toContain('typed [redacted] into the field');
  });
});
