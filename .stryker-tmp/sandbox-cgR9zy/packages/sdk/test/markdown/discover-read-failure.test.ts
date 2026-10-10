// @ts-nocheck
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBddError, type ResolvedConfig } from '../../src/contracts/index.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (String(path).endsWith('unreadable.md')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

const { discoverDocs } = await import('../../src/markdown/index.ts');

let root = '';

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('discoverDocs read failures', () => {
  it('R-PL4: a document that cannot be read is DOC_READ_FAILED and names the file', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-bdd-md-fail-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/ok.md'), '# ok\n');
    await writeFile(join(root, 'docs/unreadable.md'), '# nope\n');
    const config = { projectRoot: root, docs: ['docs/**/*.md'], exclude: [] } as unknown as ResolvedConfig;
    const err = await discoverDocs(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('DOC_READ_FAILED');
    expect((err as AiBddError).message).toContain('docs/unreadable.md');
    expect((err as AiBddError).details).toEqual({ uri: 'docs/unreadable.md' });
  });
});
