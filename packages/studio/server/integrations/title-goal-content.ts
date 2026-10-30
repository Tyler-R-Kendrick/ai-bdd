import type { Artifact, RichNode } from '../../shared/domain.ts';
/** A title scaffold and blank text paragraphs are the only accepted empty body. */
export function hasEmptyDocumentBody(
  artifact: Pick<Artifact, 'kind' | 'title' | 'content'>,
): boolean {
  if (!['design', 'document'].includes(artifact.kind)) return false;
  const doc = artifact.content.doc as RichNode | undefined;
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return false;
  return doc.content.every((node, index) => {
    if (node.type === 'heading') {
      return (
        index === 0 &&
        node.content?.every((part) => part.type === 'text') !== false &&
        (node.content ?? []).map((part) => part.text ?? '').join('') ===
          artifact.title
      );
    }
    return (
      node.type === 'paragraph' &&
      (node.content ?? []).every(
        (part) => part.type === 'text' && !(part.text ?? '').trim(),
      )
    );
  });
}
export function seedDocumentGoal(
  artifact: Artifact,
  title: string,
  goal: string,
): Record<string, any> {
  if (!hasEmptyDocumentBody(artifact))
    throw new Error('The document body is no longer empty');
  const content = structuredClone(artifact.content),
    nodes = content.doc.content as RichNode[];
  if (nodes[0]?.type === 'heading')
    nodes[0].content = [{ type: 'text', text: title }];
  const paragraph = nodes.find((node) => node.type === 'paragraph');
  if (paragraph) paragraph.content = [{ type: 'text', text: goal }];
  else
    nodes.push({ type: 'paragraph', content: [{ type: 'text', text: goal }] });
  return content;
}
