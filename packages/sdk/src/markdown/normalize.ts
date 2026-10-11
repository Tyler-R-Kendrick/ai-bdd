import { sha256Hex } from '../util/index.ts';

/**
 * Input normalization shared by discovery and the chunker (spec 6.1): strip one
 * leading UTF-8 BOM and convert `\r\n` / `\r` line endings to `\n`.
 * Lines and columns are identical before and after this step (V9).
 */
export function normalizeDocText(raw: string): string {
  let s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Stryker disable next-line ConditionalExpression,StringLiteral: the CR check is a fast path; replacing CRLF/CR in a text without CR changes nothing
  if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
  return s;
}

/** Document digest that does not change with BOM or line-ending style. */
export function docSha256(raw: string): string {
  return sha256Hex(normalizeDocText(raw));
}

/** Deepest container nesting (block quotes and list markers on one line) that is parsed. */
export const MAX_CONTAINER_DEPTH = 100;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Number of container openers (`>`, `-`, `*`, `+`, `1.`, `1)`) that start a line. Linear in the line length. */
function containerDepth(text: string, from: number, to: number): number {
  let depth = 0;
  let i = from;
  // Stryker disable next-line EqualityOperator: at i === to the character is the line break or the end of text, which matches no branch below and breaks the loop
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9) {
      i++;
    } else if (c === 62) {
      depth++;
      i++;
    } else if ((c === 45 || c === 42 || c === 43) && (i + 1 >= to || text.charCodeAt(i + 1) === 32 || text.charCodeAt(i + 1) === 9)) {
      depth++;
      i++;
    } else if (isDigit(c)) {
      let j = i;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: the character at `to` is a line break or the end of text, never a digit, so the digit test already stops the loop at the end of the line
      while (j < to && j - i < 10 && isDigit(text.charCodeAt(j))) j++;
      const d = text.charCodeAt(j);
      // Stryker disable next-line ConditionalExpression,EqualityOperator: the character at `to` is never `.` or `)`, so the marker test already fails at the end of the line
      if (j < to && (d === 46 || d === 41) && (j + 1 >= to || text.charCodeAt(j + 1) === 32 || text.charCodeAt(j + 1) === 9)) {
        depth++;
        i = j + 1;
      } else {
        break;
      }
    } else {
      break;
    }
    // Stryker disable next-line ConditionalExpression: early exit only: the depth stays above the limit, and callers compare it with the limit
    if (depth > MAX_CONTAINER_DEPTH) return depth;
  }
  return depth;
}

/**
 * The micromark parser is quadratic in container nesting depth (`- - - - ...`). Lines nested deeper than
 * {@link MAX_CONTAINER_DEPTH} are blanked, which keeps every other line number intact.
 * Input must already be LF-normalized. Returns the 1-based numbers of the blanked lines.
 */
export function limitNesting(text: string): { text: string; blanked: number[] } {
  const blanked: number[] = [];
  let out: string[] | undefined;
  let lineNo = 1;
  let start = 0;
  // Stryker disable next-line EqualityOperator: the extra iteration at start === length is an empty line, which is never nested
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (containerDepth(text, start, end) > MAX_CONTAINER_DEPTH) {
      blanked.push(lineNo);
      if (out === undefined) out = text.split('\n');
      out[lineNo - 1] = '';
    }
    lineNo++;
    start = end + 1;
  }
  return { text: out === undefined ? text : out.join('\n'), blanked };
}

// ───────────────────────── input budgets (R-EX1)

/** Largest document (UTF-16 units) the chunker accepts; larger ones are reported as unreadable. */
export const MAX_DOC_CHARS = 256 * 1024;
/** Active inline delimiters (`[`, `]`, `*`, `_`, `~`) per blank-line separated run. micromark's inline resolver is quadratic in them. */
export const MAX_RUN_DELIMITERS = 1000;
/** Longest stretch (characters) a `[` may stay unclosed before it is literal text. */
export const MAX_OPEN_LABEL_CHARS = 1500;
/** Active inline delimiters per document. */
export const MAX_DOC_DELIMITERS = 40_000;
/** Leading indentation (columns) kept active. micromark is quadratic in container depth, and each 2 columns can open a list level. */
export const MAX_INDENT_COLUMNS = 120;

export interface Neutralized {
  text: string;
  /** Placeholder character to the original character it replaced. Empty when nothing was neutralized. */
  restore: Map<string, string>;
  /** 1-based numbers of lines whose indentation was neutralized. */
  indented: number[];
  /** Number of delimiters turned into literal text. */
  delimiters: number;
  /** Set when the document has no free placeholder character left. */
  exhausted: boolean;
}

/** A line that opens a list item that can interrupt a paragraph (`-`, `+`, `*` or `1.` / `1)` followed by a space and content). */
function startsListItem(text: string, from: number, to: number): boolean {
  let i = from;
  let spaces = 0;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: the character at `to` is not a space, and a run of 4 or more spaces gives false whether the count stops at 4 or goes on
  while (i < to && text.charCodeAt(i) === 32 && spaces < 4) {
    i++;
    spaces++;
  }
  // Stryker disable next-line ConditionalExpression,EqualityOperator: a non-blank line has a non-space character at or before `to`; at i === to the checks below read a line break or the end and return false
  if (spaces > 3 || i >= to) return false;
  const c = text.charCodeAt(i);
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: `i + 1 < to` is implied by the next test: past the line end the character is a line break or the end of text, never a space
  if (c === 45 || c === 43 || c === 42) return i + 1 < to && text.charCodeAt(i + 1) === 32 && i + 2 < to;
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: `i + 2 < to` is implied by the last test: past the line end the character is a line break or the end of text, never a space
  if (c === 49) return i + 2 < to && (text.charCodeAt(i + 1) === 46 || text.charCodeAt(i + 1) === 41) && text.charCodeAt(i + 2) === 32;
  return false;
}

/** Characters of `text` outside the Private Use Area block used as placeholders, scanned lazily. */
function placeholderPool(text: string): () => string | undefined {
  let next = 0xe000;
  return () => {
    while (next <= 0xf8ff) {
      const ch = String.fromCharCode(next++);
      if (!text.includes(ch)) return ch;
    }
    return undefined;
  };
}

/**
 * Bounds the work micromark does on hostile input without changing offsets: excess inline delimiters, label openers
 * that stay unclosed for a long stretch and excess leading indentation are replaced one-for-one by inert placeholder
 * characters, which {@link restorePlaceholders} maps back in the parsed tree. Documents within the budgets are
 * returned untouched. Input must be LF-normalized.
 */
export function neutralizeHostile(text: string): Neutralized {
  const restore = new Map<string, string>();
  const placeholderFor = new Map<string, string>();
  const indented: number[] = [];
  const swaps: number[] = [];
  let delimiters = 0;
  let exhausted = false;
  // Stryker disable next-line BooleanLiteral: starting unsorted only sorts an already sorted list
  let sorted = true;
  const nextFree = placeholderPool(text);
  const swap = (orig: string): string => {
    let ph = placeholderFor.get(orig);
    if (ph === undefined) {
      ph = nextFree();
      if (ph === undefined) {
        exhausted = true;
        return orig;
      }
      placeholderFor.set(orig, ph);
      restore.set(ph, orig);
    }
    return ph;
  };
  const mark = (offset: number, isDelimiter: boolean): void => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: every mutant that reports `unsorted` more often only sorts an already sorted list (equal offsets cannot occur); the ones that report it less often are killed
    if (swaps.length > 0 && (swaps[swaps.length - 1] as number) > offset) sorted = false;
    swaps.push(offset);
    if (isDelimiter) delimiters++;
  };

  const expire = (pos: number): void => {
    // an opener that has stayed unclosed for too long is literal text (gfm autolink detection is quadratic behind it)
    // Stryker disable next-line ConditionalExpression,EqualityOperator: past the last opener the element is undefined and `pos - undefined` is NaN, which is never greater than the limit
    while (head < openers.length && pos - (openers[head] as number) > MAX_OPEN_LABEL_CHARS) {
      mark(openers[head] as number, true);
      head++;
    }
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,ArithmeticOperator,BlockStatement: dead compaction: an opener counts against the run budget (1000) and the list is reset with each run, so head never reaches 4096; compacting would not change the result either
    if (head > 4096 && head * 2 > openers.length) {
      // Stryker disable next-line MethodExpression: dead code, see the line above: head never reaches 4096
      openers = openers.slice(head);
      head = 0;
    }
  };

  // `[` openers still waiting for a `]` in the current run, oldest first (`head` is the first live entry)
  let openers: number[] = [];
  let head = 0;
  let run = 0;
  let docActive = 0;
  let lineNo = 1;
  let start = 0;
  // Stryker disable next-line EqualityOperator: the extra iteration at start === length is an empty line: blank, with nothing after it that reads the state
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;

    // leading indentation
    let i = start;
    let cols = 0;
    // Stryker disable next-line EqualityOperator: at i === end the character is a line break or the end of text, which is neither a space nor a tab
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 32) cols++;
      else if (c === 9) cols += 4;
      else break;
      i++;
    }
    const blank = i >= end;
    if (!blank && cols > MAX_INDENT_COLUMNS) {
      let k = start;
      let col = 0;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: `k < i` is implied by the column test: the indentation is wider than the limit, so the limit is reached before k gets to i
      while (k < i && col < MAX_INDENT_COLUMNS) {
        col += text.charCodeAt(k) === 9 ? 4 : 1;
        k++;
      }
      for (let j = k; j < i; j++) mark(j, false);
      indented.push(lineNo);
    }

    if (blank || startsListItem(text, start, end)) {
      run = 0;
      openers = [];
      head = 0;
    }

    // Stryker disable next-line ConditionalExpression: a blank line has nothing to scan, and its opener list was just emptied, so expire has nothing to do
    if (!blank) {
      // Stryker disable next-line EqualityOperator: at j === end the character is a line break or the end of text, which is no delimiter
      for (let j = i; j < end; j++) {
        const c = text.charCodeAt(j);
        if (c !== 91 && c !== 93 && c !== 42 && c !== 126 && c !== 95) continue;
        if (run >= MAX_RUN_DELIMITERS || docActive >= MAX_DOC_DELIMITERS) {
          mark(j, true);
          continue;
        }
        run++;
        docActive++;
        expire(j);
        if (c === 91) {
          openers.push(j);
        } else if (c === 93 && head < openers.length) {
          openers.pop();
        }
      }
      expire(end);
    }
    lineNo++;
    start = end + 1;
  }

  // Stryker disable next-line ConditionalExpression: without swaps the rebuilt text is the same string
  if (swaps.length === 0) return { text, restore, indented, delimiters, exhausted };
  // Stryker disable next-line ConditionalExpression: sorting an already sorted list changes nothing
  if (!sorted) swaps.sort((x, y) => x - y);
  const parts: string[] = [];
  let at = 0;
  for (const off of swaps) {
    // Stryker disable next-line ConditionalExpression: offsets are strictly increasing after sorting (no offset is marked twice), so this never skips
    if (off < at) continue;
    parts.push(text.slice(at, off), swap(text.charAt(off)));
    at = off + 1;
  }
  parts.push(text.slice(at));
  return { text: parts.join(''), restore, indented, delimiters, exhausted };
}

/** Maps placeholder characters back to the original text in every string field of the parsed tree. Iterative. */
export function restorePlaceholders(root: unknown, restore: ReadonlyMap<string, string>): void {
  if (restore.size === 0) return;
  // Stryker disable next-line StringLiteral: the join separator only adds characters that have no mapping, and an unmapped character is returned as it was
  const chars = [...restore.keys()].map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('');
  const re = new RegExp(`[${chars}]`, 'g');
  const fix = (v: string): string => v.replace(re, (c) => restore.get(c) ?? c);
  const fields = ['value', 'alt', 'title', 'url', 'label', 'lang', 'meta'] as const;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | null;
    if (node === null || typeof node !== 'object') continue;
    for (const f of fields) {
      const v = node[f];
      if (typeof v === 'string') node[f] = fix(v);
    }
    const kids = node['children'];
    if (Array.isArray(kids)) for (const k of kids) stack.push(k);
  }
}
