import { describe, expect, it, vi } from 'vitest';
import { AiBddError, type Engine } from '@ai-bdd/sdk/contracts';
import { checkNode } from '../src/commands/doctor.ts';
import { runCli } from './helpers.ts';

type DoctorReport = Awaited<ReturnType<Engine['doctor']>>;
const NODE_OK = { nodeVersion: '22.22.0' };
const report = (checks: DoctorReport['checks']): DoctorReport => ({ ok: checks.every((c) => c.ok), checks });
const doctorReturning = (checks: DoctorReport['checks']) => ({ doctor: vi.fn(async () => report(checks)) });
const lines = (stdout: string) => stdout.split('\n').filter((l) => l !== '');

describe('doctor: checkNode', () => {
  it.each([
    ['22.18.0', true],
    ['22.18.1', true],
    ['22.22.0', true],
    ['22.100.0', true],
    ['23.0.0', true],
    ['24.1.2', true],
    ['30.0.0', true],
    ['22.17.9', false],
    ['22.0.0', false],
    ['22', false],
    ['21.99.99', false],
    ['20.11.1', false],
    ['18.0.0', false],
    ['', false],
    ['not-a-version', false],
  ])('Node %j is %s', (version, ok) => {
    expect(checkNode(version).ok).toBe(ok);
  });

  it('names the check "node" and states the requirement only on failure', () => {
    expect(checkNode('22.22.0')).toEqual({ name: 'node', ok: true, detail: 'Node 22.22.0' });
    expect(checkNode('20.11.1')).toEqual({ name: 'node', ok: false, detail: 'Node 20.11.1 is too old; ai-bdd needs >= 22.18' });
  });
});

describe('doctor: report', () => {
  it('prints our node and config checks when the engine reports neither, then every engine check in order, then the verdict', async () => {
    const h = await runCli(['doctor'], {
      config: { configPath: '/proj/ai-bdd.config.ts' },
      engine: doctorReturning([
        { name: 'driver:web', ok: true, detail: 'playwright 1.2.3' },
        { name: 'model:extract', ok: true, detail: 'reachable' },
      ]),
      deps: NODE_OK,
    });
    expect(h.code).toBe(0);
    expect(h.stderr).toBe('');
    expect(lines(h.stdout)).toEqual([
      '[ok]   node: Node 22.22.0',
      '[ok]   config: /proj/ai-bdd.config.ts',
      '[ok]   driver:web: playwright 1.2.3',
      '[ok]   model:extract: reachable',
      'All checks passed.',
    ]);
    expect(h.engine.doctor).toHaveBeenCalledWith({ offline: false });
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('says "defaults (no config file)" when the resolved config has no file', async () => {
    const h = await runCli(['doctor'], { deps: NODE_OK, engine: doctorReturning([]) });
    expect(h.stdout).toContain('[ok]   config: defaults (no config file)\n');
  });

  it('--offline is forwarded to the engine and noted in the output, also when checks fail', async () => {
    const h = await runCli(['doctor', '--offline'], {
      engine: doctorReturning([{ name: 'driver:web', ok: false, detail: 'missing' }]),
      deps: NODE_OK,
    });
    expect(h.engine.doctor).toHaveBeenCalledWith({ offline: true });
    expect(lines(h.stdout).slice(-3)).toEqual(['[FAIL] driver:web: missing', '(model reachability skipped: --offline)', '1 check(s) failed.']);
    expect(h.code).toBe(1);
    const online = await runCli(['doctor'], { engine: doctorReturning([]), deps: NODE_OK });
    expect(online.stdout).not.toContain('--offline');
  });

  it('every failing check is listed and counted; the exit code is 1', async () => {
    const h = await runCli(['doctor'], {
      engine: doctorReturning([
        { name: 'driver:web', ok: false, detail: 'playwright is not installed' },
        { name: 'model:act', ok: false, detail: 'no API key (set OPENAI_API_KEY)' },
        { name: 'model:judge', ok: true, detail: 'reachable' },
        { name: 'plans', ok: false, detail: '2 stale' },
      ]),
      deps: NODE_OK,
    });
    expect(h.code).toBe(1);
    expect(lines(h.stdout)).toEqual([
      '[ok]   node: Node 22.22.0',
      '[ok]   config: defaults (no config file)',
      '[FAIL] driver:web: playwright is not installed',
      '[FAIL] model:act: no API key (set OPENAI_API_KEY)',
      '[ok]   model:judge: reachable',
      '[FAIL] plans: 2 stale',
      '3 check(s) failed.',
    ]);
  });

  it('an engine "node" check replaces ours in place (ours is only a fallback), keeping our config check first', async () => {
    const h = await runCli(['doctor'], {
      config: { configPath: '/proj/c.json' },
      engine: doctorReturning([{ name: 'node', ok: true, detail: 'engine says fine' }, { name: 'plans', ok: true, detail: 'fresh' }]),
      deps: { nodeVersion: '18.0.0' },
    });
    // the engine's verdict is authoritative, so an old injected version does not fail the run
    expect(h.code).toBe(0);
    expect(lines(h.stdout)).toEqual([
      '[ok]   config: /proj/c.json',
      '[ok]   node: engine says fine',
      '[ok]   plans: fresh',
      'All checks passed.',
    ]);
  });

  it('an engine "config" check replaces ours', async () => {
    const h = await runCli(['doctor'], {
      config: { configPath: '/proj/c.json' },
      engine: doctorReturning([{ name: 'config', ok: false, detail: 'engine config problem' }]),
      deps: NODE_OK,
    });
    expect(lines(h.stdout)).toEqual(['[ok]   node: Node 22.22.0', '[FAIL] config: engine config problem', '1 check(s) failed.']);
    expect(h.code).toBe(1);
  });

  it('our node check fails the run (exit 1) on an old Node when the engine does not report node', async () => {
    const h = await runCli(['doctor'], { deps: { nodeVersion: '20.11.1' }, engine: doctorReturning([]) });
    expect(h.code).toBe(1);
    expect(lines(h.stdout)).toEqual([
      '[FAIL] node: Node 20.11.1 is too old; ai-bdd needs >= 22.18',
      '[ok]   config: defaults (no config file)',
      '1 check(s) failed.',
    ]);
  });

  it('defaults the Node version to the running process', async () => {
    const h = await runCli(['doctor'], { engine: doctorReturning([]) });
    expect(h.stdout).toContain(`Node ${process.versions.node}`);
  });
});

describe('doctor: failures while loading the config', () => {
  const failing = (e: unknown) => ({ loadConfig: vi.fn(async () => { throw e; }), ...NODE_OK });

  it('an AiBddError becomes a failed config check carrying code and message; its exit code is kept (CONFIG_INVALID = 2)', async () => {
    const h = await runCli(['doctor'], { deps: failing(new AiBddError('CONFIG_INVALID', 'unknown key "foo"')) });
    expect(h.code).toBe(2);
    expect(lines(h.stdout)).toEqual([
      '[ok]   node: Node 22.22.0',
      '[FAIL] config: [CONFIG_INVALID] unknown key "foo"',
      '1 check(s) failed.',
    ]);
    expect(h.stderr).toBe('');
    expect(h.createEngine).not.toHaveBeenCalled();
  });

  it('a missing config file is CONFIG_NOT_FOUND, exit 2', async () => {
    const h = await runCli(['doctor'], { deps: failing(new AiBddError('CONFIG_NOT_FOUND', 'no config in /x')) });
    expect(h.code).toBe(2);
    expect(h.stdout).toContain('[FAIL] config: [CONFIG_NOT_FOUND] no config in /x\n');
  });

  it('a missing secret reported while loading is exit 2 as well', async () => {
    const h = await runCli(['doctor'], { deps: failing(new AiBddError('SECRET_MISSING', 'OPENAI_API_KEY is not set')) });
    expect(h.code).toBe(2);
    expect(h.stdout).toContain('[FAIL] config: [SECRET_MISSING] OPENAI_API_KEY is not set\n');
  });

  it('an unexpected Error becomes the check detail, exit 3', async () => {
    const h = await runCli(['doctor'], { deps: failing(new TypeError('import failed')) });
    expect(h.code).toBe(3);
    expect(h.stdout).toContain('[FAIL] config: import failed\n');
    expect(h.stdout).toContain('1 check(s) failed.');
  });

  it('a thrown non-Error is stringified, exit 3', async () => {
    const h = await runCli(['doctor'], { deps: failing('weird failure') });
    expect(h.code).toBe(3);
    expect(h.stdout).toContain('[FAIL] config: weird failure\n');
  });

  it('createEngine failing (e.g. missing model package) is reported the same way', async () => {
    const createEngine = vi.fn(async () => { throw new AiBddError('MODEL_UNAVAILABLE', 'cannot import @ai-bdd/models-ai-sdk'); });
    const h = await runCli(['doctor'], { deps: { createEngine, ...NODE_OK } });
    expect(h.code).toBe(3);
    expect(h.stdout).toContain('[FAIL] config: [MODEL_UNAVAILABLE] cannot import @ai-bdd/models-ai-sdk\n');
    expect(h.engine.doctor).not.toHaveBeenCalled();
  });

  it('a node failure plus a config failure counts both', async () => {
    const h = await runCli(['doctor'], { deps: { ...failing(new AiBddError('CONFIG_INVALID', 'bad')), nodeVersion: '20.0.0' } });
    expect(h.code).toBe(2);
    expect(h.stdout).toContain('2 check(s) failed.');
  });
});

describe('doctor: failures inside engine.doctor()', () => {
  const throwing = (e: unknown) => ({ doctor: vi.fn(async () => { throw e; }) });

  it('an AiBddError becomes a failed "doctor" check; exit code from the error (MODEL_UNAVAILABLE = 3); engine closed; our checks stay', async () => {
    const h = await runCli(['doctor'], { engine: throwing(new AiBddError('MODEL_UNAVAILABLE', 'extract model is unreachable')), deps: NODE_OK });
    expect(h.code).toBe(3);
    expect(lines(h.stdout)).toEqual([
      '[ok]   node: Node 22.22.0',
      '[ok]   config: defaults (no config file)',
      '[FAIL] doctor: [MODEL_UNAVAILABLE] extract model is unreachable',
      '1 check(s) failed.',
    ]);
    expect(h.engine.close).toHaveBeenCalledOnce();
  });

  it('a usage-class error keeps its own exit code', async () => {
    const h = await runCli(['doctor'], { engine: throwing(new AiBddError('POLICY_DENIED', 'host denied')), deps: NODE_OK });
    expect(h.code).toBe(2);
    expect(h.stdout).toContain('[FAIL] doctor: [POLICY_DENIED] host denied\n');
  });

  it('an unexpected Error becomes the check detail, exit 3', async () => {
    const h = await runCli(['doctor'], { engine: throwing(new Error('socket closed')), deps: NODE_OK });
    expect(h.code).toBe(3);
    expect(h.stdout).toContain('[FAIL] doctor: socket closed\n');
  });

  it('a thrown non-Error is stringified, exit 3', async () => {
    const h = await runCli(['doctor'], { engine: throwing(404), deps: NODE_OK });
    expect(h.code).toBe(3);
    expect(h.stdout).toContain('[FAIL] doctor: 404\n');
  });

  it('a failing close does not hide the report or change the exit code', async () => {
    const h = await runCli(['doctor'], {
      engine: { ...doctorReturning([{ name: 'plans', ok: true, detail: 'fresh' }]), close: vi.fn(async () => { throw new Error('close failed'); }) },
      deps: NODE_OK,
    });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('All checks passed.');
    expect(h.stderr).toBe('');
  });
});
