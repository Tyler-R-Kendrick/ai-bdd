import type { RichNode } from './domain.ts';
import { investigationBlockSchemas } from './investigations.ts';
export type InvestigationBlockKind = keyof typeof investigationBlockSchemas;
export function isInvestigationBlockKind(
  value: string,
): value is InvestigationBlockKind {
  return Object.hasOwn(investigationBlockSchemas, value);
}
/** Exports preserve record identity; they never invent a dataset or result snapshot. */
export function investigationBlockText(
  kind: InvestigationBlockKind,
  value: unknown,
) {
  if (kind === 'investigationView') {
    const data = investigationBlockSchemas.investigationView.parse(value);
    return `Investigation view: ${data.investigationId}\nView: ${data.viewId}`;
  }
  const data = investigationBlockSchemas.investigationCard.parse(value);
  return `Investigation request: ${data.investigationId}`;
}
export type InvestigationReference = {
  kind: InvestigationBlockKind;
  investigationId: string;
  viewId?: string;
};
export function investigationReferences(
  root: RichNode,
): InvestigationReference[] {
  const references: InvestigationReference[] = [];
  let nodes = 0;
  const walk = (node: RichNode, depth: number) => {
    if (++nodes > 50000 || depth > 40)
      throw new Error(
        'Document investigation references exceed the node/depth limit',
      );
    if (isInvestigationBlockKind(node.type)) {
      const data = investigationBlockSchemas[node.type].parse(node.attrs?.data);
      references.push({ kind: node.type, ...data });
      if (references.length > 100)
        throw new Error(
          'A document can reference at most100 investigation cards/views',
        );
    }
    for (const child of node.content ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return references;
}
