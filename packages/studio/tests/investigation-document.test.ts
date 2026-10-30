import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { editorSchema } from '../shared/editor.ts';
import { validateContent, type RichNode } from '../shared/domain.ts';
import { canonicalDocumentIds } from '../shared/document-identity.ts';
import {
  investigationReferences,
  investigationBlockText,
} from '../shared/investigation-blocks.ts';
import {
  importMarkdown,
  exportMarkdown,
  exportDocx,
  importDocx,
} from '../shared/document-interchange.ts';
const investigationId = randomUUID();
const doc: RichNode = {
  type: 'doc',
  content: [
    { type: 'investigationCard', attrs: { data: { investigationId } } },
    {
      type: 'investigationView',
      attrs: { data: { investigationId, viewId: 'observations' } },
    },
  ],
};
describe('record-backed investigation document source', () => {
  it('shares exact bounded schemas with canonical source validation and ProseMirror nodes', () => {
    expect(() => validateContent('document', { doc })).not.toThrow();
    expect(() => editorSchema().nodeFromJSON(doc).check()).not.toThrow();
    expect(investigationReferences(doc)).toEqual([
      { kind: 'investigationCard', investigationId },
      { kind: 'investigationView', investigationId, viewId: 'observations' },
    ]);
    for (const bad of [
      { investigationId: 'fabricated' },
      { investigationId, viewId: 'with whitespace' },
      { investigationId, viewId: 'observations', rows: [{ fake: true }] },
    ])
      expect(() =>
        validateContent('document', {
          doc: {
            type: 'doc',
            content: [{ type: 'investigationView', attrs: { data: bad } }],
          },
        }),
      ).toThrow();
  });
  it('canonicalizes stable block identities and roundtrips the actual record/view identity through restricted Markdown and MDX', () => {
    const normalized = canonicalDocumentIds(doc, randomUUID).doc;
    expect(normalized.content![0]!.attrs?.id).toBeTruthy();
    expect(normalized.content![1]!.attrs?.id).toBeTruthy();
    for (const restricted of [false, true]) {
      const source = exportMarkdown(normalized, restricted),
        imported = importMarkdown(source, restricted);
      expect(investigationReferences(imported.doc)).toEqual(
        investigationReferences(doc),
      );
      expect(source).toContain(investigationId);
      expect(source).not.toContain('rows');
    }
  });
  it('exports honest readable identity references in office interchange without inventing result data', () => {
    expect(
      investigationBlockText('investigationView', {
        investigationId,
        viewId: 'observations',
      }),
    ).toContain('View: observations');
    const word = importDocx(exportDocx(doc, 'Investigation reference'));
    expect(JSON.stringify(word.doc)).toContain(investigationId);
    expect(JSON.stringify(word.doc)).toContain('observations');
    const schema = editorSchema(),
      node = schema.nodeFromJSON(doc.content![1]!);
    const html = JSON.stringify(node.type.spec.toDOM!(node));
    expect(html).toContain(investigationId);
    expect(html).toContain('observations');
    expect(html).not.toContain('fake result');
  });
  it('bounds investigation references before any database lookup', () => {
    expect(() =>
      investigationReferences({
        type: 'doc',
        content: Array.from({ length: 101 }, () => doc.content![0]!),
      }),
    ).toThrow('at most100');
  });
});
