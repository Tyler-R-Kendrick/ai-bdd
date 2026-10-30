import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { editorSchema } from './editor.ts';
import type { RichNode } from './domain.ts';
import { documentBlockSchemas, type QuestionnaireData } from './document-blocks.ts';
export type DocumentSuggestion = { id: string; artifactId: string; anchor: string; before: string; after: string; from: number; to: number; baseVersion: number; authorId: string; author: string; status: 'pending' | 'accepted' | 'rejected'; resolvedBy: string | null; createdAt: string; resolvedAt: string | null; comment: string };
export type QuestionnaireAnswer = { id: string; artifactId: string; anchor: string; questionId: string; optionId: string; answer: string; authorId: string; author: string; createdAt: string; decisionId: string | null; question: string; option: string; supersedesId: string | null };
export type DocumentReviewState = { suggestions: DocumentSuggestion[]; answers: QuestionnaireAnswer[]; hasMore: boolean; nextCursor: number | null };
export function documentAnchor(doc: RichNode, anchor: string): { node: ProseMirrorNode; position: number } {
  const parsed = editorSchema().nodeFromJSON(doc); let found: { node: ProseMirrorNode; position: number } | undefined, count = 0;
  parsed.descendants((node, position) => { if (node.attrs.id === anchor) { count++; found = { node, position }; } });
  if (count !== 1 || !found) throw new Error('This document anchor was removed or is ambiguous. Select the current passage again.');
  return found;
}
export function suggestionPassage(doc: RichNode, anchor: string, from: number, to: number): { before: string; snapshot: string } {
  const { node } = documentAnchor(doc, anchor);
  if (!node.isTextblock || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > node.content.size) throw new Error('Choose a text passage within one paragraph or heading.');
  if (node.content.content.some(child => !child.isText && child.type.name !== 'hardBreak')) throw new Error('Suggest text changes in a passage without embedded formulas or media.');
  return { before: node.textBetween(from, to, '\n', '\n'), snapshot: JSON.stringify(node.toJSON()) };
}
export function applyDocumentSuggestion(doc: RichNode, suggestion: Pick<DocumentSuggestion, 'anchor' | 'from' | 'to' | 'before' | 'after'>, snapshot: string): RichNode {
  const passage = suggestionPassage(doc, suggestion.anchor, suggestion.from, suggestion.to);
  if (passage.snapshot !== snapshot || passage.before !== suggestion.before) throw new Error('This passage changed after the suggestion was written. The suggestion is retained; review it against the current text.');
  const schema = editorSchema(), current = schema.nodeFromJSON(doc), { position } = documentAnchor(doc, suggestion.anchor), state = EditorState.create({ schema, doc: current }), transaction = state.tr.insertText(suggestion.after, position + 1 + suggestion.from, position + 1 + suggestion.to);
  transaction.doc.check(); return transaction.doc.toJSON() as RichNode;
}
export function questionnaireAt(doc: RichNode, anchor: string): QuestionnaireData {
  const { node } = documentAnchor(doc, anchor);
  if (node.type.name !== 'questionnaireBlock') throw new Error('This questionnaire is no longer in the document.');
  return documentBlockSchemas.questionnaireBlock.parse(node.attrs.data);
}
