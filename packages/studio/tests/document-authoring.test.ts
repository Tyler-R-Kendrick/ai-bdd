import { describe, expect, it } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import { editorSchema } from '../shared/editor.ts';
import {
  findDocumentText,
  replaceDocumentMatches,
} from '../shared/document-authoring.ts';
const schema = editorSchema();
const doc = () =>
  schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'shared', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' plan and SHARED evidence.' },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'İstanbul and plan.*' }],
      },
    ],
  });
describe('document find and replace', () => {
  it('finds literal text across inline mark boundaries and preserves original UTF-16 positions', () => {
    const current = doc(),
      matches = findDocumentText(current, 'shared plan').matches;
    expect(matches).toHaveLength(1);
    expect(current.textBetween(matches[0]!.from, matches[0]!.to)).toBe(
      'shared plan',
    );
    const unicode = findDocumentText(current, 'plan.*').matches;
    expect(unicode).toHaveLength(1);
    expect(current.textBetween(unicode[0]!.from, unicode[0]!.to)).toBe(
      'plan.*',
    );
  });
  it('uses case-aware literal matching without treating user input as a regular expression', () => {
    expect(findDocumentText(doc(), 'shared').matches).toHaveLength(2);
    expect(findDocumentText(doc(), 'shared', true).matches).toHaveLength(1);
    expect(findDocumentText(doc(), '.*').matches).toHaveLength(1);
  });
  it('replaces all exact matches from the end and rejects a stale search result', () => {
    const current = doc(),
      state = EditorState.create({ schema, doc: current }),
      matches = findDocumentText(current, 'shared').matches,
      transaction = replaceDocumentMatches(state.tr, matches, 'reviewed');
    expect(transaction.doc.textContent).toContain(
      'The reviewed plan and reviewed evidence.',
    );
    expect(() =>
      replaceDocumentMatches(
        state.tr.insertText('Changed ', 1),
        matches,
        'reviewed',
      ),
    ).toThrow('search results changed');
  });
  it('bounds search output and refuses replacement on an unbounded match set', () => {
    const current = schema.nodeFromJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'a'.repeat(600) }],
          },
        ],
      }),
      result = findDocumentText(current, 'a');
    expect(result.matches).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
});
