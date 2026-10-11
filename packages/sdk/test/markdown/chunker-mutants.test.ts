import { describe, expect, it } from 'vitest';
import { createChunker } from '../../src/markdown/index.ts';
import { CONTEXT_CHAR_BUDGET } from '../../src/markdown/chunker.ts';
import { MAX_DOC_CHARS } from '../../src/markdown/normalize.ts';
import { sha256Hex } from '../../src/util/index.ts';
import { chunkText, DEFAULT_OPTS, makeDoc } from './helpers.ts';

const U = 'docs/test.md';

describe('limits and options', () => {
  it('maxSectionChars of 0 is unusable and falls back to the default instead of splitting everything', () => {
    const d = chunkText('# T\n\ntext\n\nmore\n', { maxSectionChars: 0 });
    expect(d.diagnostics).toEqual([]);
    expect(d.sections.map((s) => [s.id, s.chunkIds])).toEqual([[`${U}#t`, [`${U}#t/h`, `${U}#t/p1`, `${U}#t/p2`]]]);
  });

  it('a document of exactly MAX_DOC_CHARS characters is chunked', () => {
    const text = 'a'.repeat(MAX_DOC_CHARS);
    const d = chunkText(text, { maxSectionChars: MAX_DOC_CHARS });
    expect(MAX_DOC_CHARS).toBe(262144);
    expect(d.diagnostics).toEqual([]);
    expect(d.chunks.map((c) => [c.id, c.text.length])).toEqual([[`${U}#_preamble/p1`, MAX_DOC_CHARS]]);
  });

  it('a document of MAX_DOC_CHARS + 1 characters is refused with one exact error and an empty result', () => {
    const text = 'a'.repeat(MAX_DOC_CHARS + 1);
    const doc = makeDoc(text);
    const d = createChunker().chunk(doc, DEFAULT_OPTS);
    expect(d).toEqual({
      doc: { uri: U, sha256: sha256Hex(text), title: U },
      chunks: [],
      sections: [],
      contextChunkIds: [],
      diagnostics: [
        {
          code: 'DOC_READ_FAILED',
          severity: 'error',
          message: 'document is 262145 characters; the limit is 262144. Split it into smaller documents',
          uri: U,
          details: { characters: 262145, limit: 262144 },
        },
      ],
    });
  });

  it('a non-string text field chunks as an empty document without any diagnostic', () => {
    const doc = { ...makeDoc('x'), text: undefined as unknown as string };
    const d = createChunker().chunk(doc, DEFAULT_OPTS);
    expect(d).toEqual({
      doc: { uri: U, sha256: sha256Hex('x'), title: U },
      chunks: [],
      sections: [],
      contextChunkIds: [],
      diagnostics: [],
    });
  });
});

describe('internal failures', () => {
  it('an Error thrown while reading the text is reported with its message in one exact error', () => {
    const doc = makeDoc('x');
    Object.defineProperty(doc, 'text', {
      get() {
        throw new Error('boom');
      },
    });
    expect(createChunker().chunk(doc, DEFAULT_OPTS)).toEqual({
      doc: { uri: U, sha256: sha256Hex('x'), title: U },
      chunks: [],
      sections: [],
      contextChunkIds: [],
      diagnostics: [{ code: 'DOC_READ_FAILED', severity: 'error', message: 'could not parse document: boom', uri: U }],
    });
  });

  it('a non-Error throw is reported through String()', () => {
    const doc = makeDoc('x');
    Object.defineProperty(doc, 'text', {
      get() {
        throw 'plain string';
      },
    });
    const d = createChunker().chunk(doc, DEFAULT_OPTS);
    expect(d.diagnostics).toEqual([{ code: 'DOC_READ_FAILED', severity: 'error', message: 'could not parse document: plain string', uri: U }]);
  });

  it('a document that uses every private-use character and needs neutralizing fails as one exact error', () => {
    let pua = '';
    for (let c = 0xe000; c <= 0xf8ff; c++) pua += String.fromCharCode(c);
    const text = `${pua}\n\npara\n${' '.repeat(130)}x\n`;
    expect(createChunker().chunk(makeDoc(text), DEFAULT_OPTS)).toEqual({
      doc: { uri: U, sha256: sha256Hex(text), title: U },
      chunks: [],
      sections: [],
      contextChunkIds: [],
      diagnostics: [
        {
          code: 'DOC_READ_FAILED',
          severity: 'error',
          message: 'could not parse document: document uses every private-use character and exceeds the inline budgets',
          uri: U,
        },
      ],
    });
  });

  it('a document that uses every private-use character but needs no neutralizing is chunked', () => {
    let pua = '';
    for (let c = 0xe000; c <= 0xf8ff; c++) pua += String.fromCharCode(c);
    const d = chunkText(`${pua}\n\npara\n`);
    expect(d.diagnostics).toEqual([]);
    expect(d.chunks.map((c) => c.text)).toEqual([pua, 'para']);
  });
});

describe('diagnostics for neutralized input', () => {
  it('lines nested more than 100 containers deep are reported once with the exact message and position', () => {
    const d = chunkText(`first\n\n${'> '.repeat(101)}deep\n\nlast\n`);
    expect(d.chunks.map((c) => c.text)).toEqual(['first', 'last']);
    expect(d.diagnostics).toEqual([
      {
        code: 'DOC_READ_FAILED',
        severity: 'warning',
        message: 'line nests block quotes or lists more than 100 levels deep and was skipped',
        uri: U,
        range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 },
      },
    ]);
  });

  it('inline delimiters beyond the per-paragraph budget are reported once with their count', () => {
    const d = chunkText(`a${'_'.repeat(1001)}\n`);
    expect(d.chunks.map((c) => c.text)).toEqual([`a${'_'.repeat(1001)}`]);
    expect(d.diagnostics).toEqual([
      {
        code: 'DOC_READ_FAILED',
        severity: 'warning',
        message: '1 inline delimiter(s) beyond the per-paragraph budget are treated as literal text',
        uri: U,
      },
    ]);
  });

  it('a document within the delimiter budget has no delimiter diagnostic', () => {
    const d = chunkText(`a${'_'.repeat(1000)}\n`);
    expect(d.diagnostics).toEqual([]);
  });

  it('lines indented beyond the supported depth are counted and the first one is located', () => {
    const d = chunkText(`para\n\n${' '.repeat(130)}x\n\n${' '.repeat(125)}y\n`);
    expect(d.diagnostics).toEqual([
      {
        code: 'DOC_READ_FAILED',
        severity: 'warning',
        message:
          '2 line(s) are indented beyond the supported depth; their extra leading whitespace is treated as text (first at line 3)',
        uri: U,
        range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 },
      },
    ]);
    expect(d.chunks.map((c) => [c.kind, c.text, c.range.startLine])).toEqual([
      ['paragraph', 'para', 1],
      ['code', 'x y', 3],
    ]);
  });
});

describe('frontmatter detection', () => {
  it('only a frontmatter node is read as YAML: a leading code block that looks like YAML is just code', () => {
    const d = chunkText('```\na: 1\n```\n\ntext\n');
    expect(d.doc).toEqual({ uri: U, sha256: sha256Hex('```\na: 1\n```\n\ntext\n'), title: U });
    expect(d.doc.frontmatter).toBeUndefined();
    expect(d.diagnostics).toEqual([]);
    expect(d.chunks.map((c) => [c.kind, c.text])).toEqual([
      ['code', 'a: 1'],
      ['paragraph', 'text'],
    ]);
  });

  it('a leading html block is not parsed as YAML', () => {
    const d = chunkText('<div>\n\ntext\n');
    expect(d.doc.frontmatter).toBeUndefined();
    expect(d.diagnostics).toEqual([]);
    expect(d.chunks.map((c) => c.text)).toEqual(['text']);
  });

  it('a leading code block with invalid YAML text does not produce a frontmatter diagnostic', () => {
    const d = chunkText('```\n: : [\n```\n');
    expect(d.diagnostics).toEqual([]);
    expect(d.doc.frontmatter).toBeUndefined();
  });

  it('real frontmatter is exposed exactly', () => {
    const d = chunkText('---\ntitle: T\ncount: 2\n---\n\ntext\n');
    expect(d.doc.frontmatter).toEqual({ title: 'T', count: 2 });
    expect(d.chunks.map((c) => c.text)).toEqual(['text']);
  });
});

describe('context chunk budget', () => {
  const ctx = (letter: string, n: number): string => `<!-- ai-bdd: context -->\n${letter.repeat(n)}\n`;

  it('the budget is 4000 characters', () => {
    expect(CONTEXT_CHAR_BUDGET).toBe(4000);
  });

  it('a context chunk of exactly the remaining budget is offered, with no diagnostic', () => {
    const d = chunkText(ctx('a', 4000));
    expect(d.contextChunkIds).toEqual([`${U}#_preamble/p1`]);
    expect(d.diagnostics).toEqual([]);
  });

  it('two context chunks that together equal the budget are both offered', () => {
    const d = chunkText(`${ctx('a', 1500)}\n${ctx('b', 2500)}`);
    expect(d.contextChunkIds).toEqual([`${U}#_preamble/p1`, `${U}#_preamble/p2`]);
    expect(d.diagnostics).toEqual([]);
  });

  it('a context chunk one character over the budget is omitted and reported with exact counts', () => {
    const d = chunkText(ctx('a', 4001));
    expect(d.contextChunkIds).toEqual([]);
    expect(d.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: 'context chunks exceed the 4000 character budget; 1 later chunk(s) are not offered as context',
        uri: U,
        details: { omitted: 1, budget: 4000 },
      },
    ]);
  });

  it('once one context chunk is omitted every later one is omitted too, even if it would still fit', () => {
    const d = chunkText(`${ctx('a', 3000)}\n${ctx('b', 2000)}\n${ctx('c', 100)}`);
    expect(d.contextChunkIds).toEqual([`${U}#_preamble/p1`]);
    expect(d.diagnostics).toEqual([
      {
        code: 'DIRECTIVE_INVALID',
        severity: 'warning',
        message: 'context chunks exceed the 4000 character budget; 2 later chunk(s) are not offered as context',
        uri: U,
        details: { omitted: 2, budget: 4000 },
      },
    ]);
  });
});
