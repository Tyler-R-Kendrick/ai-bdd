import { describe, expect, it } from 'vitest';
import { flattenBlocks, inlineText, type MdNode } from '../../src/markdown/text.ts';

const text = (value: string): MdNode => ({ type: 'text', value });
const para = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children });

describe('inlineText: nodes whose children are never read', () => {
  it('a footnote reference contributes nothing even when it carries children', () => {
    expect(inlineText(para(text('a'), { type: 'footnoteReference', value: '1', children: [text('hidden')] }, text('b')))).toBe('ab');
  });

  it('a footnote reference does not stop the traversal of its siblings', () => {
    expect(inlineText(para({ type: 'footnoteReference', children: [text('x')] }, text('after')))).toBe('after');
  });

  it('an unknown inline node with children is traversed in document order (the contrast to the case above)', () => {
    expect(inlineText(para(text('a'), { type: 'mystery', children: [text('b'), text('c')] }, text('d')))).toBe('abcd');
  });
});

describe('flattenBlocks: block kinds that are dropped with their whole subtree', () => {
  const hidden = (): MdNode[] => [para(text('hidden')), { type: 'code', value: 'hidden code' }];

  it.each(['thematicBreak', 'definition', 'footnoteDefinition', 'yaml'])('%s is dropped with its children, siblings are kept', (type) => {
    const tree: MdNode = { type: 'root', children: [para(text('before')), { type: type, value: 'hidden value', children: hidden() }, para(text('after'))] };
    expect(flattenBlocks(tree)).toBe('before after');
  });

  it('an unknown container is traversed in document order (the contrast to the cases above)', () => {
    const tree: MdNode = { type: 'root', children: [para(text('before')), { type: 'mystery', children: hidden() }, para(text('after'))] };
    expect(flattenBlocks(tree)).toBe('before hidden hidden code after');
  });
});
