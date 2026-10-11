import { describe, expect, it } from 'vitest';
import type { ChunkedDoc } from '../../src/contracts/index.ts';
import { chunkText } from './helpers.ts';

/** Whole-section view with exact ids, anchors, titles, levels, member chunks and source ranges. */
function sections(d: ChunkedDoc): unknown[] {
  return d.sections.map((s) => ({
    id: s.id,
    anchor: s.anchor,
    title: s.title,
    level: s.level,
    chunkIds: s.chunkIds,
    range: `${s.range.startLine}:${s.range.startColumn}-${s.range.endLine}:${s.range.endColumn}`,
  }));
}

const U = 'docs/test.md';

describe('section sizing: ignored and context chunks are free, limits are inclusive', () => {
  it('ignored and context chunks do not count towards the size that triggers a split at deeper headings', () => {
    const md = [
      '## A',
      '',
      'lead',
      '',
      '<!-- ai-bdd: ignore -->',
      'i'.repeat(30),
      '',
      '<!-- ai-bdd: context -->',
      'c'.repeat(30),
      '',
      'short',
      '',
      '### B',
      '',
      'tail',
      '',
    ].join('\n');
    const d = chunkText(md, { maxSectionChars: 20 });
    expect(d.diagnostics).toEqual([]);
    expect(d.contextChunkIds).toEqual([`${U}#a/p3`]);
    expect(sections(d)).toEqual([
      {
        id: `${U}#a`,
        anchor: 'a',
        title: 'A',
        level: 2,
        // 1 (A) + 4 (lead) + 5 (short) + 1 (B) + 4 (tail) = 15 characters; the 60 characters of ignored and context text are free
        chunkIds: [`${U}#a/h`, `${U}#a/p1`, `${U}#a/p4`, `${U}#a/b/h`, `${U}#a/b/p1`],
        range: '1:1-15:5',
      },
    ]);
    // excluded chunks still belong to the section that holds them
    expect(d.chunks.map((c) => c.sectionId)).toEqual(Array.from({ length: 7 }, () => `${U}#a`));
  });

  it('a section whose size equals maxSectionChars is kept whole, one more character splits it at the deeper heading', () => {
    const md = ['## A', '', 'xxxxx', '', '### B', '', 'yyyyy', ''].join('\n');
    // 'A' + 'xxxxx' + 'B' + 'yyyyy' = 12 characters
    const whole = chunkText(md, { maxSectionChars: 12 });
    expect(whole.diagnostics).toEqual([]);
    expect(sections(whole)).toEqual([
      {
        id: `${U}#a`,
        anchor: 'a',
        title: 'A',
        level: 2,
        chunkIds: [`${U}#a/h`, `${U}#a/p1`, `${U}#a/b/h`, `${U}#a/b/p1`],
        range: '1:1-7:6',
      },
    ]);
    const split = chunkText(md, { maxSectionChars: 11 });
    expect(split.diagnostics).toEqual([]);
    expect(sections(split)).toEqual([
      { id: `${U}#a`, anchor: 'a', title: 'A', level: 2, chunkIds: [`${U}#a/h`, `${U}#a/p1`], range: '1:1-3:6' },
      { id: `${U}#a/b`, anchor: 'a/b', title: 'B', level: 3, chunkIds: [`${U}#a/b/h`, `${U}#a/b/p1`], range: '5:1-7:6' },
    ]);
    expect(split.chunks.map((c) => c.sectionId)).toEqual([`${U}#a`, `${U}#a`, `${U}#a/b`, `${U}#a/b`]);
  });

  it('chunk-boundary parts are filled up to exactly maxSectionChars and the next chunk starts a new part', () => {
    const md = ['aaaaa', '', 'bbbbb', '', 'ccccc', ''].join('\n');
    const d = chunkText(md, { maxSectionChars: 10 });
    expect(d.diagnostics).toEqual([]);
    expect(sections(d)).toEqual([
      { id: `${U}#_preamble/part-1`, anchor: '_preamble/part-1', title: 'Preamble (part 1)', level: 0, chunkIds: [`${U}#_preamble/p1`, `${U}#_preamble/p2`], range: '1:1-3:6' },
      { id: `${U}#_preamble/part-2`, anchor: '_preamble/part-2', title: 'Preamble (part 2)', level: 0, chunkIds: [`${U}#_preamble/p3`], range: '5:1-5:6' },
    ]);
    expect(d.chunks.map((c) => c.sectionId)).toEqual([`${U}#_preamble/part-1`, `${U}#_preamble/part-1`, `${U}#_preamble/part-2`]);
  });

  it('a chunk exactly maxSectionChars long is not oversized; one character more is DOC_CHUNK_TOO_LARGE', () => {
    const exact = chunkText(['aaaaa', '', 'bbbbb', '', 'ccccc', ''].join('\n'), { maxSectionChars: 5 });
    expect(exact.diagnostics).toEqual([]);
    expect(sections(exact)).toEqual([
      { id: `${U}#_preamble/part-1`, anchor: '_preamble/part-1', title: 'Preamble (part 1)', level: 0, chunkIds: [`${U}#_preamble/p1`], range: '1:1-1:6' },
      { id: `${U}#_preamble/part-2`, anchor: '_preamble/part-2', title: 'Preamble (part 2)', level: 0, chunkIds: [`${U}#_preamble/p2`], range: '3:1-3:6' },
      { id: `${U}#_preamble/part-3`, anchor: '_preamble/part-3', title: 'Preamble (part 3)', level: 0, chunkIds: [`${U}#_preamble/p3`], range: '5:1-5:6' },
    ]);

    const over = chunkText(['aaaaaa', '', 'b', ''].join('\n'), { maxSectionChars: 5 });
    expect(over.diagnostics).toEqual([
      {
        code: 'DOC_CHUNK_TOO_LARGE',
        severity: 'warning',
        message: 'chunk is 6 characters, over the section limit of 5; it becomes its own part',
        uri: U,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 7 },
        details: { chunkId: `${U}#_preamble/p1`, chars: 6, maxSectionChars: 5 },
      },
    ]);
    expect(sections(over)).toEqual([
      { id: `${U}#_preamble/part-1`, anchor: '_preamble/part-1', title: 'Preamble (part 1)', level: 0, chunkIds: [`${U}#_preamble/p1`], range: '1:1-1:7' },
      { id: `${U}#_preamble/part-2`, anchor: '_preamble/part-2', title: 'Preamble (part 2)', level: 0, chunkIds: [`${U}#_preamble/p2`], range: '3:1-3:2' },
    ]);
  });

  it('excluded chunks take no room in a part: an ignored chunk between two others does not push them apart', () => {
    const md = ['aaaaa', '', '<!-- ai-bdd: ignore -->', 'x'.repeat(40), '', 'bbbbb', '', 'ccccc', ''].join('\n');
    const d = chunkText(md, { maxSectionChars: 10 });
    expect(d.diagnostics).toEqual([]);
    expect(sections(d)).toEqual([
      { id: `${U}#_preamble/part-1`, anchor: '_preamble/part-1', title: 'Preamble (part 1)', level: 0, chunkIds: [`${U}#_preamble/p1`, `${U}#_preamble/p3`], range: '1:1-6:6' },
      { id: `${U}#_preamble/part-2`, anchor: '_preamble/part-2', title: 'Preamble (part 2)', level: 0, chunkIds: [`${U}#_preamble/p4`], range: '8:1-8:6' },
    ]);
    // the ignored chunk is still assigned to the part it sits in
    expect(d.chunks.map((c) => c.sectionId)).toEqual([
      `${U}#_preamble/part-1`,
      `${U}#_preamble/part-1`,
      `${U}#_preamble/part-1`,
      `${U}#_preamble/part-2`,
    ]);
  });
});

describe('section ids', () => {
  it('a section that would reuse an id gets the next free numeric suffix', () => {
    // 'A' splits into parts a/part-1 and a/part-2; the level 3 heading "Part 1" is a section of its own with the same anchor
    const md = ['# A', '', 'aaaaaa', '', 'bbbbbb', '', '### Part 1', '', 'z', ''].join('\n');
    const d = chunkText(md, { sectionDepth: 3, maxSectionChars: 8 });
    expect(d.diagnostics).toEqual([]);
    expect(sections(d)).toEqual([
      { id: `${U}#a/part-1`, anchor: 'a/part-1', title: 'A (part 1)', level: 1, chunkIds: [`${U}#a/h`, `${U}#a/p1`], range: '1:1-3:7' },
      { id: `${U}#a/part-2`, anchor: 'a/part-2', title: 'A (part 2)', level: 1, chunkIds: [`${U}#a/p2`], range: '5:1-5:7' },
      { id: `${U}#a/part-1-2`, anchor: 'a/part-1-2', title: 'Part 1', level: 3, chunkIds: [`${U}#a/part-1/h`, `${U}#a/part-1/p1`], range: '7:1-9:2' },
    ]);
    expect(d.chunks.map((c) => [c.id, c.anchor, c.sectionId])).toEqual([
      [`${U}#a/h`, 'a/h', `${U}#a/part-1`],
      [`${U}#a/p1`, 'a/p1', `${U}#a/part-1`],
      [`${U}#a/p2`, 'a/p2', `${U}#a/part-2`],
      [`${U}#a/part-1/h`, 'a/part-1/h', `${U}#a/part-1-2`],
      [`${U}#a/part-1/p1`, 'a/part-1/p1', `${U}#a/part-1-2`],
    ]);
  });
});

describe('section ranges are the union of the included chunk ranges', () => {
  it('the end is the furthest end even when a later chunk ends earlier (list item with a code block before its text)', () => {
    // the list item spans 1:1-4:4 (up to the end of its own text); its code block child spans 1:3-3:6 and is emitted after it
    const d = chunkText(['- ```', '  x', '  ```', '  p', ''].join('\n'));
    expect(d.chunks.map((c) => [c.id, `${c.range.startLine}:${c.range.startColumn}-${c.range.endLine}:${c.range.endColumn}`])).toEqual([
      [`${U}#_preamble/li1`, '1:1-4:4'],
      [`${U}#_preamble/code1`, '1:3-3:6'],
    ]);
    expect(sections(d)).toEqual([
      { id: `${U}#_preamble`, anchor: '_preamble', title: 'Preamble', level: 0, chunkIds: [`${U}#_preamble/li1`, `${U}#_preamble/code1`], range: '1:1-4:4' },
    ]);
  });

  it('the start is the first included chunk: later chunks that start in an earlier column do not move it', () => {
    // the list item is ignored, so the section starts at its code block (1:3); the next paragraph starts at 7:1
    const md = ['- ```', '  x', '  ```', '  <!-- ai-bdd: ignore -->', '  para', '', 'next', ''].join('\n');
    const d = chunkText(md);
    expect(sections(d)).toEqual([
      { id: `${U}#_preamble`, anchor: '_preamble', title: 'Preamble', level: 0, chunkIds: [`${U}#_preamble/code1`, `${U}#_preamble/p1`], range: '1:3-7:5' },
    ]);
  });

  it('a section covers from its heading to its last chunk, columns included', () => {
    const d = chunkText(['## Title', '', '> quoted', '', '| a |', '|---|', '| bb |', ''].join('\n'));
    expect(sections(d)).toEqual([
      {
        id: `${U}#title`,
        anchor: 'title',
        title: 'Title',
        level: 2,
        chunkIds: [`${U}#title/h`, `${U}#title/bq1`, `${U}#title/tr1`],
        range: '1:1-7:7',
      },
    ]);
  });
});
