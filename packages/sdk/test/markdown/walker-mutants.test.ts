import { describe, expect, it } from 'vitest';
import type { ChunkedDoc } from '../../src/contracts/index.ts';
import { chunkText } from './helpers.ts';

const U = 'docs/test.md';

/** Chunk view with exact ids, kinds, text, parent, range and resolved directives. */
function chunks(d: ChunkedDoc): unknown[] {
  return d.chunks.map((c) => ({
    id: c.id,
    kind: c.kind,
    text: c.text,
    parentId: c.parentId,
    range: `${c.range.startLine}:${c.range.startColumn}-${c.range.endLine}:${c.range.endColumn}`,
    directives: c.directives,
  }));
}

const ORPHAN = 'directive is not followed by a block it can apply to';

describe('directives bind to the next block that yields chunks', () => {
  it('a directive before an empty heading is kept for the next real block', () => {
    const d = chunkText(['<!-- ai-bdd: ignore -->', '#', '', 'para', ''].join('\n'));
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/p1`, kind: 'paragraph', text: 'para', parentId: undefined, range: '4:1-4:5', directives: { ignore: true } },
    ]);
  });

  it('an empty heading does not open a heading scope or take over the directive that follows it', () => {
    const d = chunkText(['# Real', '', 'lead', '', '<!-- ai-bdd: fuzzy -->', '##', '', 'para', '', '# Next', '', 'other', ''].join('\n'));
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#real/h`, kind: 'heading', text: 'Real', parentId: undefined, range: '1:1-1:7', directives: {} },
      { id: `${U}#real/p1`, kind: 'paragraph', text: 'lead', parentId: undefined, range: '3:1-3:5', directives: {} },
      { id: `${U}#real/p2`, kind: 'paragraph', text: 'para', parentId: undefined, range: '8:1-8:5', directives: { fuzzy: true } },
      { id: `${U}#next/h`, kind: 'heading', text: 'Next', parentId: undefined, range: '10:1-10:7', directives: {} },
      { id: `${U}#next/p1`, kind: 'paragraph', text: 'other', parentId: undefined, range: '12:1-12:6', directives: {} },
    ]);
    expect(d.chunks.map((c) => c.headingPath)).toEqual([['Real'], ['Real'], ['Real'], ['Next'], ['Next']]);
  });

  it('a directive before a block that produces no chunk (empty code block) still applies to the next real block', () => {
    const d = chunkText(['<!-- ai-bdd: ignore -->', '```', '```', '', 'para', ''].join('\n'));
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/p1`, kind: 'paragraph', text: 'para', parentId: undefined, range: '5:1-5:5', directives: { ignore: true } },
    ]);
  });

  it('an orphan directive in front of a block without chunks is reported at the directive, not at that block', () => {
    const d = chunkText(['<!-- ai-bdd: ignore -->', '', '***', ''].join('\n'));
    expect(d.chunks).toEqual([]);
    expect(d.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: ORPHAN,
        uri: U,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 24 },
      },
    ]);
  });

  it('a directive skips thematic breaks and link definitions and keeps its own range for the orphan report', () => {
    const through = chunkText(['<!-- ai-bdd: ignore -->', '', '***', '', '[ref]: https://example.com', '', 'para', ''].join('\n'));
    expect(through.diagnostics).toEqual([]);
    expect(chunks(through)).toEqual([
      { id: `${U}#_preamble/p1`, kind: 'paragraph', text: 'para', parentId: undefined, range: '7:1-7:5', directives: { ignore: true } },
    ]);

    const orphan = chunkText(['text', '', '<!-- ai-bdd: ignore -->', '', '[ref]: https://example.com', ''].join('\n'));
    expect(orphan.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: ORPHAN,
        uri: U,
        range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 24 },
      },
    ]);
  });

  it('a block without chunks between a heading and its directive keeps the directive on the heading scope', () => {
    const md = ['# H', '', '***', '', '<!-- ai-bdd: fuzzy -->', '', 'para', '', '# Next', '', 'other', ''].join('\n');
    const d = chunkText(md);
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#h/h`, kind: 'heading', text: 'H', parentId: undefined, range: '1:1-1:4', directives: { fuzzy: true } },
      { id: `${U}#h/p1`, kind: 'paragraph', text: 'para', parentId: undefined, range: '7:1-7:5', directives: { fuzzy: true } },
      { id: `${U}#next/h`, kind: 'heading', text: 'Next', parentId: undefined, range: '9:1-9:7', directives: {} },
      { id: `${U}#next/p1`, kind: 'paragraph', text: 'other', parentId: undefined, range: '11:1-11:6', directives: {} },
    ]);
  });

  it('a block that does yield a chunk ends the heading-adjacent window: a later directive applies to the next block only', () => {
    const md = ['# H', '', 'first', '', '<!-- ai-bdd: fuzzy -->', '', 'second', '', 'third', ''].join('\n');
    const d = chunkText(md);
    expect(chunks(d)).toEqual([
      { id: `${U}#h/h`, kind: 'heading', text: 'H', parentId: undefined, range: '1:1-1:4', directives: {} },
      { id: `${U}#h/p1`, kind: 'paragraph', text: 'first', parentId: undefined, range: '3:1-3:6', directives: {} },
      { id: `${U}#h/p2`, kind: 'paragraph', text: 'second', parentId: undefined, range: '7:1-7:7', directives: { fuzzy: true } },
      { id: `${U}#h/p3`, kind: 'paragraph', text: 'third', parentId: undefined, range: '9:1-9:6', directives: {} },
    ]);
  });

  it('a directive binds to a fenced code block and to a blockquote', () => {
    const md = ['<!-- ai-bdd: fuzzy -->', '```', 'code', '```', '', '<!-- ai-bdd: ignore -->', '> quote', '', 'plain', ''].join('\n');
    const d = chunkText(md);
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/code1`, kind: 'code', text: 'code', parentId: undefined, range: '2:1-4:4', directives: { fuzzy: true } },
      { id: `${U}#_preamble/bq1`, kind: 'blockquote', text: 'quote', parentId: undefined, range: '7:1-7:8', directives: { ignore: true } },
      { id: `${U}#_preamble/p1`, kind: 'paragraph', text: 'plain', parentId: undefined, range: '9:1-9:6', directives: {} },
    ]);
  });

  it('a directive binds to a list and to a table (the first chunk they produce)', () => {
    const md = ['<!-- ai-bdd: fuzzy -->', '- item', '', '<!-- ai-bdd: ignore -->', '| a |', '|---|', '| b |', ''].join('\n');
    const d = chunkText(md);
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/li1`, kind: 'listItem', text: 'item', parentId: undefined, range: '2:1-2:7', directives: { fuzzy: true } },
      { id: `${U}#_preamble/tr1`, kind: 'tableRow', text: 'a: b', parentId: undefined, range: '7:1-7:6', directives: { ignore: true } },
    ]);
  });

  it('a directive inside a list item before its code block binds to that block, not to the item', () => {
    const md = ['- item', '  <!-- ai-bdd: fuzzy -->', '  ```', '  code', '  ```', ''].join('\n');
    const d = chunkText(md);
    expect(d.diagnostics).toEqual([]);
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/li1`, kind: 'listItem', text: 'item', parentId: undefined, range: '1:1-1:7', directives: {} },
      { id: `${U}#_preamble/code1`, kind: 'code', text: 'code', parentId: `${U}#_preamble/li1`, range: '3:3-5:6', directives: { fuzzy: true } },
    ]);
  });

  it('an orphan directive at the end of a list item is reported at the directive', () => {
    const d = chunkText(['- item', '  <!-- ai-bdd: fuzzy -->', ''].join('\n'));
    expect(d.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: ORPHAN,
        uri: U,
        range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 25 },
      },
    ]);
  });
});

describe('inline html', () => {
  it('a directive inside a paragraph warns once at the paragraph and a plain comment does not warn', () => {
    const d = chunkText('para <!-- ai-bdd: ignore --> mid <!-- plain --> end\n');
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/p1`, kind: 'paragraph', text: 'para mid end', parentId: undefined, range: '1:1-1:52', directives: {} },
    ]);
    expect(d.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: 'directive must be a block-level comment on its own line; ignored here',
        uri: U,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 52 },
      },
    ]);
  });

  it('a plain comment alone in a paragraph produces no diagnostics', () => {
    const d = chunkText('before <!-- just a note --> after\n');
    expect(d.diagnostics).toEqual([]);
    expect(d.chunks.map((c) => c.text)).toEqual(['before after']);
  });

  it('an unterminated directive comment is reported once at its html block', () => {
    const d = chunkText(['text', '', '<!-- ai-bdd: ignore', ''].join('\n'));
    expect(d.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: 'unterminated directive comment (missing "-->")',
        uri: U,
        range: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 1 },
      },
    ]);
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/p1`, kind: 'paragraph', text: 'text', parentId: undefined, range: '1:1-1:5', directives: {} },
    ]);
  });
});

describe('tables and lists', () => {
  it('a table row is dropped only when every cell is empty; rows with some empty cells keep the header labels', () => {
    const d = chunkText(['| a | b |', '|---|---|', '| x | |', '| | y |', '| | |', ''].join('\n'));
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/tr1`, kind: 'tableRow', text: 'a: x; b:', parentId: undefined, range: '3:1-3:8', directives: {} },
      { id: `${U}#_preamble/tr2`, kind: 'tableRow', text: 'a: ; b: y', parentId: undefined, range: '4:1-4:8', directives: {} },
    ]);
  });

  it('a nested item hangs from the nearest parent that produced a chunk when its own parent item has empty text', () => {
    const d = chunkText(['- parent', '  - ![](x.png)', '    - child', '      text', ''].join('\n'));
    expect(chunks(d)).toEqual([
      { id: `${U}#_preamble/li1`, kind: 'listItem', text: 'parent', parentId: undefined, range: '1:1-1:9', directives: {} },
      { id: `${U}#_preamble/li2`, kind: 'listItem', text: 'child text', parentId: `${U}#_preamble/li1`, range: '3:5-4:11', directives: {} },
    ]);
  });
});
