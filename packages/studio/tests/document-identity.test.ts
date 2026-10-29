import { describe, expect, it } from 'vitest';
import { canonicalDocumentIds } from '../shared/document-identity.ts';
import { editorSchema } from '../shared/editor.ts';
import {
  importMarkdown,
  exportMarkdown,
} from '../shared/document-interchange.ts';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
import { questionnaireAt } from '../shared/document-review.ts';
import type { RichNode } from '../shared/domain.ts';
describe('canonical document anchor identities', () => {
  it('preserves unique IDs, repairs missing/duplicate IDs once and never mutates the caller source', () => {
    const source: RichNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'original' },
          content: [{ type: 'text', text: 'One' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'original' },
          content: [{ type: 'text', text: 'Copied' }],
        },
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'A heading' }],
        },
      ],
    };
    let next = 0;
    const result = canonicalDocumentIds(source, () => 'new-' + ++next);
    expect(result.changed).toBe(true);
    expect(result.doc.content?.map((node) => node.attrs?.id)).toEqual([
      'original',
      'new-1',
      'new-2',
    ]);
    expect(source.content?.[1]?.attrs?.id).toBe('original');
    expect(source.content?.[2]?.attrs).toEqual({ level: 1 });
    expect(
      canonicalDocumentIds(result.doc, () => {
        throw new Error(
          'A canonical document must not generate new identities',
        );
      }),
    ).toEqual({ doc: result.doc, changed: false });
  });
  it('persists anchor IDs in the actual ProseMirror schema for prose, images, math, and planning widgets', () => {
    const input: RichNode = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { src: '/api/files/00000000-0000-4000-8000-000000000001' },
        },
        { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
        {
          type: 'questionnaireBlock',
          attrs: { data: documentBlockDefaults.questionnaireBlock },
        },
      ],
    };
    let next = 0;
    const normalized = canonicalDocumentIds(input, () => 'block-' + ++next),
      result = editorSchema().nodeFromJSON(normalized.doc).toJSON();
    expect(result.content.map((node: any) => node.attrs.id)).toEqual([
      'block-1',
      'block-2',
      'block-3',
    ]);
    expect(questionnaireAt(result, 'block-3').title).toBe('Choose an approach');
  });
  it('assigns usable questionnaire anchors when importing restricted MDX and retains valid existing IDs during later normalization', () => {
    const original: RichNode = {
        type: 'doc',
        content: [
          {
            type: 'questionnaireBlock',
            attrs: { data: documentBlockDefaults.questionnaireBlock },
          },
        ],
      },
      imported = importMarkdown(exportMarkdown(original, true), true).doc,
      anchor = imported.content?.[0]?.attrs?.id;
    expect(typeof anchor).toBe('string');
    expect(questionnaireAt(imported, String(anchor)).questions[0]?.id).toBe(
      'approach',
    );
    expect(canonicalDocumentIds(imported, () => 'unused').changed).toBe(false);
  });
  it('bounds malformed generators and nested input instead of silently producing ambiguous anchors', () => {
    expect(() =>
      canonicalDocumentIds(
        { type: 'doc', content: [{ type: 'paragraph' }] },
        () => '',
      ),
    ).toThrow('invalid ID');
    expect(() =>
      canonicalDocumentIds(
        {
          type: 'doc',
          content: [
            { type: 'paragraph', attrs: { id: 'same' } },
            { type: 'paragraph' },
          ],
        },
        () => 'same',
      ),
    ).toThrow('unique ID');
  });
  it('reserves later valid IDs before allocating missing anchors', () => {
    let count = 0;
    const result = canonicalDocumentIds(
      {
        type: 'doc',
        content: [
          { type: 'paragraph' },
          { type: 'paragraph', attrs: { id: 'keep-me' } },
        ],
      },
      () => (++count === 1 ? 'keep-me' : 'fresh'),
    );
    expect(result.doc.content.map((node) => node.attrs?.id)).toEqual([
      'fresh',
      'keep-me',
    ]);
  });
});
