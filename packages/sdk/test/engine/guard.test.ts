import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBddError, type ResolvedConfig } from '../../src/contracts/index.ts';
import { assertOutputDirs } from '../../src/engine/guard.ts';

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ai-bdd-guard-'));
  outside = mkdtempSync(join(tmpdir(), 'ai-bdd-guard-outside-'));
  mkdirSync(join(root, '.ai-bdd'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    projectRoot: root,
    planDir: join(root, '.ai-bdd', 'plans'),
    recordingsDir: join(root, '.ai-bdd', 'recordings'),
    runsDir: join(root, '.ai-bdd', 'runs'),
    cacheDir: join(root, '.ai-bdd', 'cache'),
    recordingsMode: 'read-write',
    ...over,
  } as ResolvedConfig;
}

async function failure(p: Promise<unknown>): Promise<AiBddError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AiBddError);
    return err as AiBddError;
  }
  throw new Error('expected a rejection');
}

describe('assertOutputDirs', () => {
  it('accepts directories that do not exist yet and directories that do', async () => {
    await expect(assertOutputDirs(config(), ['plans', 'recordings', 'runs', 'cache'])).resolves.toBeUndefined();
    mkdirSync(join(root, '.ai-bdd', 'plans'));
    mkdirSync(join(root, '.ai-bdd', 'runs'));
    await expect(assertOutputDirs(config(), ['plans', 'runs'])).resolves.toBeUndefined();
  });

  it('a file where a directory belongs is CONFIG_INVALID and names the directory', async () => {
    writeFileSync(join(root, '.ai-bdd', 'plans'), 'x');
    const err = await failure(assertOutputDirs(config(), ['plans']));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toMatch(/plans directory .*\.ai-bdd\/plans exists but is not a directory/);
    expect(err.details).toMatchObject({ kind: 'plans' });
  });

  it('a file where a PARENT directory belongs is CONFIG_INVALID, without a raw errno in the message', async () => {
    rmSync(join(root, '.ai-bdd'), { recursive: true });
    writeFileSync(join(root, '.ai-bdd'), 'x');
    const err = await failure(assertOutputDirs(config(), ['recordings']));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('a parent of it is not a directory');
    expect(err.message).not.toMatch(/ENOTDIR/);
  });

  it('a symlink loop is CONFIG_INVALID', async () => {
    symlinkSync(join(root, '.ai-bdd', 'runs.b'), join(root, '.ai-bdd', 'runs'));
    symlinkSync(join(root, '.ai-bdd', 'runs'), join(root, '.ai-bdd', 'runs.b'));
    const err = await failure(assertOutputDirs(config(), ['runs']));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('symlink loop');
    expect(err.message).not.toMatch(/ELOOP/);
  });

  it('a symlink that leaves the project is POLICY_DENIED (for every kind)', async () => {
    for (const [name, kind] of [['plans', 'plans'], ['recordings', 'recordings'], ['runs', 'runs'], ['cache', 'cache']] as const) {
      symlinkSync(outside, join(root, '.ai-bdd', name));
      const err = await failure(assertOutputDirs(config(), [kind]));
      expect(err.code, kind).toBe('POLICY_DENIED');
      expect(err.message).toContain(name);
    }
  });

  it('only the requested kinds are checked, and recordings are not checked when recordings are off', async () => {
    writeFileSync(join(root, '.ai-bdd', 'cache'), 'x');
    await expect(assertOutputDirs(config(), ['plans', 'runs'])).resolves.toBeUndefined();
    writeFileSync(join(root, '.ai-bdd', 'recordings'), 'x');
    await expect(assertOutputDirs(config({ recordingsMode: 'off' }), ['recordings'])).resolves.toBeUndefined();
    await expect(assertOutputDirs(config(), ['recordings'])).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('a directory outside any .ai-bdd path is not subject to the project-root rule (a configured absolute path is the user\'s choice)', async () => {
    await expect(assertOutputDirs(config({ planDir: join(outside, 'plans') }), ['plans'])).resolves.toBeUndefined();
  });
});
