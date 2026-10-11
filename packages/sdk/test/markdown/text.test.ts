import { describe, expect, it } from 'vitest';
import { flattenBlocks, inlineText, type MdNode } from '../../src/markdown/text.ts';
import { chunkText } from './helpers.ts';

const text = (value?: string): MdNode => (value === undefined ? { type: 'text' } : { type: 'text', value });
const para = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children });

describe('inlineText', () => {
  it('keeps text and inline code, in document order, through nested emphasis and links', () => {
    const tree: MdNode = para(text('a '), { type: 'strong', children: [text('b '), { type: 'emphasis', children: [text('c')] }] }, text(' '), { type: 'link', children: [text('d')] }, { type: 'inlineCode', value: ' e' });
    expect(inlineText(tree)).toBe('a b c d e');
  });

  it('a text node without a value contributes nothing', () => {
    expect(inlineText(para(text('x'), text(), text('y')))).toBe('xy');
  });

  it('a hard break becomes one space', () => {
    expect(inlineText(para(text('a'), { type: 'break' }, text('b')))).toBe('a b');
  });

  it('images and image references contribute their alt text, or nothing when alt is null or missing', () => {
    const tree = para({ type: 'image', alt: 'logo' }, { type: 'imageReference', alt: ' ref' }, { type: 'image', alt: null }, { type: 'image' });
    expect(inlineText(tree)).toBe('logo ref');
  });

  it('footnote references and unknown leaf nodes contribute nothing', () => {
    expect(inlineText(para(text('a'), { type: 'footnoteReference', value: '1' }, { type: 'mystery' }, text('b')))).toBe('ab');
  });

  it('inline html is reported to the callback with its raw value and never becomes text', () => {
    const seen: string[] = [];
    const tree = para(text('a'), { type: 'html', value: '<b>' }, text('c'), { type: 'html' });
    expect(inlineText(tree, (v) => seen.push(v))).toBe('ac');
    expect(seen).toEqual(['<b>']);
  });

  it('inline html without a callback is silently skipped', () => {
    expect(inlineText(para(text('a'), { type: 'html', value: '<!-- ai-bdd: ignore -->' }, text('b')))).toBe('ab');
  });

  it('is iterative: 50000 levels of nesting do not overflow the stack', () => {
    let node: MdNode = text('deep');
    for (let i = 0; i < 50_000; i++) node = { type: 'emphasis', children: [node] };
    expect(inlineText(node)).toBe('deep');
  });
});

describe('flattenBlocks', () => {
  it('joins one piece per leaf block with single spaces, in document order', () => {
    const tree: MdNode = {
      type: 'blockquote',
      children: [
        { type: 'heading', depth: 2, children: [text('Head')] },
        para(text('first')),
        { type: 'list', children: [{ type: 'listItem', children: [para(text('one'))] }, { type: 'listItem', children: [para(text('two'))] }] },
        para(text('last')),
      ],
    };
    expect(flattenBlocks(tree)).toBe('Head first one two last');
  });

  it('code blocks keep their literal value, a code node without a value adds nothing', () => {
    const tree: MdNode = { type: 'blockquote', children: [para(text('before')), { type: 'code', value: 'const x = 1;' }, { type: 'code' }, para(text('after'))] };
    expect(flattenBlocks(tree)).toBe('before const x = 1; after');
  });

  it('tables contribute one piece per row with the cells joined by a space', () => {
    const cell = (v: string): MdNode => ({ type: 'tableCell', children: [text(v)] });
    const tree: MdNode = {
      type: 'table',
      children: [
        { type: 'tableRow', children: [cell('h1'), cell('h2')] },
        { type: 'tableRow', children: [cell('a'), cell('b')] },
        { type: 'tableRow' },
      ],
    };
    expect(flattenBlocks(tree)).toBe('h1 h2 a b');
    expect(flattenBlocks({ type: 'table' })).toBe('');
  });

  it('thematic breaks, definitions, footnote definitions and yaml are dropped, including their children', () => {
    const tree: MdNode = {
      type: 'root',
      children: [
        para(text('keep')),
        { type: 'thematicBreak' },
        { type: 'definition', children: [text('hidden-def')] },
        { type: 'footnoteDefinition', children: [para(text('hidden-note'))] },
        { type: 'yaml', value: 'hidden: yaml' },
      ],
    };
    expect(flattenBlocks(tree)).toBe('keep');
  });

  it('html blocks are reported to the callback and never become text', () => {
    const html: MdNode = { type: 'html', value: '<!-- ai-bdd: ignore -->' };
    const seen: MdNode[] = [];
    expect(flattenBlocks({ type: 'blockquote', children: [para(text('a')), html, para(text('b'))] }, (n) => seen.push(n))).toBe('a b');
    expect(seen).toEqual([html]);
    expect(flattenBlocks({ type: 'blockquote', children: [para(text('a')), html] })).toBe('a');
  });

  it('a childless unknown container yields the empty string', () => {
    expect(flattenBlocks({ type: 'blockquote' })).toBe('');
  });

  it('normalizes whitespace and Unicode of the joined text', () => {
    const tree: MdNode = { type: 'blockquote', children: [para(text('  é   x ')), para(text('y\t\tz'))] };
    expect(flattenBlocks(tree)).toBe('é x y z');
  });
});

describe('a blockquote chunk (flattenBlocks through the chunker)', () => {
  it('R-EX4: flattens code, tables, lists, nested quotes and images and drops rules, definitions and html', () => {
    const md = [
      '# T',
      '',
      '> intro *em* ![img alt](u.png) line  ',
      '> break',
      '>',
      '> ```js',
      '> const x = 1;',
      '> ```',
      '>',
      '> | a | b |',
      '> | - | - |',
      '> | 1 | 2 |',
      '>',
      '> - item one',
      '>   - nested',
      '>',
      '> ---',
      '>',
      '> [ref]: http://x',
      '>',
      '> > inner quote',
      '>',
      '> <div>html</div>',
      '',
    ].join('\n');
    const d = chunkText(md);
    const quotes = d.chunks.filter((c) => c.kind === 'blockquote');
    expect(quotes.map((c) => c.text)).toEqual(['intro em img alt line break const x = 1; a b 1 2 item one nested inner quote']);
  });
});
