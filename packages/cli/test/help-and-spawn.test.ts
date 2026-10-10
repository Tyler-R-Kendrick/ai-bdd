import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseReporters, parseWorkers, splitList } from '../src/parse.ts';
import { runCli } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'src', 'bin.ts');

/** Compares against test/fixtures/<name>.txt; `UPDATE_SNAPSHOTS=1` rewrites the fixture. */
async function expectFixture(name: string, actual: string): Promise<void> {
  const file = join(here, 'fixtures', `${name}.txt`);
  if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(file)) {
    if (process.env['CI'] && !process.env['UPDATE_SNAPSHOTS']) throw new Error(`missing fixture ${file}`);
    await writeFile(file, actual);
  }
  expect(actual).toBe(await readFile(file, 'utf8'));
}

describe('--help snapshots (G8)', () => {
  it('G8: top-level help lists every command', async () => {
    const h = await runCli(['--help']);
    expect(h.code).toBe(0);
    for (const c of ['init', 'compile', 'status', 'show', 'review', 'run', 'verify-run', 'prune', 'doctor']) expect(h.stdout).toMatch(new RegExp(`^  ${c}[ \\n]`, 'm'));
    await expectFixture('help', h.stdout);
  });

  it.each(['init', 'compile', 'status', 'show', 'review', 'run', 'verify-run', 'prune', 'doctor'])('G8: `%s --help` snapshot', async (cmd) => {
    const h = await runCli([cmd, '--help']);
    expect(h.code).toBe(0);
    await expectFixture(`help-${cmd}`, h.stdout);
  });

  it('G8: run --help documents every flag of the spec', async () => {
    const h = await runCli(['run', '--help']);
    for (const f of ['--tag', '--grep', '--driver', '--frozen', '--no-compile', '--strict', '-u, --update-recordings', '--no-agent', '--audit', '--workers', '--reporter']) {
      expect(h.stdout).toContain(f);
    }
  });
});

describe('argument parsing helpers (G8)', () => {
  it.each([
    [undefined, []],
    [[], []],
    [['a'], ['a']],
    [['a,b'], ['a', 'b']],
    [['a, b', 'c', 'a'], ['a', 'b', 'c']],
    [[',,'], []],
  ] as [string[] | undefined, string[]][])('splitList(%j) = %j', (input, expected) => {
    expect(splitList(input)).toEqual(expected);
  });

  it.each([['1', 1], ['8', 8], [' 12 ', 12]] as [string, number][])('parseWorkers(%j) = %i', (input, n) => {
    expect(parseWorkers(input)).toBe(n);
  });
  it.each(['0', '-1', '1.5', 'x', '', '1e3'])('parseWorkers(%j) throws USAGE', (input) => {
    expect(() => parseWorkers(input)).toThrow(/positive integer/);
  });

  it('parseReporters validates names and flattens comma lists', () => {
    expect(parseReporters(['json,junit', 'markdown'])).toEqual(['json', 'junit', 'markdown']);
    expect(parseReporters(undefined)).toEqual([]);
    expect(() => parseReporters(['xml'])).toThrow(/Unknown reporter "xml"/);
  });

  it('--config / -c is forwarded to loadConfig as an absolute path', async () => {
    const a = await runCli(['status', '--config', 'conf/my.json'], { cwd: '/w' });
    expect(a.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/w', configPath: '/w/conf/my.json' }));
    const b = await runCli(['-c', '/abs/c.json', 'status']);
    expect(b.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ configPath: '/abs/c.json' }));
    const c = await runCli(['status']);
    expect((c.loadConfig.mock.calls[0]?.[0] as Record<string, unknown>)['configPath']).toBeUndefined();
  });

  it('passes the injected env and cwd to loadConfig', async () => {
    const h = await runCli(['status'], { env: { FOO: 'bar' }, cwd: '/somewhere' });
    expect(h.loadConfig).toHaveBeenCalledWith({ cwd: '/somewhere', env: { FOO: 'bar' } });
  });
});

describe('spawned bin (V1)', () => {
  const node = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--conditions=source', bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: '', AI_BDD_FAKE: '', ...env }, timeout: 60_000 });

  it('V1: `node --conditions=source packages/cli/src/bin.ts --help` prints usage and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-bdd-spawn-'));
    try {
      const r = node(['--help'], dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: ai-bdd [options] [command]');
      expect(r.stdout).toContain('verify-run <runDir>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('R-RN3: a usage error exits 2 through the real process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-bdd-spawn-'));
    try {
      const r = node(['frobnicate'], dir);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("unknown command 'frobnicate'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('R-RN3: a project without a config exits 2 with CONFIG_NOT_FOUND', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-bdd-spawn-'));
    try {
      const r = node(['status'], dir);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('CONFIG_NOT_FOUND');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('G8: `init` through the real process writes the project files; a second init skips them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-bdd-spawn-'));
    try {
      const first = node(['init', '--json'], dir);
      expect(first.status).toBe(0);
      expect(existsSync(join(dir, 'ai-bdd.config.json'))).toBe(true);
      expect(existsSync(join(dir, 'docs', 'example.md'))).toBe(true);
      await writeFile(join(dir, 'docs', 'example.md'), 'edited');
      const second = node(['init', '--json'], dir);
      expect(second.status).toBe(0);
      expect(await readFile(join(dir, 'docs', 'example.md'), 'utf8')).toBe('edited');
      await mkdir(join(dir, 'x'), { recursive: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
