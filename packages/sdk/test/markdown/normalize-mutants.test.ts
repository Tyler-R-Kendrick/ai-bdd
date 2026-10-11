import { describe, expect, it } from 'vitest';
import { MAX_CONTAINER_DEPTH, MAX_DOC_DELIMITERS, MAX_INDENT_COLUMNS, MAX_OPEN_LABEL_CHARS, MAX_RUN_DELIMITERS, docSha256, limitNesting, neutralizeHostile, normalizeDocText, restorePlaceholders } from '../../src/markdown/normalize.ts';
import { sha256Hex } from '../../src/util/index.ts';

/** The n-th placeholder candidate (private use area, in the order the pool hands them out). */
const ph = (n: number): string => String.fromCharCode(0xe000 + n);
const entries = (m: Map<string, string>): Array<[string, string]> => [...m.entries()];

describe('normalizeDocText', () => {
  it.each<[string, string, string]>([
    ['empty', '', ''],
    ['no carriage return', 'a\nb\n', 'a\nb\n'],
    ['CRLF', 'a\r\nb\r\n', 'a\nb\n'],
    ['lone CR', 'a\rb\r', 'a\nb\n'],
    ['CR CR LF is two line breaks', 'a\r\r\nb', 'a\n\nb'],
    ['LF CR is two line breaks', 'a\n\rb', 'a\n\nb'],
    ['one BOM removed', '﻿a\r\nb', 'a\nb'],
    ['only the first BOM removed', '﻿﻿a', '﻿a'],
    ['an inner BOM stays', 'a﻿b', 'a﻿b'],
    ['BOM alone', '﻿', ''],
    ['NEL, LS and PS are not line endings', 'a\u0085b c d', 'a\u0085b c d'],
  ])('%s', (_name, raw, expected) => {
    expect(normalizeDocText(raw)).toBe(expected);
  });

  it('the digest ignores the BOM and the line ending style', () => {
    expect(docSha256('﻿a\r\nb\rc')).toBe(sha256Hex('a\nb\nc'));
    expect(docSha256('a\nb\nc')).toBe(sha256Hex('a\nb\nc'));
  });
});

/** Container depth of `tail` as seen by limitNesting: the smallest prefix of block quotes that pushes the line over the limit. */
function depthOf(tail: string, suffix: string): number {
  for (let n = 0; n <= MAX_CONTAINER_DEPTH + 1; n++) {
    const r = limitNesting(`${'> '.repeat(n)}${tail}${suffix}`);
    if (r.blanked.length > 0) return MAX_CONTAINER_DEPTH + 1 - n;
  }
  return -1;
}

const DEPTH_ROWS: Array<[string, number]> = [
  ['', 0],
  ['a', 0],
  ['>', 1],
  ['>>', 2],
  ['> >', 2],
  ['\t>', 1],
  [' \t> ', 1],
  // bullet markers: followed by a space, a tab or the end of the line
  ['- x', 1],
  ['* x', 1],
  ['+ x', 1],
  ['-\tx', 1],
  ['*\tx', 1],
  ['+\tx', 1],
  ['-', 1],
  ['*', 1],
  ['+', 1],
  ['- ', 1],
  ['- - x', 2],
  ['-x', 0],
  ['*x', 0],
  ['+x', 0],
  ['--', 0],
  ['-- x', 0],
  ['a x', 0],
  ['a\tx', 0],
  ['/ x', 0],
  [' -x', 0],
  ['\t-x', 0],
  [' *x', 0],
  ['\t+x', 0],
  // ordered markers: up to 10 digits, then `.` or `)`, then a space, a tab or the end of the line
  ['1. x', 1],
  ['1) x', 1],
  ['0. x', 1],
  ['9. x', 1],
  ['12. x', 1],
  ['1.', 1],
  ['1)', 1],
  ['1.\tx', 1],
  ['1)\tx', 1],
  ['1. 2. 3. x', 3],
  ['> - 1. x', 3],
  ['1234567890. x', 1],
  ['1234567890) x', 1],
  ['12345678901. x', 0],
  ['12345678901) x', 0],
  ['1.x', 0],
  ['1)x', 0],
  ['1x', 0],
  ['1', 0],
  ['1 x', 0],
  ['1abcdefghi. x', 0],
  ['. x', 0],
  ['.', 0],
  [') x', 0],
  [')', 0],
  ['/. x', 0],
  [':. x', 0],
  ['a. x', 0],
  ['a) x', 0],
  ['1,x', 0],
  [' 1.x', 0],
  ['\t1)x', 0],
];

describe('limitNesting container depth', () => {
  it.each(DEPTH_ROWS)('the line tail %j opens %i containers (last line)', (tail, depth) => {
    expect(depthOf(tail, '')).toBe(depth);
  });

  it.each(DEPTH_ROWS)('the line tail %j opens %i containers (followed by another line)', (tail, depth) => {
    expect(depthOf(tail, '\nz')).toBe(depth);
  });

  it('exactly the maximum depth is parsed, one more is blanked', () => {
    const ok = `${'> '.repeat(MAX_CONTAINER_DEPTH)}x`;
    expect(limitNesting(ok)).toEqual({ text: ok, blanked: [] });
    expect(limitNesting(`${'> '.repeat(MAX_CONTAINER_DEPTH + 1)}x`)).toEqual({ text: '', blanked: [1] });
    expect(limitNesting(`${'- '.repeat(MAX_CONTAINER_DEPTH)}x`).blanked).toEqual([]);
    expect(limitNesting(`${'- '.repeat(MAX_CONTAINER_DEPTH + 1)}x`).blanked).toEqual([1]);
    expect(limitNesting(`${'1. '.repeat(MAX_CONTAINER_DEPTH + 1)}x`).blanked).toEqual([1]);
    expect(limitNesting(`${'>'.repeat(MAX_CONTAINER_DEPTH + 1)}`).blanked).toEqual([1]);
    expect(limitNesting(`${'>'.repeat(MAX_CONTAINER_DEPTH)}`).blanked).toEqual([]);
  });

  it('blanks only the deep lines, keeps every other line and reports every blanked line number', () => {
    const deep = '> '.repeat(MAX_CONTAINER_DEPTH + 5);
    const text = ['a', deep + 'x', 'b', '', deep, '> quote', 'c'].join('\n');
    expect(limitNesting(text)).toEqual({ text: ['a', '', 'b', '', '', '> quote', 'c'].join('\n'), blanked: [2, 5] });
    expect(limitNesting(`${deep}1\n${deep}2\n${deep}3`)).toEqual({ text: '\n\n', blanked: [1, 2, 3] });
  });

  it('empty and single-line inputs', () => {
    expect(limitNesting('')).toEqual({ text: '', blanked: [] });
    expect(limitNesting('\n')).toEqual({ text: '\n', blanked: [] });
    expect(limitNesting('plain')).toEqual({ text: 'plain', blanked: [] });
  });
});

describe('neutralizeHostile: a list item or a blank line starts a new run', () => {
  const doc = (line: string): string => `${'*'.repeat(600)}\n${line}\n${'*'.repeat(500)}`;
  const over = (line: string): number => neutralizeHostile(doc(line)).delimiters;

  it.each<[string]>([['- a'], ['+ a'], ['* a'], ['1. a'], ['1) a'], ['   - a'], ['   1) a'], [' + a'], [''], ['   '], ['\t'], [' \t '], ['\t\t\t\t\t']])('the line %j resets the delimiter run', (line) => {
    expect(over(line)).toBe(0);
  });

  it.each<[string, number]>([
    ['plain', 100],
    ['-a', 100],
    ['- ', 100],
    ['-', 100],
    ['+a', 100],
    ['+', 100],
    ['*a', 101],
    ['* ', 101],
    ['2. a', 100],
    ['1.a', 100],
    ['1)a', 100],
    ['1 a', 100],
    ['10. a', 100],
    ['11) a', 100],
    ['1.', 100],
    ['1x y', 100],
    ['-ab', 100],
    [' -ab', 100],
    ['    - a', 100],
    ['     - a', 100],
    ['\t- a', 100],
    ['-\ta', 100],
    ['*\ta', 101],
    ['x - a', 100],
  ])('the line %j does not reset the run: %i delimiters are over the budget', (line, excess) => {
    expect(over(line)).toBe(excess);
  });

  it('the excess delimiters are the last ones of the run', () => {
    const r = neutralizeHostile(doc('plain'));
    expect(r.text).toBe(`${'*'.repeat(600)}\nplain\n${'*'.repeat(400)}${ph(0).repeat(100)}`);
    expect(entries(r.restore)).toEqual([[ph(0), '*']]);
  });

  const opener = (line: string): ReturnType<typeof neutralizeHostile> => neutralizeHostile(`[${'x'.repeat(MAX_OPEN_LABEL_CHARS - 5)}\n${line}\nyyyyyyyyyy`);
  it.each<[string, number]>([
    ['- a', 0],
    ['1. a', 0],
    ['', 0],
    ['  ', 0],
    ['plain', 1],
    ['-a', 1],
  ])('the unclosed label opener survives the line %j only if it is not a list item or blank (%i)', (line, delimiters) => {
    const r = opener(line);
    expect(r.delimiters).toBe(delimiters);
    expect(r.text.charAt(0)).toBe(delimiters === 1 ? ph(0) : '[');
  });
});

describe('neutralizeHostile: the delimiter characters', () => {
  it.each(['[', ']', '*', '~', '_'])('%s beyond the run budget becomes a placeholder, the budget itself is kept', (ch) => {
    const r = neutralizeHostile(ch.repeat(MAX_RUN_DELIMITERS + 1));
    expect(r.text).toBe(ch.repeat(MAX_RUN_DELIMITERS) + ph(0));
    expect(r.delimiters).toBe(1);
    expect(r.exhausted).toBe(false);
    expect(r.indented).toEqual([]);
    expect(entries(r.restore)).toEqual([[ph(0), ch]]);
  });

  it.each(['[', ']', '*', '~', '_'])('exactly the run budget of %s is left alone', (ch) => {
    const text = ch.repeat(MAX_RUN_DELIMITERS);
    expect(neutralizeHostile(text)).toEqual({ text, restore: new Map(), indented: [], delimiters: 0, exhausted: false });
  });

  it('other characters are never counted', () => {
    const text = '(){}<>`!#|-+.,:;"\'\\/ab9 ​‮'.repeat(120);
    expect(neutralizeHostile(text)).toEqual({ text, restore: new Map(), indented: [], delimiters: 0, exhausted: false });
  });

  it('one placeholder per distinct original character, in order of position', () => {
    const r = neutralizeHostile(`${'*'.repeat(MAX_RUN_DELIMITERS)}*_*~_`);
    expect(r.text).toBe(`${'*'.repeat(MAX_RUN_DELIMITERS)}${ph(0)}${ph(1)}${ph(0)}${ph(2)}${ph(1)}`);
    expect(entries(r.restore)).toEqual([
      [ph(0), '*'],
      [ph(1), '_'],
      [ph(2), '~'],
    ]);
    expect(r.delimiters).toBe(5);
  });

  it('a character already in the document is never handed out as a placeholder', () => {
    const r = neutralizeHostile(`${ph(0)}${ph(2)}\n${'*'.repeat(MAX_RUN_DELIMITERS)}*_`);
    expect(r.text).toBe(`${ph(0)}${ph(2)}\n${'*'.repeat(MAX_RUN_DELIMITERS)}${ph(1)}${ph(3)}`);
    expect(entries(r.restore)).toEqual([
      [ph(1), '*'],
      [ph(3), '_'],
    ]);
  });

  it('the last private use character is a usable placeholder; with none left the text is kept and exhausted is set', () => {
    const allButLast = Array.from({ length: 0xf8ff - 0xe000 }, (_, i) => ph(i)).join('');
    const flood = `${'*'.repeat(MAX_RUN_DELIMITERS)}**`;
    const one = neutralizeHostile(`${allButLast}\n${flood}`);
    expect(one.text).toBe(`${allButLast}\n${'*'.repeat(MAX_RUN_DELIMITERS)}`);
    expect(entries(one.restore)).toEqual([['', '*']]);
    expect(one.exhausted).toBe(false);
    expect(one.delimiters).toBe(2);

    const none = neutralizeHostile(`${allButLast}\n${flood}`);
    expect(none.text).toBe(`${allButLast}\n${flood}`);
    expect(none.restore.size).toBe(0);
    expect(none.exhausted).toBe(true);
    expect(none.delimiters).toBe(2);
  });
});

describe('neutralizeHostile: the document budget', () => {
  it('only the first MAX_DOC_DELIMITERS delimiters of the document are active, whatever the run they are in', () => {
    const runs = MAX_DOC_DELIMITERS / MAX_RUN_DELIMITERS;
    const body = Array.from({ length: runs }, () => '*'.repeat(MAX_RUN_DELIMITERS)).join('\n\n');
    const r = neutralizeHostile(`${body}\n\n*`);
    expect(r.delimiters).toBe(1);
    expect(r.text).toBe(`${body}\n\n${ph(0)}`);
    const more = neutralizeHostile(`${body}\n\n*_~`);
    expect(more.delimiters).toBe(3);
    expect(more.text).toBe(`${body}\n\n${ph(0)}${ph(1)}${ph(2)}`);
    expect(neutralizeHostile(body)).toEqual({ text: body, restore: new Map(), indented: [], delimiters: 0, exhausted: false });
  });
});

describe('neutralizeHostile: unclosed label openers', () => {
  const x = (n: number): string => 'x'.repeat(n);

  it.each<[string, string, string, number]>([
    ['at the limit', `[${x(MAX_OPEN_LABEL_CHARS - 2)}*`, `[${x(MAX_OPEN_LABEL_CHARS - 2)}*`, 0],
    ['one past the limit', `[${x(MAX_OPEN_LABEL_CHARS - 1)}*`, `${ph(0)}${x(MAX_OPEN_LABEL_CHARS - 1)}*`, 1],
    ['long unclosed label, nothing after it', `[${x(1600)}`, `${ph(0)}${x(1600)}`, 1],
    ['closed in time', `[a]${x(1600)}`, `[a]${x(1600)}`, 0],
    ['closed too late', `[${x(1600)}]`, `${ph(0)}${x(1600)}]`, 1],
    ['a star does not close it', `[*${x(1600)}`, `${ph(0)}*${x(1600)}`, 1],
    ['an underscore does not close it', `[_${x(1600)}`, `${ph(0)}_${x(1600)}`, 1],
    ['two long openers', `[[${x(1600)}`, `${ph(0)}${ph(0)}${x(1600)}`, 2],
    ['only the old openers expire', `[${x(1000)}[${x(600)}`, `${ph(0)}${x(1000)}[${x(600)}`, 1],
    ['the distance is not the sum of the offsets', `${x(1000)}[${x(100)}`, `${x(1000)}[${x(100)}`, 0],
    ['a new opener after a late closer is still tracked', `[${x(1600)}][${x(1600)}`, `${ph(0)}${x(1600)}]${ph(0)}${x(1600)}`, 2],
    ['closers pair with the latest opener', `[a[b]${x(1600)}`, `${ph(0)}a[b]${x(1600)}`, 1],
    ['a closer without an opener does nothing', `]]${x(1600)}[`, `]]${x(1600)}[`, 0],
  ])('%s', (_name, text, expected, delimiters) => {
    const r = neutralizeHostile(text);
    expect(r.text).toBe(expected);
    expect(r.delimiters).toBe(delimiters);
    expect(r.restore.size).toBe(delimiters === 0 ? 0 : 1);
  });

  it('an opener of an earlier line expires on a later line', () => {
    const r = neutralizeHostile(`[${x(700)}\n${x(700)}\n${x(100)}`);
    expect(r.text).toBe(`${ph(0)}${x(700)}\n${x(700)}\n${x(100)}`);
    expect(r.delimiters).toBe(1);
  });

  it('openers that expire after later overflow marks are placed back in order (one overflow)', () => {
    const r = neutralizeHostile(`[${'*'.repeat(MAX_RUN_DELIMITERS)}${x(600)}`);
    expect(r.text).toBe(`${ph(0)}${'*'.repeat(MAX_RUN_DELIMITERS - 1)}${ph(1)}${x(600)}`);
    expect(entries(r.restore)).toEqual([
      [ph(0), '['],
      [ph(1), '*'],
    ]);
    expect(r.delimiters).toBe(2);
  });

  it('openers that expire after later overflow marks are placed back in order (several)', () => {
    const r = neutralizeHostile(`[[${'*'.repeat(MAX_RUN_DELIMITERS)}${x(600)}`);
    expect(r.text).toBe(`${ph(0)}${ph(0)}${'*'.repeat(MAX_RUN_DELIMITERS - 2)}${ph(1)}${ph(1)}${x(600)}`);
    expect(entries(r.restore)).toEqual([
      [ph(0), '['],
      [ph(1), '*'],
    ]);
    expect(r.delimiters).toBe(4);
  });

  it('delimiters in order need no reordering', () => {
    const r = neutralizeHostile(`${'*'.repeat(MAX_RUN_DELIMITERS)}**${x(10)}`);
    expect(r.text).toBe(`${'*'.repeat(MAX_RUN_DELIMITERS)}${ph(0)}${ph(0)}${x(10)}`);
  });
});

describe('neutralizeHostile: leading indentation', () => {
  const sp = (n: number): string => ' '.repeat(n);
  const tb = (n: number): string => '\t'.repeat(n);
  const max = MAX_INDENT_COLUMNS;

  it.each<[string, string, string, number[]]>([
    ['exactly the limit of spaces', `${sp(max)}x`, `${sp(max)}x`, []],
    ['one space over', `${sp(max + 1)}x`, `${sp(max)}${ph(0)}x`, [1]],
    ['ten spaces over', `${sp(max + 10)}x`, `${sp(max)}${ph(0).repeat(10)}x`, [1]],
    ['exactly the limit of tabs', `${tb(max / 4)}x`, `${tb(max / 4)}x`, []],
    ['one tab over', `${tb(max / 4 + 1)}x`, `${tb(max / 4)}${ph(0)}x`, [1]],
    ['three tabs over', `${tb(max / 4 + 3)}x`, `${tb(max / 4)}${ph(0).repeat(3)}x`, [1]],
    ['spaces then a tab straddling the limit', `${sp(max - 2)}\t${sp(5)}x`, `${sp(max - 2)}\t${ph(0).repeat(5)}x`, [1]],
    ['a tab then spaces', `\t${sp(max - 4 + 2)}y`, `\t${sp(max - 4 - 2 + 2)}${ph(0).repeat(2)}y`, [1]],
    ['a tab is four columns, not one', `${tb(max / 4)}${sp(1)}x`, `${tb(max / 4)}${ph(0)}x`, [1]],
    ['four spaces less than the limit are not enough', `${sp(max - 4)}\tx`, `${sp(max - 4)}\tx`, []],
    ['a blank line of any width is untouched', `${sp(500)}`, `${sp(500)}`, []],
    ['a blank line of tabs is untouched', `${tb(100)}`, `${tb(100)}`, []],
    ['a blank line is untouched among others', `a\n${sp(500)}\nb`, `a\n${sp(500)}\nb`, []],
    ['only the leading whitespace counts', `x${sp(max + 20)}y`, `x${sp(max + 20)}y`, []],
    ['shallow indentation', '    - item\n        deeper', '    - item\n        deeper', []],
    ['line numbers of every neutralized line', `a\n${sp(max + 5)}b\nc\n${sp(max + 1)}d\n${sp(max)}e`, `a\n${sp(max)}${ph(0).repeat(5)}b\nc\n${sp(max)}${ph(0)}d\n${sp(max)}e`, [2, 4]],
    ['a neutralized line right after a blank line', `\n${sp(max + 1)}d`, `\n${sp(max)}${ph(0)}d`, [2]],
    ['the first line', `${sp(max + 1)}d\ne`, `${sp(max)}${ph(0)}d\ne`, [1]],
  ])('%s', (_name, text, expected, indented) => {
    const r = neutralizeHostile(text);
    expect(r.text).toBe(expected);
    expect(r.indented).toEqual(indented);
    expect(r.delimiters).toBe(0);
    expect(r.exhausted).toBe(false);
    expect(r.restore.size === 0).toBe(indented.length === 0);
  });

  it('the neutralized indentation characters are remembered', () => {
    const r = neutralizeHostile(`${' '.repeat(max + 2)}a\n${'\t'.repeat(max / 4 + 2)}b`);
    expect(entries(r.restore)).toEqual([
      [ph(0), ' '],
      [ph(1), '\t'],
    ]);
    expect(r.text).toBe(`${' '.repeat(max)}${ph(0)}${ph(0)}a\n${'\t'.repeat(max / 4)}${ph(1)}${ph(1)}b`);
  });

  it('indentation and delimiter marks of one document are combined in text order', () => {
    const r = neutralizeHostile(`${' '.repeat(max + 2)}a\n\n${'*'.repeat(MAX_RUN_DELIMITERS + 1)}`);
    expect(r.text).toBe(`${' '.repeat(max)}${ph(0)}${ph(0)}a\n\n${'*'.repeat(MAX_RUN_DELIMITERS)}${ph(1)}`);
    expect(r.indented).toEqual([1]);
    expect(r.delimiters).toBe(1);
  });
});

describe('restorePlaceholders', () => {
  it('an empty map does not even look at the tree', () => {
    let reads = 0;
    const root: Record<string, unknown> = { type: 'root', children: [] };
    Object.defineProperty(root, 'value', {
      get() {
        reads++;
        return 'v';
      },
      set() {
        reads++;
      },
      enumerable: true,
    });
    restorePlaceholders(root, new Map());
    expect(reads).toBe(0);
  });

  it('restores every textual field, at any depth, and nothing else', () => {
    const map = new Map([
      [ph(0), '['],
      [ph(1), '**'],
    ]);
    const field = (): string => `a${ph(0)}b${ph(1)}c${ph(0)}`;
    const restored = 'a[b**c[';
    const leaf = (): Record<string, unknown> => ({ type: 'text', value: field(), alt: field(), title: field(), url: field(), label: field(), lang: field(), meta: field(), name: field(), position: { note: field() } });
    const tree = { type: 'root', value: field(), children: [leaf(), { type: 'paragraph', children: [leaf(), { type: 'emphasis', children: [leaf()] }] }] };
    restorePlaceholders(tree, map);
    const want = (): Record<string, unknown> => ({ type: 'text', value: restored, alt: restored, title: restored, url: restored, label: restored, lang: restored, meta: restored, name: field(), position: { note: field() } });
    expect(tree).toEqual({ type: 'root', value: restored, children: [want(), { type: 'paragraph', children: [want(), { type: 'emphasis', children: [want()] }] }] });
  });

  it('keeps unknown private use characters, non-string fields and odd children', () => {
    const map = new Map([[ph(0), '[']]);
    const tree = {
      type: 'root',
      value: 7,
      alt: null,
      title: undefined,
      url: ['x'],
      children: [undefined, null, 5, 'text', true, { value: `${ph(5)}${ph(0)}`, children: 'not-an-array' }, { children: [{ value: ph(0) }, null, undefined] }, []],
    };
    restorePlaceholders(tree, map);
    expect(tree).toEqual({
      type: 'root',
      value: 7,
      alt: null,
      title: undefined,
      url: ['x'],
      children: [undefined, null, 5, 'text', true, { value: `${ph(5)}[`, children: 'not-an-array' }, { children: [{ value: '[' }, null, undefined] }, []],
    });
  });

  it('a primitive root and a null root are ignored', () => {
    const map = new Map([[ph(0), '[']]);
    expect(() => restorePlaceholders(null, map)).not.toThrow();
    expect(() => restorePlaceholders(undefined, map)).not.toThrow();
    expect(() => restorePlaceholders('s', map)).not.toThrow();
  });

  it('keys that are special in a regular expression character class are matched literally', () => {
    const map = new Map([
      ['a', '1'],
      ['-', '2'],
      ['z', '3'],
      [']', '4'],
      ['^', '5'],
      ['\\', '6'],
    ]);
    const node = { value: 'a-z]^\\ b y' };
    restorePlaceholders(node, map);
    expect(node.value).toBe('123456 b y');
  });

  it.each<[string, Array<[string, string]>, string, string]>([
    ['a dash between two keys is not a range', [['a', '1'], ['-', '2'], ['z', '3']], 'a-bcz', '12bc3'],
    ['a dash alone', [['-', 'D']], 'a-b', 'aDb'],
    ['a closing bracket', [[']', 'B'], ['a', '1']], '[a]', '[1B'],
    ['a caret first', [['^', 'C'], ['a', '1']], 'a^b', '1Cb'],
    ['a caret alone', [['^', 'C']], 'a^b', 'aCb'],
    ['a backslash', [['\\', 'S']], 'a\\b', 'aSb'],
  ])('%s', (_name, pairs, value, expected) => {
    const node = { value };
    restorePlaceholders(node, new Map(pairs));
    expect(node.value).toBe(expected);
  });
});
