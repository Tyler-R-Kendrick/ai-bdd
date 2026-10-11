/**
 * Volatile-content detection (SPEC §10.4, R-AS2).
 *
 * The spec defines the patterns as regular expressions. They are implemented here as a single-pass tokenizer
 * (word runs vs. separator runs) with fixed-shape token-sequence matchers, so detection is strictly linear in the
 * input length and cannot backtrack. A regex `\b` is a boundary between an ASCII word char `[A-Za-z0-9_]` and
 * anything else, which is exactly the word/separator token boundary used here.
 *
 *   time           \b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b
 *   date           \b\d{4}-\d{2}-\d{2}\b  and  \b\d{1,2}/\d{1,2}/\d{2,4}\b
 *   uuid           \b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b
 *   hex-id         \b[0-9a-f]{8,}\b   (only when the match has both a digit and a letter)
 *   long-number    \b\d{5,}\b
 *   relative-time  \b\d+\s+(second|minute|hour|day)s?\s+ago\b  and  \bjust\s+now\b
 *
 * Matching is case-insensitive. No code in this module compiles a regular expression.
 */

export type VolatileKind = 'time' | 'date' | 'uuid' | 'hex-id' | 'long-number' | 'relative-time';

export interface VolatileMatch { kind: VolatileKind; text: string; index: number }

/** Human-readable description of the pattern table (documentation and prompt use). */
export const VOLATILE_PATTERN_DESCRIPTIONS: Readonly<Record<VolatileKind, string>> = {
  time: 'clock times such as 9:41, 12:30:05 or 12:30:05.123',
  date: 'dates such as 2026-10-09 or 10/9/26',
  uuid: 'UUIDs such as 550e8400-e29b-41d4-a716-446655440000',
  'hex-id': 'hexadecimal ids of 8+ characters containing both a digit and a letter, such as 3fa85f64',
  'long-number': 'numbers of 5 or more digits',
  'relative-time': 'relative times such as "5 minutes ago" or "just now"',
};

const WORD_DIGIT = 1;
const WORD_HEX = 2;
const WORD_ALPHA = 4;

function isWordCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isSpaceCode(c: number): boolean {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

interface Tokens {
  text: string;
  count: number;
  start: Int32Array;
  end: Int32Array;
  /** 1 for word tokens, 0 for separator tokens. */
  word: Uint8Array;
  /** Per word token: bit flags describing every character of the word. */
  flags: Uint8Array;
}

function tokenize(text: string): Tokens {
  const n = text.length;
  // Worst case is alternating word/separator characters: n tokens.
  const start = new Int32Array(n);
  const end = new Int32Array(n);
  const word = new Uint8Array(n);
  const flags = new Uint8Array(n);
  let count = 0;
  let i = 0;
  while (i < n) {
    const startIdx = i;
    const isWord = isWordCode(text.charCodeAt(i));
    let allDigit = true;
    let allHex = true;
    let hasAlphaChar = false;
    while (i < n && isWordCode(text.charCodeAt(i)) === isWord) {
      if (isWord) {
        const c = text.charCodeAt(i);
        const digit = c >= 48 && c <= 57;
        const hexLetter = (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        if (!digit) allDigit = false;
        if (!digit && !hexLetter) allHex = false;
        if (hexLetter) hasAlphaChar = true;
      }
      i += 1;
    }
    start[count] = startIdx;
    end[count] = i;
    word[count] = isWord ? 1 : 0;
    if (isWord) {
      let f = 0;
      if (allDigit) f |= WORD_DIGIT;
      if (allHex) f |= WORD_HEX;
      if (hasAlphaChar) f |= WORD_ALPHA;
      flags[count] = f;
    }
    count += 1;
  }
  return { text, count, start, end, word, flags };
}

function len(t: Tokens, i: number): number {
  return (t.end[i] ?? 0) - (t.start[i] ?? 0);
}

function isWordTok(t: Tokens, i: number): boolean {
  return i < t.count && t.word[i] === 1;
}

function digitsWord(t: Tokens, i: number, min: number, max: number): boolean {
  if (!isWordTok(t, i) || ((t.flags[i] ?? 0) & WORD_DIGIT) === 0) return false;
  const l = len(t, i);
  return l >= min && l <= max;
}

function hexWord(t: Tokens, i: number, exact: number): boolean {
  return isWordTok(t, i) && ((t.flags[i] ?? 0) & WORD_HEX) !== 0 && len(t, i) === exact;
}

/** Separator token that is exactly the one character `ch`. */
function sepIs(t: Tokens, i: number, ch: string): boolean {
  return i < t.count && t.word[i] === 0 && len(t, i) === 1 && t.text[t.start[i] ?? 0] === ch;
}

function sepIsSpace(t: Tokens, i: number): boolean {
  if (i >= t.count || t.word[i] !== 0) return false;
  for (let k = t.start[i] ?? 0; k < (t.end[i] ?? 0); k += 1) {
    if (!isSpaceCode(t.text.charCodeAt(k))) return false;
  }
  return true;
}

function wordLower(t: Tokens, i: number): string {
  return isWordTok(t, i) ? t.text.slice(t.start[i] ?? 0, t.end[i] ?? 0).toLowerCase() : '';
}

const RELATIVE_UNITS: ReadonlySet<string> = new Set([
  'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days',
]);

/** All volatile matches in `text`, ordered by index. Linear time in `text.length`. */
export function findVolatile(text: string): VolatileMatch[] {
  if (text.length === 0) return [];
  const t = tokenize(text);
  const out: VolatileMatch[] = [];
  // Like a global regex scan, matches of one kind never overlap: a match starting inside the previous one is skipped.
  const lastEnd: Partial<Record<VolatileKind, number>> = {};
  const push = (kind: VolatileKind, first: number, last: number): void => {
    const s = t.start[first] ?? 0;
    if (s < (lastEnd[kind] ?? 0)) return;
    const e = t.end[last] ?? s;
    lastEnd[kind] = e;
    out.push({ kind, text: text.slice(s, e), index: s });
  };
  for (let i = 0; i < t.count; i += 1) {
    if (t.word[i] !== 1) continue;
    const f = t.flags[i] ?? 0;
    const l = len(t, i);
    // long-number: a whole word of 5+ digits
    if ((f & WORD_DIGIT) !== 0 && l >= 5) push('long-number', i, i);
    // hex-id: a whole word of 8+ hex chars with at least one digit and one letter
    if ((f & WORD_HEX) !== 0 && l >= 8 && (f & WORD_ALPHA) !== 0 && hasDigit(t, i)) push('hex-id', i, i);
    // uuid: 8-4-4-4-12 hex words joined by single hyphens
    if (
      hexWord(t, i, 8) && sepIs(t, i + 1, '-') && hexWord(t, i + 2, 4) && sepIs(t, i + 3, '-') && hexWord(t, i + 4, 4) &&
      sepIs(t, i + 5, '-') && hexWord(t, i + 6, 4) && sepIs(t, i + 7, '-') && hexWord(t, i + 8, 12)
    ) {
      push('uuid', i, i + 8);
    }
    // date: yyyy-mm-dd
    if (digitsWord(t, i, 4, 4) && sepIs(t, i + 1, '-') && digitsWord(t, i + 2, 2, 2) && sepIs(t, i + 3, '-') && digitsWord(t, i + 4, 2, 2)) {
      push('date', i, i + 4);
    }
    // date: d/m/yy, dd/mm/yyyy
    if (digitsWord(t, i, 1, 2) && sepIs(t, i + 1, '/') && digitsWord(t, i + 2, 1, 2) && sepIs(t, i + 3, '/') && digitsWord(t, i + 4, 2, 4)) {
      push('date', i, i + 4);
    }
    // time: h:mm with optional :ss and .fraction (those only extend a match that already exists)
    if (digitsWord(t, i, 1, 2) && sepIs(t, i + 1, ':') && digitsWord(t, i + 2, 2, 2)) {
      let last = i + 2;
      if (sepIs(t, last + 1, ':') && digitsWord(t, last + 2, 2, 2)) last += 2;
      if (sepIs(t, last + 1, '.') && digitsWord(t, last + 2, 1, Number.MAX_SAFE_INTEGER)) last += 2;
      push('time', i, last);
    }
    // relative time: "<n> <unit>(s) ago"
    if (
      digitsWord(t, i, 1, Number.MAX_SAFE_INTEGER) && sepIsSpace(t, i + 1) && RELATIVE_UNITS.has(wordLower(t, i + 2)) &&
      sepIsSpace(t, i + 3) && wordLower(t, i + 4) === 'ago'
    ) {
      push('relative-time', i, i + 4);
    }
    // "just now"
    if (wordLower(t, i) === 'just' && sepIsSpace(t, i + 1) && wordLower(t, i + 2) === 'now') {
      push('relative-time', i, i + 2);
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function hasDigit(t: Tokens, i: number): boolean {
  for (let k = t.start[i] ?? 0; k < (t.end[i] ?? 0); k += 1) {
    const c = t.text.charCodeAt(k);
    if (c >= 48 && c <= 57) return true;
  }
  return false;
}

export function hasVolatile(text: string): boolean {
  return findVolatile(text).length > 0;
}
