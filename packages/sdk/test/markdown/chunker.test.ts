import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import type { ChunkedDoc } from '../../src/contracts/index.ts';
import { createChunker } from '../../src/markdown/index.ts';
import { CONTEXT_CHAR_BUDGET } from '../../src/markdown/chunker.ts';
import { sha256Hex, stableJson } from '../../src/util/index.ts';
import { chunkText, makeDoc } from './helpers.ts';

const SAMPLE = `---
title: Sample
ai-bdd:
  tags: [t]
---
# Title

Intro paragraph.

## Billing

Upgrade paragraph with text.

- item one
  - nested item
- item two

| Plan | Price |
|------|-------|
| Free | $0 |

> quote

\`\`\`
code
\`\`\`

## Reports

Report paragraph.
`;

function ids(d: ChunkedDoc): string[] {
  return d.chunks.map((c) => c.id);
}

describe('chunk structure', () => {
  it('R-EX4: chunk kinds, anchors and ids follow the anchor grammar', () => {
    const d = chunkText(SAMPLE, {}, 'docs/sample.md');
    expect(d.doc.title).toBe('Title');
    expect(ids(d)).toEqual([
      'docs/sample.md#title/h',
      'docs/sample.md#title/p1',
      'docs/sample.md#title/billing/h',
      'docs/sample.md#title/billing/p1',
      'docs/sample.md#title/billing/li1',
      'docs/sample.md#title/billing/li2',
      'docs/sample.md#title/billing/li3',
      'docs/sample.md#title/billing/tr1',
      'docs/sample.md#title/billing/bq1',
      'docs/sample.md#title/billing/code1',
      'docs/sample.md#title/reports/h',
      'docs/sample.md#title/reports/p1',
    ]);
    const kinds = d.chunks.map((c) => c.kind);
    expect(kinds).toEqual(['heading', 'paragraph', 'heading', 'paragraph', 'listItem', 'listItem', 'listItem', 'tableRow', 'blockquote', 'code', 'heading', 'paragraph']);
    expect(d.chunks[5]?.parentId).toBe('docs/sample.md#title/billing/li1');
    expect(d.chunks[4]?.parentId).toBeUndefined();
    expect(d.chunks[7]?.text).toBe('Plan: Free; Price: $0');
    for (const c of d.chunks) {
      expect(c.hash).toBe(sha256Hex(c.text));
      expect(c.docUri).toBe('docs/sample.md');
      expect(c.id).toBe(`docs/sample.md#${c.anchor}`);
    }
  });

  it('R-PL2: chunk hash is sha256 of the normalized text and ignores inline markup', () => {
    const a = chunkText('Some **bold**   and\n_soft_ text\n');
    const b = chunkText('Some bold and soft text\n');
    expect(a.chunks[0]?.text).toBe('Some bold and soft text');
    expect(a.chunks[0]?.hash).toBe(b.chunks[0]?.hash);
  });

  it('R-EX4: heading path is the outline of heading texts and includes the heading itself', () => {
    const d = chunkText('# A\n\n## B\n\ntext\n');
    expect(d.chunks.map((c) => c.headingPath)).toEqual([['A'], ['A', 'B'], ['A', 'B']]);
  });

  it('R-EX4: content before the first heading uses _preamble and the doc title falls back to the uri', () => {
    const d = chunkText('Just text.\n', {}, 'docs/x.md');
    expect(d.doc.title).toBe('docs/x.md');
    expect(d.chunks[0]?.anchor).toBe('_preamble/p1');
    expect(d.chunks[0]?.headingPath).toEqual([]);
  });

  it('R-EX4: the title is the first h1, not the first heading', () => {
    expect(chunkText('## Sub\n\n# Main\n\n# Later\n').doc.title).toBe('Main');
  });

  it('R-EX4: list item ordinals count across nesting under the nearest heading', () => {
    const d = chunkText('# H\n\n- a\n  - b\n- c\n\ntext\n\n- d\n');
    expect(d.chunks.filter((c) => c.kind === 'listItem').map((c) => c.anchor)).toEqual(['h/li1', 'h/li2', 'h/li3', 'h/li4']);
  });

  it('R-EX4: a nested item whose parent has no own text is attached to the nearest existing ancestor', () => {
    const d = chunkText('- top\n  -\n    - deep\n');
    const deep = d.chunks.find((c) => c.text === 'deep');
    const top = d.chunks.find((c) => c.text === 'top');
    expect(deep?.parentId).toBe(top?.id);
  });

  it('R-EX4: empty text chunks are dropped (empty cells, empty code, empty headings)', () => {
    const d = chunkText('#\n\n```\n```\n\n| a |\n|---|\n| |\n');
    expect(d.chunks).toEqual([]);
    expect(d.sections).toEqual([]);
  });

  it('R-EX4: text is NFC normalized and whitespace collapsed', () => {
    const d = chunkText('Café   au\tlait\n');
    expect(d.chunks[0]?.text).toBe('Café au lait');
  });

  it('R-EX4: html blocks, thematic breaks, definitions and footnote definitions are not chunks', () => {
    const d = chunkText('<div>x</div>\n\n---\n\n[a]: http://x\n\n[^1]: note\n\ntext[^1]\n');
    expect(d.chunks.map((c) => c.text)).toEqual(['text']);
  });

  it('R-EX4: frontmatter is exposed on the doc and is not a chunk', () => {
    const d = chunkText('---\na: 1\nb: [x, y]\n---\ntext\n');
    expect(d.doc.frontmatter).toEqual({ a: 1, b: ['x', 'y'] });
    expect(d.chunks).toHaveLength(1);
    expect(chunkText('text\n').doc.frontmatter).toBeUndefined();
  });

  it('R-EX4: unsafe YAML values become JSON-safe data', () => {
    const d = chunkText('---\nn: .inf\nm: .nan\nd: 2020-01-02\n__proto__: x\n---\ntext\n');
    expect(d.doc.frontmatter).toEqual({ n: 'Infinity', m: 'NaN', d: '2020-01-02' });
  });
});

describe('sections', () => {
  it('R-EX6: sections start at headings up to sectionDepth and deeper headings stay inside', () => {
    const d = chunkText(SAMPLE);
    expect(d.sections.map((s) => s.id)).toEqual([
      'docs/test.md#title',
      'docs/test.md#title/billing',
      'docs/test.md#title/reports',
    ]);
    expect(d.sections[1]?.level).toBe(2);
    expect(d.sections[1]?.title).toBe('Billing');
  });

  it('R-PL2: Section.hash is the sha256 of the chunk hashes joined by newline, in document order', () => {
    const d = chunkText(SAMPLE);
    const s = d.sections[1];
    const byId = new Map(d.chunks.map((c) => [c.id, c]));
    const expected = sha256Hex((s?.chunkIds ?? []).map((id) => byId.get(id)?.hash).join('\n'));
    expect(s?.hash).toBe(expected);
  });

  it('R-PL2: editing one paragraph changes only its chunk hash and its own section hash', () => {
    const before = chunkText(SAMPLE);
    const after = chunkText(SAMPLE.replace('Upgrade paragraph with text.', 'Upgrade paragraph with new text.'));
    expect(ids(after)).toEqual(ids(before));
    const changed = before.chunks.filter((c, i) => c.hash !== after.chunks[i]?.hash).map((c) => c.id);
    expect(changed).toEqual(['docs/test.md#title/billing/p1']);
    const sectionDiff = before.sections.filter((s, i) => s.hash !== after.sections[i]?.hash).map((s) => s.id);
    expect(sectionDiff).toEqual(['docs/test.md#title/billing']);
  });

  it('R-PL2: moving an unedited paragraph keeps every chunk hash (only anchors change)', () => {
    const a = chunkText('# H\n\nalpha\n\nbeta\n\ngamma\n');
    const b = chunkText('# H\n\nbeta\n\nalpha\n\ngamma\n');
    const hashes = (d: ChunkedDoc): string[] => d.chunks.map((c) => c.hash).sort();
    expect(hashes(b)).toEqual(hashes(a));
    expect(b.chunks[1]?.anchor).toBe('h/p1');
  });

  it('R-EX6: an empty section (all chunks excluded) is not emitted', () => {
    const d = chunkText('# Doc\n\ntext\n\n## Hidden\n<!-- ai-bdd: ignore -->\n\nsecret\n');
    expect(d.sections.map((s) => s.anchor)).toEqual(['doc']);
    const hidden = d.chunks.filter((c) => c.directives.ignore);
    expect(hidden.map((c) => c.text)).toEqual(['Hidden', 'secret']);
  });

  it('R-EX6: sectionDepth and maxSectionChars that are not usable fall back to defaults and never throw', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -3, 0.5]) {
      expect(() => chunkText(SAMPLE, { sectionDepth: bad, maxSectionChars: bad })).not.toThrow();
    }
    const d = chunkText(SAMPLE, { sectionDepth: Number.NaN, maxSectionChars: -1 });
    expect(d.sections.length).toBe(3);
  });

  it('R-EX6: oversized sections split at next-deeper headings, then chunk boundaries, deterministically', () => {
    const md = [
      '## Big',
      'intro intro intro',
      '### One',
      'one one one one one one one one',
      'two two two two two two two two',
      '### Two',
      'tail',
    ].join('\n\n');
    const a = chunkText(md, { maxSectionChars: 45 });
    const b = chunkText(md, { maxSectionChars: 45 });
    expect(stableJson(a as never)).toBe(stableJson(b as never));
    expect(a.sections.map((s) => s.anchor)).toEqual(['big', 'big/one/part-1', 'big/one/part-2', 'big/two']);
    expect(a.sections.map((s) => s.title)).toEqual(['Big', 'One (part 1)', 'One (part 2)', 'Two']);
    for (const s of a.sections) {
      const text = s.chunkIds.map((id) => a.chunks.find((c) => c.id === id)?.text ?? '').join('');
      expect(text.length).toBeLessThanOrEqual(45);
    }
  });

  it('R-EX6: a split never happens inside a chunk and a single oversized chunk becomes its own part with DOC_CHUNK_TOO_LARGE', () => {
    const big = 'word '.repeat(40).trim();
    const d = chunkText(`## S\n\nsmall\n\n${big}\n\nsmall two\n`, { maxSectionChars: 50 });
    const bigChunk = d.chunks.find((c) => c.text === big);
    const owner = d.sections.find((s) => s.id === bigChunk?.sectionId);
    expect(owner?.chunkIds).toEqual([bigChunk?.id]);
    const warn = d.diagnostics.filter((x) => x.code === 'DOC_CHUNK_TOO_LARGE');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.severity).toBe('warning');
    expect(warn[0]?.range?.startLine).toBe(5);
    expect(d.sections.map((s) => s.anchor)).toEqual(['s/part-1', 's/part-2', 's/part-3']);
  });

  it('R-EX6: a section that is exactly one oversized chunk keeps its plain id', () => {
    const d = chunkText(`${'x '.repeat(60).trim()}\n`, { maxSectionChars: 20 });
    expect(d.sections.map((s) => s.anchor)).toEqual(['_preamble']);
    expect(d.diagnostics.map((x) => x.code)).toEqual(['DOC_CHUNK_TOO_LARGE']);
  });

  it('R-EX6: part ids never collide with a real heading called "part-1"', () => {
    const md = '## S\n\naaaaaaaaaaaaaaaa\n\nbbbbbbbbbbbbbbbb\n\n### part-1\n\ncccccccccccccccc\n';
    const d = chunkText(md, { maxSectionChars: 30 });
    const idList = d.sections.map((s) => s.id);
    expect(new Set(idList).size).toBe(idList.length);
  });

  it('R-EX4: ignored and context chunks do not count towards the section size', () => {
    const md = '## S\n\nkept\n\n<!-- ai-bdd: ignore -->\n' + 'ignored '.repeat(30) + '\n\n<!-- ai-bdd: context -->\n' + 'context '.repeat(30) + '\n';
    const d = chunkText(md, { maxSectionChars: 40 });
    expect(d.sections.map((s) => s.anchor)).toEqual(['s']);
    expect(d.diagnostics).toEqual([]);
  });

  it('R-EX4: context chunks are offered to every section in document order, within the character budget', () => {
    const para = (n: number): string => `ctx${n} ${'w'.repeat(1500)}`;
    const md = `# D\n\nlead\n\n<!-- ai-bdd: context -->\n${para(1)}\n\n<!-- ai-bdd: context -->\n${para(2)}\n\n<!-- ai-bdd: context -->\n${para(3)}\n`;
    const d = chunkText(md);
    const withinBudget = d.contextChunkIds.map((id) => d.chunks.find((c) => c.id === id)?.text.length ?? 0);
    expect(withinBudget.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET);
    expect(d.contextChunkIds).toEqual(['docs/test.md#d/p2', 'docs/test.md#d/p3']);
    expect(d.diagnostics.map((x) => x.code)).toEqual(['DIRECTIVE_INVALID']);
    expect(d.sections.flatMap((s) => s.chunkIds).some((id) => d.contextChunkIds.includes(id))).toBe(false);
  });

  it('R-EX4: ignore wins over context', () => {
    const d = chunkText('# D\n\nlead\n\n<!-- ai-bdd: ignore context -->\ntext\n\nmore\n');
    expect(d.contextChunkIds).toEqual([]);
    expect(d.sections[0]?.chunkIds).toEqual(['docs/test.md#d/h', 'docs/test.md#d/p1', 'docs/test.md#d/p3']);
  });
});

describe('directives in documents', () => {
  it('R-EX4: a directive right after a heading scopes the heading subtree, including the heading itself', () => {
    const d = chunkText('# A\n\nintro\n\n## B\n<!-- ai-bdd: ignore -->\n\nb text\n\n### C\n\nc text\n\n## D\n\nd text\n');
    const flags = Object.fromEntries(d.chunks.map((c) => [c.anchor, c.directives.ignore === true]));
    expect(flags).toMatchObject({ 'a/h': false, 'a/p1': false, 'a/b/h': true, 'a/b/p1': true, 'a/b/c/h': true, 'a/b/c/p1': true, 'a/d/h': false, 'a/d/p1': false });
  });

  it('R-EX4: a directive anywhere else applies to the next block only', () => {
    const d = chunkText('# A\n\nlead\n\n<!-- ai-bdd: fuzzy -->\none\n\ntwo\n');
    expect(d.chunks.map((c) => c.directives.fuzzy === true)).toEqual([false, false, true, false]);
  });

  it('R-EX4: an orphan directive is DIRECTIVE_INVALID', () => {
    const d = chunkText('# A\n\ntext\n\n<!-- ai-bdd: ignore -->\n');
    expect(d.diagnostics.map((x) => [x.code, x.severity])).toEqual([['DIRECTIVE_INVALID', 'warning']]);
    expect(d.diagnostics[0]?.range?.startLine).toBe(5);
  });

  it('R-EX4: unknown keys warn with DIRECTIVE_UNKNOWN_KEY and other keys in the comment still apply', () => {
    const d = chunkText('# A\n\nlead\n\n<!-- ai-bdd: bogus=1 fuzzy -->\ntext\n');
    expect(d.diagnostics.map((x) => x.code)).toEqual(['DIRECTIVE_UNKNOWN_KEY']);
    expect(d.chunks.at(-1)?.directives).toEqual({ fuzzy: true });
  });

  it('R-EX4: frontmatter ai-bdd mapping applies to the whole doc and is overridden by nested scopes', () => {
    const d = chunkText('---\nai-bdd:\n  driver: web\n  tags: [a]\n---\n# A\n<!-- ai-bdd: driver=other tags=b -->\n\ntext\n');
    expect(d.chunks.map((c) => c.directives)).toEqual([
      { driver: 'other', tags: ['a', 'b'] },
      { driver: 'other', tags: ['a', 'b'] },
    ]);
  });

  it('R-EX4: invalid frontmatter YAML is DOC_READ_FAILED (warning) and the frontmatter is ignored', () => {
    const d = chunkText('---\na: [1\n---\n# A\n\ntext\n');
    expect(d.diagnostics.map((x) => [x.code, x.severity])).toEqual([['DOC_READ_FAILED', 'warning']]);
    expect(d.doc.frontmatter).toBeUndefined();
    expect(d.chunks.map((c) => c.text)).toEqual(['A', 'text']);
  });

  it('R-EX4: directives that appear in a blockquote apply to that blockquote chunk', () => {
    const d = chunkText('# A\n\n> <!-- ai-bdd: ignore -->\n> text\n');
    expect(d.chunks.at(-1)?.directives).toEqual({ ignore: true });
  });
});

describe('line endings, BOM and positions', () => {
  const lf = SAMPLE;
  const strip = (d: ChunkedDoc): string => stableJson(d as never);

  it('R-PL4: CRLF, lone CR and BOM inputs chunk exactly like LF input (ranges included)', () => {
    const options = { sectionDepth: 2, maxSectionChars: 12000 };
    const variant = (text: string): string => strip(createChunker().chunk(makeDoc(text, 'docs/test.md', lf), options));
    const expected = variant(lf);
    expect(variant(lf.replace(/\n/g, '\r\n'))).toBe(expected);
    expect(variant(lf.replace(/\n/g, '\r'))).toBe(expected);
    expect(variant(`\uFEFF${lf}`)).toBe(expected);
    expect(variant(`\uFEFF${lf.replace(/\n/g, '\r\n')}`)).toBe(expected);
  });

  it('R-PL4: mixed line endings in one file are accepted', () => {
    const mixed = '# A\r\n\r\nline one\nline two\r\r- item\r\n';
    const d = chunkText(mixed);
    expect(d.chunks.map((c) => [c.kind, c.text, c.range.startLine])).toEqual([
      ['heading', 'A', 1],
      ['paragraph', 'line one line two', 3],
      ['listItem', 'item', 6],
    ]);
  });

  it('V9: mdast positions from micromark are identical for LF, CRLF, lone CR and BOM input', () => {
    const parse = (t: string): string =>
      JSON.stringify(
        fromMarkdown(t, {
          extensions: [gfm(), frontmatter(['yaml'])],
          mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
        }),
        // offsets legitimately differ with CRLF; node values keep the raw line endings
        (k, v: unknown) => (k === 'offset' || k === 'value' ? undefined : v),
      );
    const expected = parse(lf);
    expect(parse(lf.replace(/\n/g, '\r\n'))).toBe(expected);
    expect(parse(lf.replace(/\n/g, '\r'))).toBe(expected);
    expect(parse(`﻿${lf}`)).toBe(expected);
  });

  it('R-PL4: ranges are 1-based with an exclusive end column', () => {
    const d = chunkText('# Hi\n\nabc\n');
    expect(d.chunks[0]?.range).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 });
    expect(d.chunks[1]?.range).toEqual({ startLine: 3, startColumn: 1, endLine: 3, endColumn: 4 });
  });

  it('R-PL4: doc.sha256 is passed through from the source doc', () => {
    const doc = makeDoc('text\n', 'docs/a.md', 'anything');
    const out = createChunker().chunk(doc, { sectionDepth: 2, maxSectionChars: 100 });
    expect(out.doc.sha256).toBe(sha256Hex('anything'));
    expect(out.doc.uri).toBe('docs/a.md');
  });

  it('R-PL4: output is byte-identical across repeated runs and chunker instances', () => {
    expect(strip(chunkText(lf))).toBe(strip(chunkText(lf)));
    const a = createChunker().chunk(makeDoc(lf), { sectionDepth: 2, maxSectionChars: 12000 });
    const b = createChunker().chunk(makeDoc(lf), { sectionDepth: 2, maxSectionChars: 12000 });
    expect(strip(a)).toBe(strip(b));
  });
});

describe('robustness', () => {
  it('R-EX4: never throws on degenerate inputs and degrades to DOC_READ_FAILED only for internal failures', () => {
    const inputs = [
      '',
      '\0',
      '﻿',
      '\uD800',
      '---',
      '---\n',
      '---\n---',
      '```',
      '<!--',
      '<!-- ai-bdd:',
      '|',
      '| a |\n|-|',
      '>'.repeat(3000),
      `${'- '.repeat(2000)}x`,
      `${'['.repeat(20000)}`,
      `${'*'.repeat(50000)}`,
      '# '.repeat(5000),
      `${'  '.repeat(500)}- x`,
      '\r\r\r\n\n',
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      const d = chunkText(input);
      expect(Array.isArray(d.chunks)).toBe(true);
      expect(performance.now() - t0, `slow input ${JSON.stringify(input.slice(0, 20))}`).toBeLessThan(5000);
    }
  });

  it('R-EX4: a non-string text field is treated as empty instead of throwing', () => {
    const doc = { ...makeDoc('x'), text: undefined as unknown as string };
    expect(() => createChunker().chunk(doc, { sectionDepth: 2, maxSectionChars: 100 })).not.toThrow();
  });

  it('R-EX4: deeply nested blocks degrade gracefully', () => {
    const d = chunkText(`${'> '.repeat(1500)}deep quote\n`);
    expect(d.chunks.map((c) => [c.kind, c.text])).toEqual([['blockquote', 'deep quote']]);
  });
});
