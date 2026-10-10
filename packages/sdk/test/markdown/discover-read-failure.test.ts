import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBddError, type ResolvedConfig } from '../../src/contracts/index.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
      if (String(path).endsWith('vanished.md')) throw Object.assign(new Error('ENOENT: vanished during discovery'), { code: 'ENOENT' });
      if (String(path).endsWith('vanished-string.md')) throw 'plain string failure'; // eslint-disable-line no-throw-literal
      return (actual.realpath as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.realpath,
    readFile: (async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (String(path).endsWith('unreadable-string.md')) throw 'plain string failure'; // eslint-disable-line no-throw-literal
      if (String(path).endsWith('unreadable.md')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

const search = vi.hoisted(() => ({ override: undefined as undefined | ((...a: unknown[]) => Promise<string[]>) }));
vi.mock('tinyglobby', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tinyglobby')>();
  return {
    ...actual,
    glob: ((...args: unknown[]) => (search.override ?? (actual.glob as (...a: unknown[]) => Promise<string[]>))(...args)) as typeof actual.glob,
  };
});

const { discoverDocs } = await import('../../src/markdown/index.ts');

let root = '';

afterEach(async () => {
  search.override = undefined;
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

  it('R-PL4: a document that vanishes between the search and the read is DOC_READ_FAILED with the cause attached', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-bdd-md-fail-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/vanished.md'), '# gone\n');
    const config = { projectRoot: root, docs: ['docs/**/*.md'], exclude: [] } as unknown as ResolvedConfig;
    const err = await discoverDocs(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('DOC_READ_FAILED');
    expect((err as AiBddError).message).toBe('cannot read docs/vanished.md: ENOENT: vanished during discovery');
    expect((err as AiBddError).details).toEqual({ uri: 'docs/vanished.md' });
    expect(((err as AiBddError).cause as { code?: string }).code).toBe('ENOENT');
  });

  it('R-PL4: a non-Error failure while resolving or reading a document is reported by its string form', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-bdd-md-fail-'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/vanished-string.md'), '# gone\n');
    const config = { projectRoot: root, docs: ['docs/**/*.md'], exclude: [] } as unknown as ResolvedConfig;
    const resolveErr = await discoverDocs(config).catch((e: unknown) => e);
    expect((resolveErr as AiBddError).message).toBe('cannot read docs/vanished-string.md: plain string failure');

    await rm(join(root, 'docs/vanished-string.md'));
    await writeFile(join(root, 'docs/unreadable-string.md'), '# nope\n');
    const readErr = await discoverDocs(config).catch((e: unknown) => e);
    expect((readErr as AiBddError).code).toBe('DOC_READ_FAILED');
    expect((readErr as AiBddError).message).toBe('cannot read docs/unreadable-string.md: plain string failure');
  });

  it('R-PL4: a failing glob search is DOC_READ_FAILED with the reason and the cause', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-bdd-md-fail-'));
    const boom = new Error('boom');
    search.override = () => Promise.reject(boom);
    const config = { projectRoot: root, docs: ['docs/**/*.md'], exclude: [] } as unknown as ResolvedConfig;
    const err = await discoverDocs(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('DOC_READ_FAILED');
    expect((err as AiBddError).message).toBe('could not search for documents: boom');
    expect((err as AiBddError).cause).toBe(boom);

    search.override = () => Promise.reject('not an error object'); // eslint-disable-line prefer-promise-reject-errors
    const err2 = await discoverDocs(config).catch((e: unknown) => e);
    expect((err2 as AiBddError).message).toBe('could not search for documents: not an error object');
  });

  it('R-PL4: a search hit that is the project root itself is refused as POLICY_DENIED with the absolute path', async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-bdd-md-fail-'));
    search.override = () => Promise.resolve([root]);
    const config = { projectRoot: root, docs: ['**'], exclude: [] } as unknown as ResolvedConfig;
    const err = await discoverDocs(config).catch((e: unknown) => e);
    expect((err as AiBddError).code).toBe('POLICY_DENIED');
    expect((err as AiBddError).message).toBe(`document is outside the project root: ${root}`);
    expect((err as AiBddError).details).toEqual({ path: root });
  });
});
