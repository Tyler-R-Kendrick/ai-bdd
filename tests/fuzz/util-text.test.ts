import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeForQuote, normalizeText, sha256Hex, slugify } from '@ai-bdd/sdk';
import { hostileString, params } from './helpers.ts';

const text = fc.oneof(hostileString(), fc.string({ unit: 'binary', maxLength: 80 }), fc.string({ unit: 'grapheme', maxLength: 80 }));

describe('fuzz: normalizeText / normalizeForQuote', () => {
  it('normalizeText is idempotent, NFC, and has no runs, edges or non-space whitespace', () => {
    fc.assert(
      fc.property(text, (s) => {
        const n = normalizeText(s);
        expect(normalizeText(n)).toBe(n);
        expect(n.normalize('NFC')).toBe(n);
        expect(n).not.toMatch(/\s\s/);
        expect(n).not.toMatch(/^\s|\s$/);
        expect(n).not.toMatch(/[^\S ]/);
      }),
      params(),
    );
  });

  it('normalizeForQuote is idempotent and equates texts that differ only in whitespace, case and typographic quotes', () => {
    fc.assert(
      fc.property(text, (s) => {
        const n = normalizeForQuote(s);
        expect(normalizeForQuote(n)).toBe(n);
        expect(n).not.toMatch(/\s\s/);
        expect(n).not.toMatch(/^\s|\s$/);
        expect(n).not.toMatch(/[‘’‚‛“”„‟‐-―…]/);
      }),
      params(),
    );
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9]{1,6}$/), { minLength: 1, maxLength: 6 }),
        fc.constantFrom(' ', '  ', '\t', '\n', '\u00a0', '\u2003', ' \r\n '),
        fc.boolean(),
        (words, sep, upper) => {
          const a = words.join(' ');
          const b = (upper ? words.map((w) => w.toUpperCase()) : words).join(sep);
          expect(normalizeForQuote(`  ${b}\n`)).toBe(normalizeForQuote(a));
        },
      ),
      params(),
    );
    expect(normalizeForQuote('“It’s” — fine…')).toBe('"it\'s" - fine...');
  });

  it('quote grounding: whole-word substrings of a text are still found in the normalized text', () => {
    const words = fc
      .array(
        fc
          .oneof(
            fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
            hostileString({ maxLength: 12 }).map((w) => w.replace(/\s+/g, '')),
            fc.constantFrom('“quoted”', 'It’s', 'a—b', 'wait…', 'ΑΣ', 'ΣΑΣ', 'İstanbul', 'ǅ', 'e\u0301', 'ﬁ'),
          )
          .filter((w) => w.length > 0),
        { minLength: 1, maxLength: 10 },
      );
    fc.assert(
      fc.property(words, fc.nat(), fc.nat(), fc.constantFrom(' ', '\n', '\t  ', '\u00a0'), (ws, a, b, sep) => {
        const i = a % ws.length;
        const j = i + (b % (ws.length - i));
        const source = `  ${ws.join(sep)}  `;
        const quote = ws.slice(i, j + 1).join(' ');
        expect(normalizeForQuote(source).includes(normalizeForQuote(quote))).toBe(true);
      }),
      params(),
    );
  });
});

describe('fuzz: slugify', () => {
  it('produces a non-empty [a-z0-9-] slug without leading, trailing or doubled hyphens within the length limit', () => {
    fc.assert(
      fc.property(text, (s) => {
        const slug = slugify(s);
        expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(slug.length).toBeLessThanOrEqual(64);
        expect(slugify(s)).toBe(slug);
      }),
      params(),
    );
  });

  it('is idempotent, respects the max length and falls back to a stable hash slug when nothing survives', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 10, max: 80 }), (s, max) => {
        const slug = slugify(s, max);
        expect(slug.length).toBeLessThanOrEqual(max);
        expect(slugify(slug, max)).toBe(slug);
        if (!/[a-z0-9]/.test(s.normalize('NFKD').toLowerCase())) expect(slug).toBe(`h-${sha256Hex(s).slice(0, 8)}`);
      }),
      params(),
    );
  });

  it('is case-, accent- and punctuation-insensitive: spellings of one title give one slug', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(' ', '  ', '-', '_', ' - ', '.', '/'),
        (words, sep) => {
          expect(slugify(words.map((w) => w.toUpperCase()).join(sep))).toBe(slugify(words.join(' ')));
        },
      ),
      params(),
    );
    expect(slugify('Crème Brûlée!')).toBe('creme-brulee');
  });
});
