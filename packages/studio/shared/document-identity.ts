import type { RichNode } from './domain.ts';
/** The schema, canonical writer, and client use the same anchor-bearing node types. */
export const documentAnchorTypes = [
  'heading',
  'paragraph',
  'testBlock',
  'researchBlock',
  'chartBlock',
  'diagramBlock',
  'tabsBlock',
  'table',
  'blockquote',
  'codeBlock',
  'calloutBlock',
  'columnsBlock',
  'questionnaireBlock',
  'artifactReferenceBlock',
  'evidenceBlock',
  'investigationCard',
  'investigationView',
  'image',
  'horizontalRule',
  'blockMath',
  'listItem',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const;
const anchored = new Set<string>(documentAnchorTypes);
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 100 &&
  !Array.from(value).some(
    (character) =>
      character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
  );
/** Clone once. The caller supplies UUIDs and persists this exact result/state inside its authoritative write lock. */
export function canonicalDocumentIds<T extends RichNode>(
  source: T,
  generateId: () => string,
): { doc: T; changed: boolean } {
  const doc = structuredClone(source),
    used = new Set<string>();
  let changed = false,
    visited = 0;
  const reserved = new Set<string>();
  const reserve = (node: RichNode, depth: number) => {
    if (++visited > 50000 || depth > 40)
      throw new Error(
        'Document anchor normalization exceeds the node/depth limit',
      );
    if (anchored.has(node.type) && validId(node.attrs?.id))
      reserved.add(node.attrs.id);
    for (const child of node.content ?? []) reserve(child, depth + 1);
  };
  reserve(doc, 0);
  visited = 0;
  const walk = (node: RichNode, depth: number) => {
    if (++visited > 50000 || depth > 40)
      throw new Error(
        'Document anchor normalization exceeds the node/depth limit',
      );
    if (anchored.has(node.type)) {
      const current = node.attrs?.id;
      if (validId(current) && !used.has(current)) used.add(current);
      else {
        let id = '';
        for (let attempt = 0; attempt < 1000; attempt++) {
          const candidate = generateId();
          if (!validId(candidate))
            throw new Error('Document anchor generator returned an invalid ID');
          if (!used.has(candidate) && !reserved.has(candidate)) {
            id = candidate;
            break;
          }
        }
        if (!id)
          throw new Error(
            'Document anchor generator could not produce a unique ID',
          );
        node.attrs = { ...node.attrs, id };
        used.add(id);
        changed = true;
      }
    }
    for (const child of node.content ?? []) walk(child, depth + 1);
  };
  walk(doc, 0);
  return { doc, changed };
}
