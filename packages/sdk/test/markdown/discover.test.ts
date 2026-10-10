import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiBddError, type ResolvedConfig } from '../../src/contracts/index.ts';
import { createChunker, discoverDocs } from '../../src/markdown/index.ts';
import { sha256Hex } from '../../src/util/index.ts';

let root: string;
let outsideDir: string;

function config(over: Partial<Pick<ResolvedConfig, 'docs' | 'exclude'>> = {}): ResolvedConfig {
  return {
    projectRoot: root,
    docs: ['docs/**/*.md'],
    exclude: ['**/node_modules/**', '.ai-bdd/**'],
    ...over,
  } as unknown as ResolvedConfig;
}

async function put(rel: string, text: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-bdd-md-root-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'ai-bdd-md-out-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe('discoverDocs', () => {
  it('R-PL4: returns posix docUris sorted by uri with absolute paths, text and sha256', async () => {
    await put('docs/b.md', '# B\n');
    await put('docs/a.md', '# A\n');
    await put('docs/sub/deeper/c.md', '# C\n');
    await put('docs/readme.txt', 'not markdown');
    const docs = await discoverDocs(config());
    expect(docs.map((d) => d.uri)).toEqual(['docs/a.md', 'docs/b.md', 'docs/sub/deeper/c.md']);
    expect(docs[0]?.absolutePath).toBe(join(root, 'docs/a.md'));
    expect(docs[0]?.text).toBe('# A\n');
    expect(docs[0]?.sha256).toBe(sha256Hex('# A\n'));
  });

  it('R-PL4: the document digest ignores BOM and line-ending style', async () => {
    await put('docs/lf.md', '# T\n\nbody\n');
    await put('docs/crlf.md', '﻿# T\r\n\r\nbody\r\n');
    const docs = await discoverDocs(config());
    expect(docs).toHaveLength(2);
    expect(docs[0]?.sha256).toBe(docs[1]?.sha256);
    expect(docs.find((d) => d.uri === 'docs/crlf.md')?.text).toContain('\r\n');
  });

  it('R-PL4: applies the default excludes (node_modules, .ai-bdd) and custom excludes', async () => {
    await put('docs/keep.md', 'k');
    await put('docs/node_modules/pkg/readme.md', 'x');
    await put('.ai-bdd/notes.md', 'x');
    await put('docs/drafts/wip.md', 'x');
    const all = await discoverDocs(config({ docs: ['**/*.md'] }));
    expect(all.map((d) => d.uri)).toEqual(['docs/drafts/wip.md', 'docs/keep.md']);
    const custom = await discoverDocs(config({ docs: ['**/*.md'], exclude: ['**/drafts/**', '**/node_modules/**', '.ai-bdd/**'] }));
    expect(custom.map((d) => d.uri)).toEqual(['docs/keep.md']);
  });

  it('R-PL4: supports several patterns and negations and returns each file once', async () => {
    await put('docs/a.md', 'a');
    await put('README.md', 'r');
    await put('docs/skip.md', 's');
    const docs = await discoverDocs(config({ docs: ['docs/**/*.md', 'README.md', 'docs/a.md', '!docs/skip.md'] }));
    expect(docs.map((d) => d.uri)).toEqual(['README.md', 'docs/a.md']);
  });

  it('R-PL4: no patterns or no matches give an empty list', async () => {
    expect(await discoverDocs(config({ docs: [] }))).toEqual([]);
    expect(await discoverDocs(config({ docs: ['nothing/**/*.md'] }))).toEqual([]);
  });

  it('R-PL4: a pattern that reaches outside the project root is rejected with POLICY_DENIED', async () => {
    await writeFile(join(outsideDir, 'secret.md'), '# secret\n');
    const rel = join('..', outsideDir.split('/').pop() ?? '', '*.md');
    const err = await discoverDocs(config({ docs: [rel] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBddError);
    expect((err as AiBddError).code).toBe('POLICY_DENIED');
  });

  it('R-PL4: an absolute pattern outside the project root is rejected with POLICY_DENIED', async () => {
    await writeFile(join(outsideDir, 'secret.md'), '# secret\n');
    const err = await discoverDocs(config({ docs: [join(outsideDir, '*.md')] })).catch((e: unknown) => e);
    expect((err as AiBddError).code).toBe('POLICY_DENIED');
  });

  it('R-PL4: a symlink that resolves outside the project root is rejected with POLICY_DENIED', async () => {
    await writeFile(join(outsideDir, 'secret.md'), '# secret\n');
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink(join(outsideDir, 'secret.md'), join(root, 'docs/link.md'));
    const err = await discoverDocs(config()).catch((e: unknown) => e);
    expect((err as AiBddError).code).toBe('POLICY_DENIED');
  });

  it('R-PL4: a symlink that stays inside the root is accepted', async () => {
    await put('docs/real.md', '# real\n');
    await symlink(join(root, 'docs/real.md'), join(root, 'docs/alias.md'));
    const docs = await discoverDocs(config());
    expect(docs.map((d) => d.uri)).toEqual(['docs/alias.md', 'docs/real.md']);
  });

  it('R-PL4: dangling symlinks are not documents', async () => {
    await mkdir(join(root, 'docs'), { recursive: true });
    await symlink(join(root, 'docs/missing-target.md'), join(root, 'docs/dangling.md'));
    expect(await discoverDocs(config())).toEqual([]);
  });

  it('R-PL4: discovered docs feed straight into the chunker', async () => {
    await put('docs/x.md', '# X\r\n\r\nhello\r\n');
    const [doc] = await discoverDocs(config());
    expect(doc).toBeDefined();
    const out = createChunker().chunk(doc as NonNullable<typeof doc>, { sectionDepth: 2, maxSectionChars: 12000 });
    expect(out.chunks.map((c) => c.id)).toEqual(['docs/x.md#x/h', 'docs/x.md#x/p1']);
    expect(out.doc.sha256).toBe(doc?.sha256);
  });

  it('R-PL4: non-ASCII file names are kept as-is in the docUri', async () => {
    await put('docs/日本語.md', '# 日本\n');
    const docs = await discoverDocs(config());
    expect(docs.map((d) => d.uri)).toEqual(['docs/日本語.md']);
  });
});
