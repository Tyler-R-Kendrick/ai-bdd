import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@ai-bdd/sdk';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import {
  createCtx,
  loadResolvedConfig,
  openEngine,
  resolveCreateEngine,
  resolveCreateRecordingStore,
  resolveLoadConfig,
  resolveVerifyRun,
  withEngine,
} from '../src/context.ts';
import { main } from '../src/main.ts';
import type { CliDeps, CliIo } from '../src/types.ts';
import { makeConfig, makeEngine, runCli } from './helpers.ts';

function capture(env: Record<string, string | undefined> = {}, cwd = '/proj') {
  const buf = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: { write: (s: string) => (buf.stdout += s) },
    stderr: { write: (s: string) => (buf.stderr += s) },
    env,
    cwd,
  };
  return { buf, io };
}

describe('createCtx: output and secret scrubbing (R-SE1)', () => {
  it('out and err write one line each to their own stream; a missing line is an empty line', () => {
    const { buf, io } = capture();
    const ctx = createCtx(io, {});
    ctx.out('hello');
    ctx.out();
    ctx.err('oops');
    ctx.err();
    expect(buf.stdout).toBe('hello\n\n');
    expect(buf.stderr).toBe('oops\n\n');
  });

  it('starts with no config path', () => {
    expect(createCtx(capture().io, {}).configPath).toBeUndefined();
  });

  it('scrubs registered secrets from stdout and stderr, every occurrence', () => {
    const { buf, io } = capture();
    const ctx = createCtx(io, {});
    ctx.addSecrets(['s3cr3t-token', 'other-secret']);
    ctx.out('a s3cr3t-token b s3cr3t-token c');
    ctx.err('x other-secret y s3cr3t-token');
    expect(buf.stdout).toBe('a [redacted] b [redacted] c\n');
    expect(buf.stderr).toBe('x [redacted] y [redacted]\n');
  });

  it('ignores undefined values and values shorter than four characters', () => {
    const { buf, io } = capture();
    const ctx = createCtx(io, {});
    ctx.addSecrets([undefined, '', 'abc', '12']);
    ctx.out('abc 12 stays');
    expect(buf.stdout).toBe('abc 12 stays\n');
    // exactly four characters is long enough
    ctx.addSecrets(['abcd']);
    ctx.out('abcd abc');
    expect(buf.stdout).toBe('abc 12 stays\n[redacted] abc\n');
  });

  it('secrets added later apply to later lines only', () => {
    const { buf, io } = capture();
    const ctx = createCtx(io, {});
    ctx.out('token=late-secret');
    ctx.addSecrets(['late-secret']);
    ctx.out('token=late-secret');
    expect(buf.stdout).toBe('token=late-secret\ntoken=[redacted]\n');
  });

  it('a secret containing regex metacharacters is replaced literally', () => {
    const { buf, io } = capture();
    const ctx = createCtx(io, {});
    ctx.addSecrets(['p.*(a)+$']);
    ctx.out('pass p.*(a)+$ and pxxa');
    expect(buf.stdout).toBe('pass [redacted] and pxxa\n');
  });
});

describe('openEngine / withEngine', () => {
  it('registers the values of config.secrets from the injected env, skipping unset and short ones', async () => {
    const config = makeConfig({
      secrets: { a: { env: 'LONG_ONE' }, b: { env: 'UNSET_ONE' }, c: { env: 'SHORT_ONE' } },
    });
    const { buf, io } = capture({ LONG_ONE: 'correct-horse', SHORT_ONE: 'xyz' });
    const ctx = createCtx(io, { loadConfig: async () => config, createEngine: async () => makeEngine(config) });
    await openEngine(ctx);
    ctx.out('correct-horse xyz unset');
    expect(buf.stdout).toBe('[redacted] xyz unset\n');
  });

  it('withEngine returns the callback result and closes the engine exactly once', async () => {
    const config = makeConfig();
    const engine = makeEngine(config);
    const ctx = createCtx(capture().io, { loadConfig: async () => config, createEngine: async () => engine });
    const out = await withEngine(ctx, {}, async (h) => {
      expect(h.engine).toBe(engine);
      expect(h.config).toBe(config);
      return 42;
    });
    expect(out).toBe(42);
    expect(engine.close).toHaveBeenCalledTimes(1);
  });

  it('withEngine closes the engine and rethrows when the callback throws', async () => {
    const config = makeConfig();
    const engine = makeEngine(config);
    const { buf, io } = capture();
    const ctx = createCtx(io, { loadConfig: async () => config, createEngine: async () => engine });
    const boom = new AiBddError('DRIVER_ERROR', 'boom');
    await expect(withEngine(ctx, {}, async () => { throw boom; })).rejects.toBe(boom);
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(buf.stderr).toBe('');
  });

  it('a failing close only warns on stderr and keeps the command result and exit code', async () => {
    const h = await runCli(['status'], {
      engine: { close: vi.fn(async () => { throw new Error('socket hang up'); }) },
    });
    expect(h.code).toBe(0);
    expect(h.stderr).toBe('ai-bdd: warning: engine close failed: socket hang up\n');
    expect(h.stdout).toBe('No documents found.\n');
  });

  it('a non-Error rejection from close is stringified in the warning', async () => {
    const h = await runCli(['status'], { engine: { close: vi.fn(async () => Promise.reject('plain reason')) } });
    expect(h.code).toBe(0);
    expect(h.stderr).toBe('ai-bdd: warning: engine close failed: plain reason\n');
  });

  it('a close failure after a command failure keeps the command error as the exit code', async () => {
    const h = await runCli(['status'], {
      engine: {
        status: vi.fn(async () => { throw new AiBddError('PLAN_CORRUPT', 'bad plan'); }),
        close: vi.fn(async () => { throw new Error('close failed too'); }),
      },
    });
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('ai-bdd: warning: engine close failed: close failed too\n');
    expect(h.stderr).toContain('ai-bdd: error [PLAN_CORRUPT]: bad plan\n');
  });

  it('the close warning is scrubbed of known secrets', async () => {
    const h = await runCli(['status'], {
      env: { API_KEY: 'sk-live-12345' },
      config: { secrets: { key: { env: 'API_KEY' } } },
      engine: { close: vi.fn(async () => { throw new Error('auth sk-live-12345 rejected'); }) },
    });
    expect(h.stderr).toBe('ai-bdd: warning: engine close failed: auth [redacted] rejected\n');
  });
});

describe('loadResolvedConfig: config discovery inputs (§5.2)', () => {
  const run = async (configPath: string | undefined, cwd: string, env: Record<string, string | undefined> = {}) => {
    const loadConfig = vi.fn(async (_opts: unknown) => makeConfig());
    const ctx = createCtx(capture(env, cwd).io, { loadConfig });
    ctx.configPath = configPath;
    await loadResolvedConfig(ctx);
    return loadConfig.mock.calls[0]?.[0];
  };

  it('without --config the loader gets only cwd and env (it does the discovery)', async () => {
    const arg = await run(undefined, '/w', { CI: '1', NO_COLOR: '1', AI_BDD_RECORDINGS: 'read-write' });
    expect(arg).toStrictEqual({ cwd: '/w', env: { CI: '1', NO_COLOR: '1', AI_BDD_RECORDINGS: 'read-write' } });
  });

  it('a relative --config is resolved against the injected cwd, not the process cwd', async () => {
    expect(await run('conf/x.json', '/w')).toStrictEqual({ cwd: '/w', env: {}, configPath: '/w/conf/x.json' });
    expect(await run('../up.json', '/w/sub')).toStrictEqual({ cwd: '/w/sub', env: {}, configPath: '/w/up.json' });
  });

  it('an absolute --config is passed through unchanged', async () => {
    expect(await run('/etc/ai-bdd.json', '/w')).toStrictEqual({ cwd: '/w', env: {}, configPath: '/etc/ai-bdd.json' });
  });

  it('the loader sees the very env object injected into the CLI (CI, AI_BDD_RECORDINGS, NO_COLOR are not interpreted by the CLI)', async () => {
    const env = { CI: 'true', AI_BDD_RECORDINGS: 'read-only', NO_COLOR: '1' };
    const h = await runCli(['status'], { env });
    const arg = h.loadConfig.mock.calls[0]?.[0] as { env: unknown };
    expect(arg.env).toBe(env);
  });

  it('preAction hook sets the config path for the command; -c before the command is honoured, and a missing value is a usage error', async () => {
    const h = await runCli(['-c', 'a.json', 'status'], { cwd: '/w' });
    expect(h.loadConfig).toHaveBeenCalledWith({ cwd: '/w', env: {}, configPath: '/w/a.json' });
    const long = await runCli(['--config=b.json', 'status'], { cwd: '/w' });
    expect(long.loadConfig).toHaveBeenCalledWith({ cwd: '/w', env: {}, configPath: '/w/b.json' });
    const missing = await runCli(['status', '-c']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("error: option '-c, --config <path>' argument missing");
    expect(missing.loadConfig).not.toHaveBeenCalled();
  });
});

describe('lazily resolved SDK defaults', () => {
  it('each resolver returns the injected dependency when there is one', async () => {
    const deps: CliDeps = {
      loadConfig: vi.fn(),
      createEngine: vi.fn(),
      createRecordingStore: vi.fn(),
      verifyRun: vi.fn(),
    };
    expect(await resolveLoadConfig(deps)).toBe(deps.loadConfig);
    expect(await resolveCreateEngine(deps)).toBe(deps.createEngine);
    expect(await resolveCreateRecordingStore(deps)).toBe(deps.createRecordingStore);
    expect(await resolveVerifyRun(deps)).toBe(deps.verifyRun);
  });

  it('each resolver falls back to the public SDK function when nothing is injected', async () => {
    expect(await resolveLoadConfig({})).toBe(sdk.loadConfig);
    expect(await resolveCreateEngine({})).toBe(sdk.createEngine);
    expect(await resolveCreateRecordingStore({})).toBe(sdk.createRecordingStore);
    expect(await resolveVerifyRun({})).toBe(sdk.verifyRun);
  });
});

describe('real SDK loader through main (no injected deps)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-bdd-ctx-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const real = async (argv: string[], env: Record<string, string | undefined> = {}) => {
    const { buf, io } = capture(env, dir);
    const code = await main(argv, io);
    return { code, ...buf };
  };

  it('a project without a config file is CONFIG_NOT_FOUND, exit 2', async () => {
    const r = await real(['status']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^ai-bdd: error \[CONFIG_NOT_FOUND\]: /);
  });

  it('an explicit -c path that does not exist is CONFIG_NOT_FOUND naming the resolved path, exit 2', async () => {
    const r = await real(['-c', 'missing.config.json', 'status']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^ai-bdd: error \[CONFIG_NOT_FOUND\]: /);
    expect(r.stderr).toContain(join(dir, 'missing.config.json'));
  });

  it('an invalid config file is CONFIG_INVALID, exit 2, and the CLI never reaches the engine', async () => {
    await writeFile(join(dir, 'ai-bdd.config.json'), '{ not json');
    const r = await real(['status']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`ai-bdd: error [CONFIG_INVALID]: Cannot parse JSON config "${join(dir, 'ai-bdd.config.json')}"`);
  });

  it('verify-run only falls back to the standalone SDK check for a missing config; a broken config stays exit 2', async () => {
    await writeFile(join(dir, 'ai-bdd.config.json'), '{ not json');
    const r = await real(['verify-run', 'no-such-run']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('ai-bdd: error [CONFIG_INVALID]');
  });

  it('verify-run without a config falls back to the SDK verifyRun and reports a missing run directory as a failure (exit 1)', async () => {
    const r = await real(['verify-run', 'no-such-run']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^FAILED: no-such-run has \d+ problem\(s\):\n/);
  });
});
