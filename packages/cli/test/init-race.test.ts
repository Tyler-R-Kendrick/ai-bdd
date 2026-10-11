import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './helpers.ts';

/** Lets a test run code right before `writeFile` of a given path, to simulate another process creating the file first. */
const hook = vi.hoisted(() => ({
  before: undefined as undefined | ((path: string) => Promise<void>),
  realWriteFile: undefined as unknown as (path: string, data: string) => Promise<void>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  hook.realWriteFile = (path, data) => actual.writeFile(path, data);
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await hook.before?.(String(args[0]));
      return actual.writeFile(...args);
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-bdd-init-race-'));
});
afterEach(async () => {
  hook.before = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('init: a file appearing between the existence check and the write', () => {
  it('exclusive create wins the race for the other process: its content is kept and the file is reported skipped', async () => {
    hook.before = async (path) => {
      if (path === join(dir, 'docs', 'example.md')) await hook.realWriteFile(path, 'WRITTEN BY A CONCURRENT INIT');
    };
    const h = await runCli(['init'], { cwd: dir });
    expect(h.code).toBe(0);
    expect(await readFile(join(dir, 'docs/example.md'), 'utf8')).toBe('WRITTEN BY A CONCURRENT INIT');
    expect(h.stdout).toContain('skipped  docs/example.md (already exists; use --yes to overwrite)');
    // the rest of init still completed
    expect(h.stdout).toContain('created  ai-bdd.config.ts');
    expect(h.stdout).toContain('created  .ai-bdd/plans/');
  });

  it('the same race on the config file reports "skipped" for it', async () => {
    hook.before = async (path) => {
      if (path === join(dir, 'ai-bdd.config.ts')) await hook.realWriteFile(path, 'OTHER CONFIG');
    };
    const h = await runCli(['init'], { cwd: dir });
    expect(h.code).toBe(0);
    expect(await readFile(join(dir, 'ai-bdd.config.ts'), 'utf8')).toBe('OTHER CONFIG');
    expect(h.stdout).toContain('skipped  ai-bdd.config.ts');
    expect(h.stdout).toContain('created  docs/example.md');
  });
});
