import { sha256Hex } from '../util/index.ts';

/**
 * Input normalization shared by discovery and the chunker (spec 6.1): strip one
 * leading UTF-8 BOM and convert `\r\n` / `\r` line endings to `\n`.
 * Lines and columns are identical before and after this step (V9).
 */
export function normalizeDocText(raw: string): string {
  let s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
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
      while (j < to && j - i < 10 && isDigit(text.charCodeAt(j))) j++;
      const d = text.charCodeAt(j);
      if (j < to && (d === 46 || d === 41) && (j + 1 >= to || text.charCodeAt(j + 1) === 32 || text.charCodeAt(j + 1) === 9)) {
        depth++;
        i = j + 1;
      } else {
        break;
      }
    } else {
      break;
    }
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
export const MAX_DOC_CHARS = 512 * 1024;
/** Active inline delimiters (`[`, `*`, `~`) per blank-line separated run. micromark's inline resolver is quadratic in them. */
export const MAX_RUN_DELIMITERS = 1000;
/** Active inline delimiters per document. */
export const MAX_DOC_DELIMITERS = 50_000;
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

/** Characters that start a new block when they begin a line: a list marker that interrupts a paragraph (`-`, `+`, `*`, `1.`, `1)`). */
function startsListItem(text: string, from: number, to: number): boolean {
  let i = from;
  let spaces = 0;
  while (i < to && text.charCodeAt(i) === 32 && spaces < 4) {
    i++;
    spaces++;
  }
  if (spaces > 3 || i >= to) return false;
  const c = text.charCodeAt(i);
  if (c === 45 || c === 43 || c === 42) return i + 1 < to && text.charCodeAt(i + 1) === 32 && i + 2 < to;
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
 * Bounds the work micromark does on hostile input without changing offsets: excess inline delimiters and excess leading
 * indentation are replaced one-for-one by inert placeholder characters, which {@link restorePlaceholders} maps back
 * in the parsed tree. Documents within the budgets are returned untouched. Input must be LF-normalized.
 */
export function neutralizeHostile(text: string): Neutralized {
  const restore = new Map<string, string>();
  const placeholderFor = new Map<string, string>();
  const indented: number[] = [];
  let delimiters = 0;
  let exhausted = false;
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

  let out: string[] | undefined;
  let run = 0;
  let docActive = 0;
  let lineNo = 1;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let line: string | undefined;

    // leading indentation
    let i = start;
    let cols = 0;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 32) cols++;
      else if (c === 9) cols += 4;
      else break;
      i++;
    }
    const blank = i >= end;
    if (!blank && cols > MAX_INDENT_COLUMNS) {
      // keep the first MAX_INDENT_COLUMNS columns, neutralize the rest of the whitespace run
      let k = start;
      let col = 0;
      while (k < i && col < MAX_INDENT_COLUMNS) {
        col += text.charCodeAt(k) === 9 ? 4 : 1;
        k++;
      }
      let rest = '';
      for (let j = k; j < i; j++) rest += swap(text.charAt(j));
      line = text.slice(start, k) + rest + text.slice(i, end);
      indented.push(lineNo);
    }

    if (blank || startsListItem(text, start, end)) run = 0;

    // inline delimiters
    if (!blank) {
      for (let j = i; j < end; j++) {
        const c = text.charCodeAt(j);
        if (c !== 91 && c !== 42 && c !== 126) continue;
        if (run < MAX_RUN_DELIMITERS && docActive < MAX_DOC_DELIMITERS) {
          run++;
          docActive++;
          continue;
        }
        if (line === undefined) line = text.slice(start, end);
        const at = j - start;
        line = line.slice(0, at) + swap(text.charAt(j)) + line.slice(at + 1);
        delimiters++;
      }
    }

    if (line !== undefined) {
      if (out === undefined) out = text.split('\n');
      out[lineNo - 1] = line;
    }
    lineNo++;
    start = end + 1;
  }
  return { text: out === undefined ? text : out.join('\n'), restore, indented, delimiters, exhausted };
}
