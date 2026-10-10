// @ts-nocheck
import { normalizeText } from '../util/index.ts';

/** Minimal structural view of an mdast node; avoids tying the walker to the full mdast union. */
export interface MdNode {
  type: string;
  value?: string;
  alt?: string | null;
  depth?: number;
  children?: MdNode[];
  position?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

/** Plain text of inline content: markup removed, link text kept, images become alt text. Iterative, so depth is unbounded. */
export function inlineText(root: MdNode, onHtml?: (value: string) => void): string {
  let out = '';
  const stack: MdNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as MdNode;
    switch (node.type) {
      case 'text':
      case 'inlineCode':
        out += node.value ?? '';
        break;
      case 'break':
        out += ' ';
        break;
      case 'image':
      case 'imageReference':
        out += node.alt ?? '';
        break;
      case 'html':
        if (onHtml !== undefined && node.value !== undefined) onHtml(node.value);
        break;
      case 'footnoteReference':
        break;
      default: {
        const kids = node.children;
        if (kids !== undefined) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as MdNode);
      }
    }
  }
  return out;
}

/**
 * Flatten any block subtree into plain text, one piece per leaf block. Used for
 * blockquotes, whose content becomes a single chunk.
 */
export function flattenBlocks(root: MdNode, onHtmlBlock?: (n: MdNode) => void): string {
  const parts: string[] = [];
  const stack: MdNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as MdNode;
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        parts.push(inlineText(node));
        break;
      case 'code':
        parts.push(node.value ?? '');
        break;
      case 'html':
        if (onHtmlBlock !== undefined) onHtmlBlock(node);
        break;
      case 'thematicBreak':
      case 'definition':
      case 'footnoteDefinition':
      case 'yaml':
        break;
      case 'table':
        for (const row of node.children ?? []) parts.push((row.children ?? []).map((cell) => inlineText(cell)).join(' '));
        break;
      default: {
        const kids = node.children;
        if (kids !== undefined) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as MdNode);
      }
    }
  }
  return normalizeText(parts.join(' '));
}
