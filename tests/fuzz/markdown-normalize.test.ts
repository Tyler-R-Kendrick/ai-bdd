import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createChunker, sha256Hex } from '@ai-bdd/sdk';
import { cpuMs, hostileString, markdownDoc, params, withLineEnding, anyDocText, type LineEnding } from './helpers.ts';
import { MAX_DOC_DELIMITERS, MAX_INDENT_COLUMNS, MAX_RUN_DELIMITERS, docSha256, limitNesting, neutralizeHostile, normalizeDocText } from '../../packages/sdk/src/markdown/normalize.ts';

const eol = fc.constantFrom<LineEnding>('\n', '\r\n', '\r');
const BOM = '\ufeff';
const PUA = /[-]/g;
const puaOf = (s: string): Set<string> => new Set(s.match(PUA) ?? []);

/** Bombs for the budgets in normalize.ts: delimiter floods, unclosed labels, wide indentation, deep container nesting. */
const bombs = fc.oneof(
  fc.tuple(fc.constantFrom('[', ']', '*', '_', '~', '*a', '[a]('), fc.integer({ min: 900, max: 6000 })).map(([t, n]) => `${t.repeat(n)}\n`),
  fc.tuple(fc.integer({ min: 100, max: 400 }), fc.constantFrom(' ', '\t', ' \t')).map(([n, c]) => `${c.repeat(n)}- deep ${'*'.repeat(10)}\n\n${c.repeat(n)}text\n`),
  fc.tuple(fc.constantFrom('- ', '> ', '1. ', '* '), fc.integer({ min: 90, max: 130 })).map(([t, n]) => `${t.repeat(n)}x\n`),
  fc.array(fc.constantFrom('[x', '*y', '_z', '~~', ']', '\n', '\n\n', '- ', '    '), { minLength: 50, maxLength: 400 }).map((p) => p.join('')),
);

describe('fuzz: markdown input normalization', () => {
  it('normalizeDocText: LF only, one BOM removed, idempotent up to a second BOM, and the digest ignores line endings and the BOM', () => {
    fc.assert(
      fc.property(fc.oneof(anyDocText(), hostileString()), eol, fc.boolean(), (text, e, bom) => {
        const n = normalizeDocText(text);
        expect(n).not.toContain('\r');
        expect(n.length).toBeLessThanOrEqual(text.length);
        expect(normalizeDocText(n)).toBe(n.charCodeAt(0) === 0xfeff ? n.slice(1) : n);
        // the same document in another spelling has the same digest
        const lf = text.startsWith(BOM) ? text.slice(1) : text;
        const variant = (bom ? BOM : '') + withLineEnding(lf.replace(/\r\n?/g, '\n'), e);
        expect(docSha256(variant)).toBe(docSha256(lf.replace(/\r\n?/g, '\n')));
        expect(docSha256(lf)).toBe(sha256Hex(normalizeDocText(lf)));
        // the number of lines is unchanged (lines and columns of the parser output refer to the original text)
        expect(n.split('\n').length).toBe((text.startsWith(BOM) ? text.slice(1) : text).split(/\r\n|\r|\n/).length);
      }),
      params(),
    );
    expect(normalizeDocText(`${BOM}${BOM}a`)).toBe(`${BOM}a`);
  });

  it('limitNesting only blanks whole lines, keeps the line count, reports them in order, and is idempotent', () => {
    fc.assert(
      fc.property(fc.oneof(anyDocText().map(normalizeDocText), bombs), (text) => {
        const r = limitNesting(text);
        const before = text.split('\n');
        const after = r.text.split('\n');
        expect(after).toHaveLength(before.length);
        expect(r.blanked).toEqual([...r.blanked].sort((a, b) => a - b));
        expect(new Set(r.blanked).size).toBe(r.blanked.length);
        after.forEach((line, i) => {
          if (r.blanked.includes(i + 1)) expect(line).toBe('');
          else expect(line).toBe(before[i]);
        });
        const again = limitNesting(r.text);
        expect(again.text).toBe(r.text);
        expect(again.blanked.every((n) => r.text.split('\n')[n - 1] === '')).toBe(true);
      }),
      params(),
    );
  });

  it('neutralizeHostile swaps characters one for one: same length and lines, reversible through the restore map, stable on its own output', () => {
    fc.assert(
      fc.property(fc.oneof(bombs, anyDocText().map(normalizeDocText)), (text) => {
        const n = neutralizeHostile(text);
        expect(n.text).toHaveLength(text.length);
        expect(n.text.split('\n')).toHaveLength(text.split('\n').length);
        expect([...n.text].map((c) => n.restore.get(c) ?? c).join('')).toBe(text);
        // placeholders are private-use characters that the input did not use itself
        const used = puaOf(text);
        for (const ph of n.restore.keys()) {
          expect(used.has(ph)).toBe(false);
          expect(ph).toMatch(/^[-]$/);
        }
        if (!n.exhausted) {
          expect(neutralizeHostile(n.text).text).toBe(n.text);
          if (n.restore.size === 0) expect(n.text).toBe(text);
        }
        expect(n.indented).toEqual([...n.indented].sort((a, b) => a - b));
      }),
      params(),
    );
  });

  it('input within the budgets is returned untouched, input beyond them is bounded', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_RUN_DELIMITERS - 1 }), fc.integer({ min: 0, max: MAX_INDENT_COLUMNS }), (delims, indent) => {
        const text = `${' '.repeat(indent)}${'*a'.repeat(Math.floor(delims / 2))}\n`;
        const n = neutralizeHostile(text);
        expect(n.restore.size).toBe(0);
        expect(n.text).toBe(text);
      }),
      params(),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4000 }), (extra) => {
        const text = `${'*'.repeat(MAX_RUN_DELIMITERS + extra + 1)}\n`;
        const n = neutralizeHostile(text);
        expect(n.delimiters).toBe(extra + 1);
        expect([...n.text].filter((c) => c === '*').length).toBe(MAX_RUN_DELIMITERS);
        expect(MAX_DOC_DELIMITERS).toBeGreaterThan(MAX_RUN_DELIMITERS);
      }),
      params({ scale: 0.3 }),
    );
  });

  it('a private-use placeholder never leaks into chunk text, headings, anchors or titles, whatever floods the document', () => {
    const chunker = createChunker();
    fc.assert(
      fc.property(fc.oneof(bombs.map((b) => `# Title ${b}`), bombs.map((b) => `# T\n\n${b}\n\n| a | b |\n|---|---|\n| ${b.slice(0, 40)} | x |\n\n> ${b}\n`), markdownDoc()), (text) => {
        const d = chunker.chunk({ uri: 'docs/leak.md', absolutePath: '/p/docs/leak.md', text, sha256: sha256Hex(text) }, { sectionDepth: 2, maxSectionChars: 12000 });
        const allowed = puaOf(text);
        const check = (s: string, what: string): void => {
          for (const ch of puaOf(s)) expect(allowed.has(ch), `${what} contains placeholder U+${ch.charCodeAt(0).toString(16)}`).toBe(true);
        };
        for (const c of d.chunks) {
          check(c.text, `chunk ${c.id}`);
          check(c.anchor, 'anchor');
          c.headingPath.forEach((h) => check(h, 'heading path'));
        }
        check(d.doc.title ?? '', 'title');
        for (const s of d.sections) check(s.title, 'section title');
      }),
      params({ scale: 0.3 }),
    );
  });

  it('normalization stays linear on huge single-line and many-line inputs (CPU budget)', () => {
    const shapes = ['a'.repeat(250_000), '\n'.repeat(250_000), '\r\n'.repeat(120_000), '- '.repeat(120_000), '[x'.repeat(120_000), `${' '.repeat(250_000)}x`, '*'.repeat(250_000), 'a\n'.repeat(120_000)];
    for (const text of shapes) {
      const used = cpuMs(() => {
        const n = normalizeDocText(text);
        limitNesting(n);
        neutralizeHostile(n);
      });
      expect(used, text.slice(0, 8)).toBeLessThan(4000);
    }
  });
});
