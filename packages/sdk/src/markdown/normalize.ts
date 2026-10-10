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
