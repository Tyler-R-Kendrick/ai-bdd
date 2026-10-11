import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ChunkedDoc } from '../../src/contracts/index.ts';
import { chunkText, lineLengths } from './helpers.ts';

const numRuns = Number(process.env['FC_RUNS'] ?? 200);
const params = { numRuns };

/** Markdown-flavoured fragments so random documents exercise headings, lists, tables, fences, directives and frontmatter. */
const FRAGMENTS = [
  '# ', '## ', '### ', '#### ', '- ', '  - ', '1. ', '> ', '```', '~~~', '    ', '\t', '| a | b |', '|---|---|', '| 1 | 2 |',
  '<!-- ai-bdd: ignore -->', '<!-- ai-bdd: context -->', '<!-- ai-bdd: fuzzy tags=a,b driver=web -->', '<!-- ai-bdd: bogus=1 -->',
  '<!-- ai-bdd: start="/x y" -->', '<!--', '-->', '---', '***', '[x](http://y)', '![img](a.png)', '`code`', '**b**', '_i_', '[^1]', '[^1]: n',
  '\n', '\n\n', '\r\n', '\r', 'word', 'text', 'Ünï', '日本', '😀', ' ', '  ', 'tags=', '"',
];

const markdownish = fc
  .array(fc.constantFrom(...FRAGMENTS), { minLength: 0, maxLength: 60 })
  .map((parts) => parts.join(''));

const withFrontmatter = fc.tuple(fc.constantFrom('', '---\ntitle: x\n---\n', '---\nai-bdd:\n  tags: [a]\n  ignore: false\n---\n', '---\n: bad\n  - [\n---\n'), markdownish).map(([f, b]) => f + b);

const anyText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 400 }),
  fc.string({ unit: 'grapheme', maxLength: 200 }),
  markdownish,
  withFrontmatter,
);

const optionsArb = fc.record({
  sectionDepth: fc.integer({ min: 0, max: 7 }),
  maxSectionChars: fc.integer({ min: 1, max: 400 }),
});

function checkInvariants(text: string, d: ChunkedDoc, maxSectionChars: number): void {
  const lens = lineLengths(text);
  const chunkIds = new Set<string>();
  for (const c of d.chunks) {
    // ids are unique and follow the anchor grammar
    expect(chunkIds.has(c.id)).toBe(false);
    chunkIds.add(c.id);
    expect(c.id).toBe(`${d.doc.uri}#${c.anchor}`);
    expect(c.text.length).toBeGreaterThan(0);
    // ranges stay inside the input, end column exclusive
    const r = c.range;
    expect(r.startLine).toBeGreaterThanOrEqual(1);
    expect(r.endLine).toBeLessThanOrEqual(lens.length);
    expect(r.startLine).toBeLessThanOrEqual(r.endLine);
    expect(r.startColumn).toBeGreaterThanOrEqual(1);
    expect(r.startColumn).toBeLessThanOrEqual((lens[r.startLine - 1] ?? 0) + 1);
    expect(r.endColumn).toBeGreaterThanOrEqual(1);
    expect(r.endColumn).toBeLessThanOrEqual((lens[r.endLine - 1] ?? 0) + 1);
    if (r.startLine === r.endLine) expect(r.startColumn).toBeLessThanOrEqual(r.endColumn);
  }
  // parents precede their children
  const seen = new Set<string>();
  for (const c of d.chunks) {
    if (c.parentId !== undefined) expect(seen.has(c.parentId)).toBe(true);
    seen.add(c.id);
  }
  // sections: unique ids, partition the included chunks, size limit holds unless a single chunk
  const sectionIds = new Set<string>();
  const placed = new Set<string>();
  for (const s of d.sections) {
    expect(sectionIds.has(s.id)).toBe(false);
    sectionIds.add(s.id);
    expect(s.chunkIds.length).toBeGreaterThan(0);
    let total = 0;
    for (const id of s.chunkIds) {
      expect(placed.has(id)).toBe(false);
      placed.add(id);
      const c = d.chunks.find((x) => x.id === id);
      expect(c).toBeDefined();
      expect(c?.sectionId).toBe(s.id);
      expect(c?.directives.ignore).not.toBe(true);
      expect(c?.directives.context).not.toBe(true);
      total += c?.text.length ?? 0;
    }
    if (s.chunkIds.length > 1) expect(total).toBeLessThanOrEqual(maxSectionChars);
  }
  const included = d.chunks.filter((c) => c.directives.ignore !== true && c.directives.context !== true);
  expect([...placed].sort()).toEqual(included.map((c) => c.id).sort());
  for (const id of d.contextChunkIds) expect(chunkIds.has(id)).toBe(true);
}

describe('markdown properties', () => {
  it('R-EX4: never throws on arbitrary strings and always returns a structurally valid document', () => {
    fc.assert(
      fc.property(anyText, optionsArb, (text, opts) => {
        const d = chunkText(text, opts);
        expect(d.doc.uri).toBe('docs/test.md');
        expect(d.diagnostics.every((x) => x.severity !== 'error')).toBe(true);
      }),
      params,
    );
  });

  it('R-EX4: ranges stay within input bounds, chunk and section ids are unique, sections partition included chunks', () => {
    fc.assert(
      fc.property(anyText, optionsArb, (text, opts) => {
        checkInvariants(text, chunkText(text, opts), opts.maxSectionChars);
      }),
      params,
    );
  });

  it('R-EX6: splitting is deterministic and only splits at chunk boundaries (no chunk text is cut)', () => {
    fc.assert(
      fc.property(markdownish, fc.integer({ min: 1, max: 120 }), (text, maxSectionChars) => {
        const a = chunkText(text, { maxSectionChars });
        const b = chunkText(text, { maxSectionChars });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        const whole = chunkText(text, { maxSectionChars: 1_000_000 });
        expect(a.chunks.map((c) => [c.id, c.text, c.hash])).toEqual(whole.chunks.map((c) => [c.id, c.text, c.hash]));
        const concat = (d: ChunkedDoc): string[] => d.sections.flatMap((s) => s.chunkIds);
        expect(concat(a)).toEqual(concat(whole));
      }),
      params,
    );
  });

  it('R-PL4: CRLF, CR and BOM variants produce exactly the LF result', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FRAGMENTS.filter((f) => !f.includes('\r'))), { maxLength: 50 }).map((p) => p.join('')),
        (text) => {
          const norm = (t: string): string => JSON.stringify({ ...chunkText(t), doc: undefined });
          const expected = norm(text);
          expect(norm(text.replace(/\n/g, '\r\n'))).toBe(expected);
          expect(norm(text.replace(/\n/g, '\r'))).toBe(expected);
          expect(norm(`﻿${text}`)).toBe(expected);
        },
      ),
      params,
    );
  });

  const word = fc.stringMatching(/^[a-z]{3,9}$/);
  const paragraphs = fc.array(fc.array(word, { minLength: 1, maxLength: 6 }).map((w) => w.join(' ')), { minLength: 1, maxLength: 12 });

  it('R-PL2: editing one paragraph changes only that chunk hash and its section hash', () => {
    fc.assert(
      fc.property(paragraphs, fc.nat(), word, (paras, pick, extra) => {
        const index = pick % paras.length;
        const build = (list: string[]): string => `# Doc\n\n${list.map((p, i) => (i % 4 === 3 ? `## S${i}\n\n${p}` : p)).join('\n\n')}\n`;
        const edited = paras.map((p, i) => (i === index ? `${p} ${extra}ZZ` : p));
        const a = chunkText(build(paras));
        const b = chunkText(build(edited));
        expect(b.chunks.map((c) => c.id)).toEqual(a.chunks.map((c) => c.id));
        const changed = a.chunks.filter((c, i) => c.hash !== b.chunks[i]?.hash);
        expect(changed).toHaveLength(1);
        expect(changed[0]?.text).toBe(paras[index]);
        const changedSections = a.sections.filter((s, i) => s.hash !== b.sections[i]?.hash);
        expect(changedSections.map((s) => s.id)).toEqual([changed[0]?.sectionId]);
      }),
      params,
    );
  });

  it('R-PL2: inserting a paragraph leaves every existing chunk hash unchanged', () => {
    fc.assert(
      fc.property(paragraphs, fc.nat(), word, (paras, pick, extra) => {
        const at = pick % (paras.length + 1);
        const inserted = [...paras.slice(0, at), `${extra} inserted`, ...paras.slice(at)];
        const a = chunkText(`# Doc\n\n${paras.join('\n\n')}\n`);
        const b = chunkText(`# Doc\n\n${inserted.join('\n\n')}\n`);
        const bh = b.chunks.map((c) => c.hash);
        for (const c of a.chunks) expect(bh).toContain(c.hash);
        expect(b.chunks.length).toBe(a.chunks.length + 1);
      }),
      params,
    );
  });

  it('R-EX4: ignore and context never leak into section chunk lists, whatever the scoping', () => {
    fc.assert(
      fc.property(markdownish, (text) => {
        const d = chunkText(text);
        const inSection = new Set(d.sections.flatMap((s) => s.chunkIds));
        for (const c of d.chunks) {
          if (c.directives.ignore === true || c.directives.context === true) expect(inSection.has(c.id)).toBe(false);
        }
        for (const id of d.contextChunkIds) {
          const c = d.chunks.find((x) => x.id === id);
          expect(c?.directives.context).toBe(true);
          expect(c?.directives.ignore).not.toBe(true);
        }
      }),
      params,
    );
  });
});
