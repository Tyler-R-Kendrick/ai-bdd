import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createChunker, normalizeText, sha256Hex, stableJson } from '@ai-bdd/sdk';
import type { ChunkedDoc, JsonValue, SourceDoc } from '@ai-bdd/sdk/contracts';
import { assertPrototypeClean, cpuMs, anyDocText, hostileString, markdownDoc, params, withLineEnding, type LineEnding } from './helpers.ts';

const chunker = createChunker();
const OPTS = { sectionDepth: 2, maxSectionChars: 12000 };

function srcDoc(text: string, uri = 'docs/fuzz.md'): SourceDoc {
  // The digest is constant so that results of different spellings of one document stay comparable.
  return { uri, absolutePath: `/project/${uri}`, text, sha256: sha256Hex('fixed') };
}

const chunk = (text: string, opts = OPTS): ChunkedDoc => chunker.chunk(srcDoc(text), opts);
const json = (d: ChunkedDoc): string => stableJson(d as unknown as JsonValue);

const eolArb = fc.constantFrom<LineEnding>('\n', '\r\n', '\r');

describe('fuzz: markdown chunker', () => {
  it('never reports an internal failure: every document under the size cap yields a document without error diagnostics', () => {
    fc.assert(
      fc.property(anyDocText(), fc.integer({ min: 0, max: 7 }), fc.integer({ min: 1, max: 600 }), (text, sectionDepth, maxSectionChars) => {
        const d = chunk(text, { sectionDepth, maxSectionChars });
        // chunker.chunk() catches everything and reports "could not parse document"; that would be a defect for in-budget input.
        expect(d.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
        expect(d.doc.uri).toBe('docs/fuzz.md');
      }),
      params(),
    );
  });

  it('never throws on out-of-contract options and documents (NaN, negative, fractional sizes, non-string text)', () => {
    fc.assert(
      fc.property(
        hostileString(),
        fc.oneof(fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY), fc.constant(-3), fc.double({ noNaN: true }), fc.integer()),
        fc.oneof(fc.constant(Number.NaN), fc.constant(0), fc.constant(-1), fc.double({ noNaN: true }), fc.integer()),
        (text, sectionDepth, maxSectionChars) => {
          const d = chunk(text, { sectionDepth, maxSectionChars });
          expect(Array.isArray(d.chunks)).toBe(true);
          expect(Array.isArray(d.sections)).toBe(true);
          // bad options fall back to defaults; they never produce a section larger than one chunk allows
          for (const s of d.sections) expect(s.chunkIds.length).toBeGreaterThan(0);
        },
      ),
      params({ scale: 0.5 }),
    );
    // a document object whose text is not a string is treated as empty
    const odd = chunker.chunk({ ...srcDoc(''), text: undefined as unknown as string }, OPTS);
    expect(odd.chunks).toEqual([]);
  });

  // CPU budgets only need to separate linear from quadratic behaviour (seconds), so they are generous.
  const BUDGET_MS = 5000;
  const bombs = fc.oneof(
    fc.tuple(fc.constantFrom('[', '*a', '[a](b ', ']', '~~a', '_x', '`', '<', '![', '*', '**_'), fc.integer({ min: 1000, max: 12000 })).map(([t, n]) => `# T\n\n${t.repeat(n)}\n`),
    fc.tuple(fc.constantFrom('- ', '> ', '1. ', '- > ', '> - ', '* * '), fc.integer({ min: 20, max: 4000 })).map(([t, n]) => `${t.repeat(n)}x\n`),
    fc.integer({ min: 10, max: 600 }).map((n) => Array.from({ length: n }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n')),
    fc.tuple(markdownDoc({ maxBlocks: 8 }), fc.integer({ min: 1, max: 40 })).map(([d, n]) => d.repeat(n)),
    fc.array(hostileString({ maxLength: 300 }), { minLength: 5, maxLength: 30 }).map((l) => l.join('\n\n')),
    fc.integer({ min: 100, max: 3000 }).map((n) => `${'<!-- ai-bdd: '.repeat(n)}`),
    fc.integer({ min: 100, max: 6000 }).map((n) => `---\n${'- a\n'.repeat(n)}`),
  );

  it('terminates within a CPU budget on delimiter bombs, deep nesting and repeated documents', () => {
    fc.assert(
      fc.property(bombs, (text) => {
        const d: { out?: ChunkedDoc } = {};
        const used = cpuMs(() => {
          d.out = chunk(text);
        });
        expect(used).toBeLessThan(BUDGET_MS);
        expect(d.out?.diagnostics.filter((x) => x.severity === 'error' && x.message.startsWith('could not parse'))).toEqual([]);
      }),
      params({ scale: 0.1 }),
    );
  });

  it('is deterministic: chunking the same text twice gives byte-identical stable JSON', () => {
    fc.assert(
      fc.property(anyDocText(), (text) => {
        expect(json(chunk(text))).toBe(json(chunk(text)));
      }),
      params(),
    );
  });

  it('chunk ids and anchors are unique, follow the anchor grammar, and ids are derived from the uri and anchor', () => {
    fc.assert(
      fc.property(anyDocText(), fc.stringMatching(/^[a-z0-9/_.-]{1,20}$/), (text, uri) => {
        const d = chunker.chunk(srcDoc(text, uri), OPTS);
        const ids = new Set<string>();
        const anchors = new Set<string>();
        for (const c of d.chunks) {
          expect(c.id).toBe(`${uri}#${c.anchor}`);
          // anchors are built from slugs ([a-z0-9-]), path separators and the fixed segments h / p<n> / li<n> / tr<n> / code<n> / bq<n>
          expect(c.anchor).toMatch(/^[a-z0-9_/-]+$/);
          expect(ids.has(c.id)).toBe(false);
          expect(anchors.has(c.anchor)).toBe(false);
          ids.add(c.id);
          anchors.add(c.anchor);
        }
        const sectionIds = new Set<string>();
        for (const s of d.sections) {
          expect(sectionIds.has(s.id)).toBe(false);
          sectionIds.add(s.id);
          expect(s.id.startsWith(`${uri}#`)).toBe(true);
        }
      }),
      params(),
    );
  });

  it('output does not depend on line-ending style or a leading BOM (LF, CRLF and CR all give the LF result)', () => {
    fc.assert(
      fc.property(markdownDoc(), eolArb, fc.boolean(), (lf, eol, bom) => {
        const variant = (bom ? '﻿' : '') + withLineEnding(lf, eol);
        expect(json(chunk(variant))).toBe(json(chunk(lf)));
      }),
      params(),
    );
  });

  it('ranges stay inside the source, ordered, with a column span consistent with the lines of the (LF-normalized) text', () => {
    fc.assert(
      fc.property(anyDocText(), (text) => {
        const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
        const d = chunk(text);
        for (const c of d.chunks) {
          const r = c.range;
          expect(r.startLine).toBeGreaterThanOrEqual(1);
          expect(r.endLine).toBeLessThanOrEqual(lines.length);
          expect(r.startLine).toBeLessThanOrEqual(r.endLine);
          expect(r.endColumn).toBeLessThanOrEqual((lines[r.endLine - 1] as string).length + 1);
          expect(r.startColumn).toBeLessThanOrEqual((lines[r.startLine - 1] as string).length + 1);
          if (r.startLine === r.endLine) expect(r.startColumn).toBeLessThanOrEqual(r.endColumn);
          expect(c.hash).toBe(sha256Hex(c.text));
          expect(c.text).toBe(normalizeText(c.text));
        }
      }),
      params(),
    );
  });

  describe('quote grounding: chunk text is the document text at the chunk range', () => {
    const word = fc.stringMatching(/^[a-z]{3,10}$/);
    const para = fc.array(word, { minLength: 1, maxLength: 12 });

    /** A document of plain-word blocks with a known expectation per block. Words are unique so every position is unambiguous. */
    const plain = fc
      .array(
        fc.record({
          kind: fc.constantFrom('heading', 'paragraph', 'wrapped', 'bullet', 'quote', 'code'),
          words: para,
          level: fc.integer({ min: 1, max: 4 }),
        }),
        { minLength: 1, maxLength: 12 },
      )
      .map((blocks) => {
        let n = 0;
        return blocks.map((b) => ({ ...b, words: b.words.map((w) => `${w}${n++}x`) }));
      });

    function render(blocks: { kind: string; words: string[]; level: number }[]): string {
      return blocks
        .map((b) => {
          const text = b.words.join(' ');
          switch (b.kind) {
            case 'heading':
              return `${'#'.repeat(b.level)} ${text}`;
            case 'wrapped':
              return b.words.join('\n');
            case 'bullet':
              return `- ${text}`;
            case 'quote':
              return `> ${text}`;
            case 'code':
              return `\`\`\`\n${b.words.join('\n')}\n\`\`\``;
            default:
              return text;
          }
        })
        .join('\n\n');
    }

    it('every chunk text equals the normalized source slice of its range with block markers removed', () => {
      fc.assert(
        fc.property(plain, eolArb, (blocks, eol) => {
          const source = render(blocks);
          const d = chunk(withLineEnding(source, eol));
          const lines = source.split('\n');
          expect(d.chunks.length).toBe(blocks.length);
          d.chunks.forEach((c, i) => {
            const b = blocks[i] as (typeof blocks)[number];
            const slice = lines.slice(c.range.startLine - 1, c.range.endLine);
            let sliceText = normalizeText(slice.join(' '));
            if (b.kind === 'heading') sliceText = sliceText.replace(/^#+\s*/, '');
            if (b.kind === 'bullet') sliceText = sliceText.replace(/^-\s*/, '');
            if (b.kind === 'quote') sliceText = sliceText.replace(/^>\s*/, '');
            if (b.kind === 'code') sliceText = sliceText.replace(/^```\s*/, '').replace(/\s*```$/, '');
            expect(c.text).toBe(sliceText);
            expect(c.text).toBe(b.words.join(' '));
            expect(c.kind).toBe({ heading: 'heading', paragraph: 'paragraph', wrapped: 'paragraph', bullet: 'listItem', quote: 'blockquote', code: 'code' }[b.kind]);
          });
          // blocks are emitted in document order and never overlap
          for (let i = 1; i < d.chunks.length; i += 1) {
            expect((d.chunks[i] as (typeof d.chunks)[number]).range.startLine).toBeGreaterThan((d.chunks[i - 1] as (typeof d.chunks)[number]).range.endLine);
          }
        }),
        params(),
      );
    });

    it('re-chunking the text of every paragraph chunk gives one identical paragraph chunk (fixed point)', () => {
      fc.assert(
        fc.property(plain, (blocks) => {
          const d = chunk(render(blocks));
          for (const c of d.chunks.filter((x) => x.kind === 'paragraph')) {
            const again = chunk(c.text);
            expect(again.chunks.map((x) => [x.kind, x.text, x.hash])).toEqual([['paragraph', c.text, c.hash]]);
          }
          // a paragraph-only document rebuilt from its own chunk texts has the same chunk hashes
          const paragraphs = d.chunks.filter((x) => x.kind === 'paragraph');
          const rebuilt = chunk(paragraphs.map((x) => x.text).join('\n\n'));
          expect(rebuilt.chunks.map((x) => x.hash)).toEqual(paragraphs.map((x) => x.hash));
        }),
        params(),
      );
    });
  });

  it('stableJson of the result round-trips, and hostile frontmatter keys never pollute Object.prototype', () => {
    fc.assert(
      fc.property(anyDocText(), (text) => {
        const d = chunk(text);
        const once = json(d);
        const parsed = JSON.parse(once) as JsonValue;
        // the result is already JSON data: parsing and re-serializing changes nothing
        expect(stableJson(parsed)).toBe(once);
        // and nothing was dropped on the way (undefined-valued keys excepted)
        expect(JSON.parse(JSON.stringify(d))).toEqual(JSON.parse(once));
        assertPrototypeClean();
        const fm = d.doc.frontmatter;
        if (fm !== undefined && fm !== null && typeof fm === 'object' && !Array.isArray(fm)) expect(Object.getPrototypeOf(fm)).toBe(Object.prototype);
      }),
      params(),
    );
  });
});
