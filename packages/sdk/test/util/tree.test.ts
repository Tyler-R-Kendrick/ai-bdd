import { describe, expect, it } from 'vitest';
import type { NodeStates, ObservedNode } from '../../src/contracts/index.ts';
import { renderTree, sha256Hex, treeHash } from '../../src/util/index.ts';

function node(over: Partial<ObservedNode> & { role: string }): ObservedNode {
  return { ref: 'e1', name: '', states: {}, depth: 0, ...over };
}

const noRefs = { refs: false };

describe('renderTree', () => {
  it('renders nothing for no nodes', () => {
    expect(renderTree([], noRefs)).toBe('');
  });

  it('renders a bare node as "- role" and indents two spaces per depth level', () => {
    expect(renderTree([node({ role: 'main' })], noRefs)).toBe('- main');
    expect(renderTree([node({ role: 'list' }), node({ role: 'listitem', depth: 1 }), node({ role: 'link', depth: 3 })], noRefs)).toBe(
      '- list\n  - listitem\n      - link',
    );
  });

  it('joins nodes with a single newline and no trailing newline', () => {
    const out = renderTree([node({ role: 'a' }), node({ role: 'b' })], noRefs);
    expect(out).toBe('- a\n- b');
    expect(out.endsWith('\n')).toBe(false);
  });

  it('renders the accessible name as a JSON string, and omits an empty name', () => {
    expect(renderTree([node({ role: 'button', name: 'Save "all"' })], noRefs)).toBe('- button "Save \\"all\\""');
    expect(renderTree([node({ role: 'button', name: '' })], noRefs)).toBe('- button');
  });

  it('renders the heading level, including level 0, only when present', () => {
    expect(renderTree([node({ role: 'heading', name: 'T', level: 2 })], noRefs)).toBe('- heading "T" [level=2]');
    expect(renderTree([node({ role: 'heading', level: 0 })], noRefs)).toBe('- heading [level=0]');
    expect(renderTree([node({ role: 'heading', name: 'T' })], noRefs)).toBe('- heading "T"');
  });

  it('renders true states as [name], other truthy values as [name=value], never false or undefined, sorted by name', () => {
    const states = { selected: true, checked: 'mixed', disabled: false, expanded: undefined, busy: true, pressed: false, invalid: true, focused: true } as unknown as NodeStates;
    expect(renderTree([node({ role: 'checkbox', name: 'x', states })], noRefs)).toBe('- checkbox "x" [busy] [checked=mixed] [focused] [invalid] [selected]');
  });

  it('sorts states whatever the insertion order (all permutations of three states)', () => {
    const keys: [string, boolean][] = [['busy', true], ['focused', true], ['selected', true]];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const p of perms) {
      const states = Object.fromEntries(p.map((i) => keys[i] as [string, boolean])) as NodeStates;
      expect(renderTree([node({ role: 'r', states })], noRefs)).toBe('- r [busy] [focused] [selected]');
    }
  });

  it('sorts many states (more than a small insertion sort handles) by name', () => {
    const names = Array.from({ length: 80 }, (_, i) => `s${String((i * 37) % 80).padStart(2, '0')}`);
    const states = Object.fromEntries(names.map((k) => [k, true])) as NodeStates;
    const expected = [...names].sort().map((k) => `[${k}]`).join(' ');
    expect(renderTree([node({ role: 'r', states })], noRefs)).toBe(`- r ${expected}`);
    const reversed = Object.fromEntries([...names].sort().reverse().map((k) => [k, true])) as NodeStates;
    expect(renderTree([node({ role: 'r', states: reversed })], noRefs)).toBe(`- r ${expected}`);
  });

  it('renders a mixed state through its value', () => {
    expect(renderTree([node({ role: 'r', states: { pressed: 'mixed' } })], noRefs)).toBe('- r [pressed=mixed]');
  });

  it('renders the value, also an empty one, as value=<json>', () => {
    expect(renderTree([node({ role: 'textbox', name: 'Q', value: 'a b' })], noRefs)).toBe('- textbox "Q" value="a b"');
    expect(renderTree([node({ role: 'textbox', name: 'Q', value: '' })], noRefs)).toBe('- textbox "Q" value=""');
    expect(renderTree([node({ role: 'textbox', name: 'Q' })], noRefs)).toBe('- textbox "Q"');
  });

  it('renders text only when it differs from the name', () => {
    expect(renderTree([node({ role: 'link', name: 'Home', text: 'Home' })], noRefs)).toBe('- link "Home"');
    expect(renderTree([node({ role: 'link', name: 'Home', text: 'Go home' })], noRefs)).toBe('- link "Home" text="Go home"');
    expect(renderTree([node({ role: 'generic', name: 'Home' })], noRefs)).toBe('- generic "Home"');
    expect(renderTree([node({ role: 'generic', text: 'hi' })], noRefs)).toBe('- generic text="hi"');
    expect(renderTree([node({ role: 'generic', text: '' })], noRefs)).toBe('- generic');
    expect(renderTree([node({ role: 'generic', name: 'N', text: '' })], noRefs)).toBe('- generic "N" text=""');
  });

  it('renders testId and url as bracketed JSON strings, only when present', () => {
    expect(renderTree([node({ role: 'link', name: 'L', testId: 'nav-home', url: 'https://a.test/x?y=1' })], noRefs)).toBe(
      '- link "L" [testid="nav-home"] [url="https://a.test/x?y=1"]',
    );
    expect(renderTree([node({ role: 'link', testId: '' })], noRefs)).toBe('- link [testid=""]');
    expect(renderTree([node({ role: 'link', url: '' })], noRefs)).toBe('- link [url=""]');
    expect(renderTree([node({ role: 'link' })], noRefs)).toBe('- link');
  });

  it('appends [ref=...] last, and only when refs are requested', () => {
    const n = node({ role: 'button', name: 'Go', ref: 'e42', depth: 1, level: 1, states: { focused: true }, value: 'v', text: 't', testId: 'id', url: 'u' });
    expect(renderTree([n], noRefs)).toBe('  - button "Go" [level=1] [focused] value="v" text="t" [testid="id"] [url="u"]');
    expect(renderTree([n], { refs: true })).toBe('  - button "Go" [level=1] [focused] value="v" text="t" [testid="id"] [url="u"] [ref=e42]');
    expect(renderTree([node({ role: 'a', ref: 'e7' })], { refs: true })).toBe('- a [ref=e7]');
  });
});

describe('treeHash', () => {
  const nodes = [node({ role: 'main', ref: 'e1' }), node({ role: 'button', name: 'Go', ref: 'e2', depth: 1 })];

  it('is the SHA-256 of the tree rendered without refs', () => {
    expect(treeHash(nodes)).toBe(sha256Hex('- main\n  - button "Go"'));
  });

  it('does not depend on refs but does depend on content', () => {
    const renumbered = nodes.map((n, i) => ({ ...n, ref: `x${i + 10}` }));
    expect(treeHash(renumbered)).toBe(treeHash(nodes));
    expect(treeHash(renumbered)).not.toBe(sha256Hex(renderTree(renumbered, { refs: true })));
    expect(treeHash([...nodes, node({ role: 'footer' })])).not.toBe(treeHash(nodes));
  });

  it('hashes the empty tree as the hash of the empty string', () => {
    expect(treeHash([])).toBe(sha256Hex(''));
  });
});
