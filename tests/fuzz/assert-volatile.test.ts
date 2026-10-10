import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cpuMs, hostileString, params } from './helpers.ts';
import { findVolatile, hasVolatile, type VolatileKind, type VolatileMatch } from '../../packages/sdk/src/assert/volatile.ts';

/**
 * The tokenizer in assert/volatile.ts implements the regular expressions of SPEC 10.4 without backtracking. These properties compare
 * it with those regular expressions (bounded inputs, so catastrophic backtracking cannot occur) and check the structural contract.
 */

const SPEC: { kind: VolatileKind; re: RegExp; accept?: (m: string) => boolean }[] = [
  { kind: 'time', re: /\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/g },
  { kind: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { kind: 'date', re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: 'hex-id', re: /\b[0-9a-f]{8,}\b/gi, accept: (m) => /\d/.test(m) && /[a-f]/i.test(m) },
  { kind: 'long-number', re: /\b\d{5,}\b/g },
  { kind: 'relative-time', re: /\b\d+\s+(second|minute|hour|day)s?\s+ago\b/gi },
  { kind: 'relative-time', re: /\bjust\s+now\b/gi },
];

function bySpec(text: string): VolatileMatch[] {
  const out: VolatileMatch[] = [];
  for (const { kind, re, accept } of SPEC) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (accept === undefined || accept(m[0])) out.push({ kind, text: m[0], index: m.index });
    }
  }
  return out;
}

const key = (m: VolatileMatch): string => `${m.index}:${m.kind}:${m.text}`;
const keys = (ms: readonly VolatileMatch[]): string[] => ms.map(key).sort();

// Alphabet chosen so that the interesting boundaries (digits next to letters, colons, dashes, slashes, dots, spaces) are dense.
const ATOMS = ['0', '1', '2', '5', '9', '12', '30', '2026', '10', '09', '12345', '1234', 'a', 'f', 'F', 'g', 'x', '_', 'ab', 'deadbeef', '3fa85f64', ':', '-', '/', '.', ' ', '  ', '\t', '\n', '\u00a0', '\u2003', ',', 'ago', 'AGO', 'just', 'Now', 'now', 'minute', 'minutes', 'hour', 'second', 'days', 'day', '550e8400', 'e29b', '41d4', 'a716', '446655440000', 'é', '١٢٣', '😀'];
const denseText = fc.array(fc.constantFrom(...ATOMS), { maxLength: 24 }).map((p) => p.join(''));

const TEMPLATES: { kind: VolatileKind; text: fc.Arbitrary<string> }[] = [
  { kind: 'time', text: fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.option(fc.integer({ min: 0, max: 59 }), { nil: undefined }), fc.option(fc.nat(999), { nil: undefined })).map(([h, m, s, f]) => `${h}:${String(m).padStart(2, '0')}${s === undefined ? '' : `:${String(s).padStart(2, '0')}${f === undefined ? '' : `.${f}`}`}`) },
  { kind: 'date', text: fc.tuple(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 })).map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`) },
  { kind: 'date', text: fc.tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }), fc.integer({ min: 10, max: 2099 })).map(([m, d, y]) => `${m}/${d}/${y}`) },
  { kind: 'uuid', text: fc.uuid().map((u) => u) },
  { kind: 'long-number', text: fc.integer({ min: 10000, max: 999999999 }).map(String) },
  { kind: 'hex-id', text: fc.stringMatching(/^[0-9a-f]{7}[0-9a-f]{1,10}$/).filter((s) => /\d/.test(s) && /[a-f]/.test(s)) },
  { kind: 'relative-time', text: fc.tuple(fc.nat(500), fc.constantFrom('second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days'), fc.constantFrom(' ', '  ', '\t', '\u00a0')).map(([n, u, sp]) => `${n}${sp}${u}${sp}ago`) },
  { kind: 'relative-time', text: fc.constantFrom('just now', 'Just Now', 'just  now', 'JUST\tNOW') },
];

describe('fuzz: findVolatile', () => {
  it('agrees with the regular expressions of the spec on dense boundary-heavy text (kind, text and position)', () => {
    fc.assert(
      fc.property(denseText, (text) => {
        expect(keys(findVolatile(text))).toEqual(keys(bySpec(text)));
      }),
      params({ scale: 3 }),
    );
  });

  it('agrees with the spec on hostile text too', () => {
    fc.assert(
      fc.property(hostileString({ maxLength: 200 }), (text) => {
        expect(keys(findVolatile(text))).toEqual(keys(bySpec(text)));
      }),
      params(),
    );
  });

  it('returns ordered, non-overlapping-per-kind matches that are exact slices of the input; hasVolatile agrees', () => {
    fc.assert(
      fc.property(fc.oneof(denseText, hostileString({ maxLength: 300 })), (text) => {
        const ms = findVolatile(text);
        expect(hasVolatile(text)).toBe(ms.length > 0);
        let last = -1;
        const end: Partial<Record<VolatileKind, number>> = {};
        for (const m of ms) {
          expect(text.slice(m.index, m.index + m.text.length)).toBe(m.text);
          expect(m.text.length).toBeGreaterThan(0);
          expect(m.index).toBeGreaterThanOrEqual(last);
          last = m.index;
          expect(m.index).toBeGreaterThanOrEqual(end[m.kind] ?? 0);
          end[m.kind] = m.index + m.text.length;
        }
        expect(findVolatile(text)).toEqual(ms);
      }),
      params(),
    );
  });

  it('finds every volatile token that is planted between separators, whatever surrounds it', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TEMPLATES), fc.nat(), fc.constantFrom(' ', ' | ', '\n', ', ', '(', ') ', '"', ' - ', '\u00a0'), denseText, denseText, (tpl, pick, sep, before, after) => {
        const token = fc.sample(tpl.text, { seed: pick, numRuns: 1 })[0] as string;
        // the surrounding material is itself separated, so that tokens do not merge into neighbours
        const text = `${before.replace(/[\w]$/, '')}${sep}${token}${sep}${after.replace(/^[\w]/, '')}`;
        const found = findVolatile(text);
        const planted = text.indexOf(token);
        expect(found.some((m) => m.kind === tpl.kind && m.index <= planted + token.length && m.index + m.text.length >= planted), `${tpl.kind} ${JSON.stringify(token)} in ${JSON.stringify(text)}`).toBe(true);
      }),
      params(),
    );
  });

  it('is stable under reordering: the matches of a text joined from segments are the union of the matches of the segments', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(denseText, fc.constantFrom(...TEMPLATES).chain((t) => t.text)), { minLength: 1, maxLength: 6 }), fc.integer(), (segments, seed) => {
        // " | " separates segments without being whitespace-only, so no pattern can span two segments
        const sep = ' | ';
        const tally = (parts: string[]): string[] => parts.flatMap((p) => findVolatile(p).map((m) => `${m.kind}:${m.text}`)).sort();
        const joined = (parts: string[]): string[] => findVolatile(parts.join(sep)).map((m) => `${m.kind}:${m.text}`).sort();
        const shuffled = [...segments].sort((a, b) => ((a.length * 31 + seed) % 11) - ((b.length * 17 + seed) % 11) || (a < b ? -1 : 1));
        expect(joined(segments)).toEqual(tally(segments));
        expect(joined(shuffled)).toEqual(joined(segments));
      }),
      params(),
    );
  });

  it('is linear: very long inputs of the worst shapes finish within a CPU budget', () => {
    const shapes = ['1:'.repeat(50_000), '1a'.repeat(50_000), '0'.repeat(100_000), 'a'.repeat(100_000), '1 '.repeat(50_000), '1-1-'.repeat(25_000), `${'9 '.repeat(20_000)}minutes ago`, '1/'.repeat(50_000), ' '.repeat(100_000), '2026-10-09 '.repeat(10_000)];
    for (const text of shapes) {
      const used = cpuMs(() => {
        findVolatile(text);
      });
      expect(used, `${JSON.stringify(text.slice(0, 12))}...`).toBeLessThan(3000);
    }
  });
});
