import type { Node } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
export type DocumentTextMatch = { from: number; to: number; text: string };
export function findDocumentText(
  document: Node,
  query: string,
  caseSensitive = false,
  limit = 500,
): { matches: DocumentTextMatch[]; truncated: boolean } {
  if (!query || query.length > 500) return { matches: [], truncated: false };
  const pattern = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      caseSensitive ? 'gu' : 'giu',
    ),
    matches: DocumentTextMatch[] = [];
  let truncated = false;
  document.descendants((node, position) => {
    if (!node.isTextblock || truncated) return;
    const text = node.textBetween(0, node.content.size, '', '\uFFFC');
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (matches.length === limit) {
        truncated = true;
        break;
      }
      matches.push({
        from: position + 1 + match.index!,
        to: position + 1 + match.index! + match[0].length,
        text: match[0],
      });
    }
  });
  return { matches, truncated };
}
/** Apply against the exact transaction document that was searched, from the end so earlier positions remain stable. */
export function replaceDocumentMatches(
  transaction: Transaction,
  matches: DocumentTextMatch[],
  replacement: string,
): Transaction {
  if (matches.length > 500 || replacement.length > 20000)
    throw new Error('Narrow the search or use a shorter replacement');
  for (const match of [...matches].reverse()) {
    if (
      transaction.doc.textBetween(match.from, match.to, '', '\uFFFC') !==
      match.text
    )
      throw new Error(
        'The search results changed. Search the current document again.',
      );
    transaction.insertText(replacement, match.from, match.to);
  }
  return transaction;
}
