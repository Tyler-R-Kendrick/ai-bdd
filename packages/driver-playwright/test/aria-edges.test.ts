import { describe, expect, it } from 'vitest';
import { parseAriaSnapshot, pruneWrappers } from '../src/index.ts';
import { tokenizeLines } from '../src/aria.ts';

/** Edge cases of the aria-snapshot grammar that the live Chromium goldens never produce (pure parser, no browser). */
describe('parseAriaSnapshot edge cases', () => {
  it('R-AG4: double-quoted values decode every escape Playwright emits (\\b \\f \\n \\r \\t \\xNN \\uNNNN \\" and unknown escapes)', () => {
    const [n] = parseAriaSnapshot(String.raw`- paragraph: "a\bb\fc\nd\re\tf\x41géh\"i\qj"`);
    expect(n?.text).toBe('a\bb\fc\nd\re\tfAgéh"iqj');
  });

  it('R-AG4: single-quoted values unescape doubled quotes; unterminated or half-quoted scalars stay verbatim', () => {
    const nodes = parseAriaSnapshot([
      `- paragraph: 'it''s fine'`,
      `- paragraph: '`,
      `- paragraph: 'abc`,
      `- paragraph: "abc" tail`,
    ].join('\n'));
    expect(nodes.map((n) => n.text)).toEqual(["it's fine", "'", "'abc", '"abc" tail']);
  });

  it('R-AG4: a quoted name that is not valid JSON falls back to the lenient decoder', () => {
    const [n] = parseAriaSnapshot('- button "a\\x41b" [ref=e1]');
    expect(n).toMatchObject({ role: 'button', name: 'aAb', ref: 'e1' });
  });

  it('R-AG4: an unclosed attribute bracket ends key parsing: the attribute is ignored and the node gets a synthetic ref', () => {
    const [n] = parseAriaSnapshot('- button "x" [disabled');
    expect(n).toMatchObject({ role: 'button', name: 'x', ref: 'n1', states: {} });
  });

  it('R-AG4: unknown tokens in a key (for example a regex name) are skipped without losing later attributes', () => {
    const [n] = parseAriaSnapshot('- button /re+gex/ [disabled] [ref=e5]');
    expect(n).toMatchObject({ role: 'button', name: '', ref: 'e5', states: { disabled: true } });
  });

  it('R-AG4: trailing spaces after the last token are ignored', () => {
    const [n] = parseAriaSnapshot('- button "x"   ');
    expect(n).toMatchObject({ role: 'button', name: 'x', ref: 'n1' });
  });

  it('R-AG4: invalid, busy, active, expanded, selected and mixed states map onto node states', () => {
    const [n] = parseAriaSnapshot('- textbox "t" [invalid=grammar] [busy] [active] [expanded] [selected] [checked=mixed] [pressed=mixed] [ref=e1]');
    expect(n?.states).toEqual({ invalid: true, busy: true, focused: true, expanded: true, selected: true, checked: 'mixed', pressed: 'mixed' });
  });

  it('R-AG4: a non-numeric level is ignored', () => {
    const [n] = parseAriaSnapshot('- heading "H" [level=x] [ref=e1]');
    expect(n?.level).toBeUndefined();
  });

  it('R-AG4: a bare "text" line becomes an empty text node', () => {
    const nodes = parseAriaSnapshot('- text');
    expect(nodes).toEqual([{ ref: 'n1', role: 'text', name: '', text: '', states: {}, depth: 0 }]);
  });

  it('R-AG4: single-quoted whole keys can carry an inline value, and a colon without a space carries none', () => {
    expect(tokenizeLines(`- 'button "a: b"': hello`)).toEqual([{ depth: 0, key: 'button "a: b"', value: 'hello', hasColon: true }]);
    expect(tokenizeLines(`- 'button "a: b"':`)).toEqual([{ depth: 0, key: 'button "a: b"', value: undefined, hasColon: true }]);
    expect(tokenizeLines(`- 'button "a: b"':x`)).toEqual([{ depth: 0, key: 'button "a: b"', value: undefined, hasColon: true }]);
    expect(tokenizeLines(`- 'button "it''s"'`)).toEqual([{ depth: 0, key: `button "it's"`, value: undefined, hasColon: false }]);
    const [n] = parseAriaSnapshot(`- 'textbox "a: b" [ref=e1]': val`);
    expect(n).toMatchObject({ role: 'textbox', name: 'a: b', value: 'val', ref: 'e1' });
  });

  it('R-AG4: tokenizeLines keeps depth from the indent, tolerates CRLF and skips lines that are not list items', () => {
    expect(tokenizeLines('- a\r\n    - b: c\r\nnot a list item\r\n  -nospace')).toEqual([
      { depth: 0, key: 'a', value: undefined, hasColon: false },
      { depth: 2, key: 'b', value: 'c', hasColon: true },
    ]);
  });

  it('R-AG4: an elided name is built from named children and inline text, skipping unnamed children', () => {
    const nodes = parseAriaSnapshot([
      '- link [ref=e1]:',
      '  - img "Logo" [ref=e2]',
      '  - img [ref=e3]',
      '  - strong [ref=e4]: bold',
      '  - generic [ref=e5]: loose',
      '  - text: tail',
    ].join('\n'));
    expect(nodes[0]?.name).toBe('Logo bold tail');
  });

  it('R-AG4: an elided name stays empty when no child carries text, and does not read past the subtree', () => {
    const nodes = parseAriaSnapshot(['- button [ref=e1]:', '  - img [ref=e2]', '- paragraph: sibling text'].join('\n'));
    expect(nodes[0]?.name).toBe('');
  });

  it('R-AG4: a combobox takes the selected option as its value; unselected options and later siblings do not count', () => {
    const nodes = parseAriaSnapshot([
      '- combobox "A" [ref=e1]:',
      '  - option "One" [ref=e2]',
      '  - option "Two" [selected] [ref=e3]',
      '- combobox "B" [ref=e4]:',
      '  - option "Three" [ref=e5]',
      '- combobox "C" [ref=e6]: typed',
      '  - option "Four" [selected] [ref=e7]',
      '- option "Five" [selected] [ref=e8]',
    ].join('\n'));
    expect(nodes.filter((n) => n.role === 'combobox').map((n) => [n.name, n.value])).toEqual([['A', 'Two'], ['B', undefined], ['C', 'typed']]);
  });
});

describe('pruneWrappers edge cases', () => {
  it('R-AG4: wrappers keep a child attached to the nearest kept ancestor with depth recomputed; named and url-bearing generics stay', () => {
    const nodes = pruneWrappers(parseAriaSnapshot([
      '- navigation "Nav" [ref=e1]:',
      '  - generic [ref=e2]:',
      '    - generic [ref=e3]:',
      '      - link "Deep" [ref=e4]:',
      '        - /url: /deep',
      '  - generic "Named" [ref=e5]:',
      '    - button "Inner" [ref=e6]',
    ].join('\n')));
    expect(nodes.map((n) => [n.ref, n.depth, n.parentRef, n.url])).toEqual([
      ['e1', 0, undefined, undefined],
      ['e4', 1, 'e1', '/deep'],
      ['e5', 1, 'e1', undefined],
      ['e6', 2, 'e5', undefined],
    ]);
  });
});
