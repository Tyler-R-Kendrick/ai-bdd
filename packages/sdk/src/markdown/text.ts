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

const MAX_DEPTH = 256;

/** Plain text of inline content: markup removed, link text kept, images become alt text. */
export function inlineText(node: MdNode, onHtml?: (value: string) => void, depth = 0): string {
  if (depth > MAX_DEPTH) return '';
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value ?? '';
    case 'break':
      return ' ';
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'html':
      if (onHtml !== undefined && node.value !== undefined) onHtml(node.value);
      return '';
    case 'footnoteReference':
      return '';
    default: {
      if (node.children === undefined) return '';
      let out = '';
      for (const child of node.children) out += inlineText(child, onHtml, depth + 1);
      return out;
    }
  }
}

/**
 * Flatten any block subtree into plain text, one piece per leaf block. Used for
 * blockquotes, whose content becomes a single chunk.
 */
export function flattenBlocks(node: MdNode, onHtmlBlock?: (n: MdNode) => void, depth = 0): string {
  const parts: string[] = [];
  collect(node, parts, onHtmlBlock, depth);
  return normalizeText(parts.join(' '));
}

function collect(node: MdNode, out: string[], onHtmlBlock: ((n: MdNode) => void) | undefined, depth: number): void {
  if (depth > MAX_DEPTH) return;
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      out.push(inlineText(node));
      return;
    case 'code':
      out.push(node.value ?? '');
      return;
    case 'html':
      if (onHtmlBlock !== undefined) onHtmlBlock(node);
      return;
    case 'thematicBreak':
    case 'definition':
    case 'footnoteDefinition':
    case 'yaml':
      return;
    case 'table':
      for (const row of node.children ?? []) {
        out.push((row.children ?? []).map((cell) => inlineText(cell)).join(' '));
      }
      return;
    default:
      for (const child of node.children ?? []) collect(child, out, onHtmlBlock, depth + 1);
  }
}
