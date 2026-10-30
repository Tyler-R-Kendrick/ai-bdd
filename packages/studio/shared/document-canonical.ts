import type { RichNode } from './domain.ts';
import { canonicalDocumentIds } from './document-identity.ts';

/** Match StarterKit TrailingNode before assigning IDs or serializing durable Yjs state. */
export function canonicalDocument(
  source: RichNode,
  generateId: () => string,
): { doc: RichNode; changed: boolean } {
  if (source.type !== 'doc')
    throw new Error('Canonical document source must be a document');
  const append = source.content?.at(-1)?.type !== 'paragraph';
  // Do not mutate the caller. canonicalDocumentIds clones the completed source once.
  const input = append
    ? { ...source, content: [...(source.content ?? []), { type: 'paragraph' }] }
    : source;
  const normalized = canonicalDocumentIds(input, generateId);
  return { doc: normalized.doc, changed: append || normalized.changed };
}
