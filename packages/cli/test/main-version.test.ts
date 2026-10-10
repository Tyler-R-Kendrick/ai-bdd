import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './helpers.ts';

const fsMock = vi.hoisted(() => ({ read: undefined as undefined | ((...a: unknown[]) => unknown) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => (fsMock.read ? fsMock.read(...args) : (actual.readFileSync as (...a: unknown[]) => unknown)(...args)),
  };
});

beforeEach(() => {
  fsMock.read = undefined;
});

describe('--version: reading the package version', () => {
  it('prints the version field of the CLI package.json', async () => {
    const seen: string[] = [];
    fsMock.read = (path) => {
      seen.push(String(path instanceof URL ? path.pathname : path));
      return JSON.stringify({ name: '@ai-bdd/cli', version: '9.8.7' });
    };
    const h = await runCli(['--version']);
    expect(h.code).toBe(0);
    expect(h.stdout).toBe('9.8.7\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/packages\/cli\/package\.json$/);
  });

  it.each([
    ['an unreadable package.json', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }],
    ['invalid JSON', () => '{ nope'],
    ['a missing version field', () => JSON.stringify({ name: 'x' })],
    ['a non-string version', () => JSON.stringify({ version: 12 })],
  ])('falls back to 0.0.0 for %s', async (_label, read) => {
    fsMock.read = read;
    const h = await runCli(['--version']);
    expect(h.code).toBe(0);
    expect(h.stdout).toBe('0.0.0\n');
    expect(h.stderr).toBe('');
  });
});
