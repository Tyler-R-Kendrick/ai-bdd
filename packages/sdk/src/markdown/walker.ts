import type { ChunkKind, Diagnostic, ErrorCode, JsonValue, SourceRange } from '../contracts/index.ts';
import { normalizeText, slugify } from '../util/index.ts';
import {
  directiveBody,
  emptyDirectiveSet,
  findComments,
  mergeInto,
  parseDirectiveText,
  type DirectiveSet,
} from './directives.ts';
import { flattenBlocks, inlineText, type MdNode } from './text.ts';

/** A chunk before directives are resolved and sections are assigned. */
export interface RawChunk {
  id: string;
  anchor: string;
  /** Anchor of the nearest enclosing heading path (`_preamble` before the first heading). */
  pathAnchor: string;
  kind: ChunkKind;
  headingPath: string[];
  text: string;
  range: SourceRange;
  parentId?: string;
  /** Directive scopes, outermost first. Heading scopes are mutated while walking, so resolve only afterwards. */
  scopes: DirectiveSet[];
  /** Heading level, for heading chunks only. */
  level?: number;
}

interface HeadingEntry {
  level: number;
  slug: string;
  text: string;
  scope: DirectiveSet;
}

interface Pending {
  set: DirectiveSet;
  range: SourceRange;
}

interface Ctx {
  parentId: string | undefined;
  /** Extra scopes below the heading scopes (list/node level directives). */
  extra: DirectiveSet[];
}

const ABBR: Record<ChunkKind, string> = {
  // Stryker disable next-line StringLiteral: equivalent mutant, heading chunks are pushed with a literal anchor and never go through emit, so this entry is never read
  heading: 'h',
  paragraph: 'p',
  listItem: 'li',
  tableRow: 'tr',
  code: 'code',
  blockquote: 'bq',
};

const ZERO_RANGE: SourceRange = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };

export function rangeOf(node: MdNode): SourceRange {
  const p = node.position;
  if (p === undefined) return ZERO_RANGE;
  return { startLine: p.start.line, startColumn: p.start.column, endLine: p.end.line, endColumn: p.end.column };
}

/**
 * Walks an mdast tree and emits block-level chunks with anchors, ids and directive scopes (spec 6.2, 6.3, 3.2).
 */
export class Walker {
  readonly chunks: RawChunk[] = [];
  readonly diagnostics: Diagnostic[] = [];
  title: string | undefined;

  private readonly stack: HeadingEntry[] = [];
  private readonly counters = new Map<string, number>();
  private readonly usedSlugs = new Map<string, Set<string>>();
  private readonly slugCounts = new Map<string, number>();
  // Stryker disable next-line BooleanLiteral: equivalent mutant, with no heading entered the stack is empty and the top check already sends directives to the pending list
  private afterHeading = false;

  private readonly docUri: string;
  private readonly base: DirectiveSet;

  constructor(docUri: string, base: DirectiveSet) {
    this.docUri = docUri;
    this.base = base;
  }

  diag(code: ErrorCode, message: string, range?: SourceRange, details?: JsonValue): void {
    const d: Diagnostic = { code, severity: 'warning', message, uri: this.docUri };
    if (range !== undefined) d.range = range;
    if (details !== undefined) d.details = details;
    this.diagnostics.push(d);
  }

  walkRoot(children: readonly MdNode[]): void {
    const pending: Pending[] = [];
    for (const node of children) {
      if (node.type === 'html') {
        const found = this.readDirectives(node);
        // Stryker disable next-line ConditionalExpression: equivalent mutant, an empty list adds nothing to the heading scope or to pending
        if (found.length === 0) continue;
        const top = this.stack[this.stack.length - 1];
        if (this.afterHeading && top !== undefined) for (const f of found) mergeInto(top.scope, f.set);
        else pending.push(...found);
        continue;
      }
      // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent mutant, a yaml node yields no chunk and carries no pending directives, so walking it as a block does nothing
      if (node.type === 'yaml') continue;
      const nodeScopes = this.consume(pending, node);
      if (node.type === 'heading') {
        if (this.enterHeading(node, nodeScopes)) {
          this.afterHeading = true;
        // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, mapping an empty list pushes nothing
        } else if (nodeScopes.length > 0) {
          // an empty heading is not a block; keep the directive for the next real block
          pending.push(...nodeScopes.map((set) => ({ set, range: rangeOf(node) })));
        }
        continue;
      }
      const before = this.chunks.length;
      this.walkBlock(node, { parentId: undefined, extra: nodeScopes });
      if (this.chunks.length > before) this.afterHeading = false;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, mapping an empty list pushes nothing
      else if (nodeScopes.length > 0) pending.push(...nodeScopes.map((set) => ({ set, range: rangeOf(node) })));
    }
    this.reportOrphans(pending);
  }

  // ───────────────────────── directives

  /** Scopes of the block-level `ai-bdd` comments inside an html node. */
  private readDirectives(node: MdNode): Pending[] {
    const out: Pending[] = [];
    const range = rangeOf(node);
    // Stryker disable next-line StringLiteral: equivalent mutant, an html node always has a string value
    for (const comment of findComments(node.value ?? '')) {
      const text = directiveBody(comment.body);
      if (text === null) continue;
      if (!comment.terminated) {
        this.diag('DIRECTIVE_INVALID', 'unterminated directive comment (missing "-->")', range);
        continue;
      }
      const set = parseDirectiveText(text, (code, message, details) => this.diag(code, message, range, details));
      out.push({ set, range });
    }
    return out;
  }

  /** Take the pending directives that apply to `node`. Non-chunk blocks leave them pending. */
  private consume(pending: Pending[], node: MdNode): DirectiveSet[] {
    // Stryker disable next-line ConditionalExpression: equivalent mutant, with nothing pending consume returns an empty list either way
    if (pending.length === 0 || !yieldsChunks(node)) return [];
    const sets = pending.map((p) => p.set);
    pending.length = 0;
    return sets;
  }

  private reportOrphans(pending: readonly Pending[]): void {
    for (const p of pending) this.diag('DIRECTIVE_INVALID', 'directive is not followed by a block it can apply to', p.range);
  }

  private inlineHtmlWarning(range: SourceRange): (value: string) => void {
    return (value) => {
      for (const c of findComments(value)) {
        if (directiveBody(c.body) !== null) {
          this.diag('DIRECTIVE_INVALID', 'directive must be a block-level comment on its own line; ignored here', range);
        }
      }
    };
  }

  // ───────────────────────── headings and ids

  private pathAnchor(): string {
    return this.stack.length === 0 ? '_preamble' : this.stack.map((e) => e.slug).join('/');
  }

  private enterHeading(node: MdNode, nodeScopes: DirectiveSet[]): boolean {
    const range = rangeOf(node);
    const text = normalizeText(inlineText(node, this.inlineHtmlWarning(range)));
    if (text === '') return false;
    const level = node.depth ?? 1;
    while (this.stack.length > 0 && (this.stack[this.stack.length - 1] as HeadingEntry).level >= level) this.stack.pop();
    const parentKey = this.pathAnchor();
    let used = this.usedSlugs.get(parentKey);
    if (used === undefined) {
      used = new Set<string>();
      this.usedSlugs.set(parentKey, used);
    }
    const base = slugify(text);
    const countKey = `${parentKey}\u0000${base}`;
    let n = this.slugCounts.get(countKey) ?? 0;
    let slug = base;
    if (n > 0) slug = `${base}-${n + 1}`;
    while (used.has(slug)) {
      n++;
      slug = `${base}-${n + 1}`;
    }
    this.slugCounts.set(countKey, n + 1);
    used.add(slug);
    this.stack.push({ level, slug, text, scope: emptyDirectiveSet() });
    if (level === 1 && this.title === undefined) this.title = text;
    const pathAnchor = this.pathAnchor();
    this.push({
      kind: 'heading',
      anchor: `${pathAnchor}/h`,
      pathAnchor,
      text,
      range,
      parentId: undefined,
      extra: nodeScopes,
      level,
    });
    return true;
  }

  private push(c: {
    kind: ChunkKind;
    anchor: string;
    pathAnchor: string;
    text: string;
    range: SourceRange;
    parentId: string | undefined;
    extra: DirectiveSet[];
    level?: number;
  }): string {
    const chunk: RawChunk = {
      id: `${this.docUri}#${c.anchor}`,
      anchor: c.anchor,
      pathAnchor: c.pathAnchor,
      kind: c.kind,
      headingPath: this.stack.map((e) => e.text),
      text: c.text,
      range: c.range,
      scopes: [this.base, ...this.stack.map((e) => e.scope), ...c.extra],
    };
    if (c.parentId !== undefined) chunk.parentId = c.parentId;
    if (c.level !== undefined) chunk.level = c.level;
    this.chunks.push(chunk);
    return chunk.id;
  }

  /** Emit a leaf chunk with the next ordinal under the nearest heading. Empty text is dropped. */
  private emit(kind: ChunkKind, rawText: string, range: SourceRange, ctx: Ctx, extraEnd?: DirectiveSet[]): string | undefined {
    const text = normalizeText(rawText);
    if (text === '') return undefined;
    const pathAnchor = this.pathAnchor();
    const key = `${pathAnchor}\u0000${kind}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return this.push({
      kind,
      anchor: `${pathAnchor}/${ABBR[kind]}${n}`,
      pathAnchor,
      text,
      range,
      parentId: ctx.parentId,
      extra: extraEnd === undefined ? ctx.extra : [...ctx.extra, ...extraEnd],
    });
  }

  // ───────────────────────── blocks

  private walkBlock(node: MdNode, ctx: Ctx): void {
    const range = rangeOf(node);
    switch (node.type) {
      case 'paragraph':
      // Stryker disable next-line StringLiteral: equivalent mutant, headings are handled before walkBlock and nested headings are paragraphs of list items, so this label is never reached
      case 'heading': // headings below the top level (inside list items) read as paragraphs
        this.emit('paragraph', inlineText(node, this.inlineHtmlWarning(range)), range, ctx);
        return;
      case 'code':
        // Stryker disable next-line StringLiteral: equivalent mutant, a code node always has a string value
        this.emit('code', node.value ?? '', range, ctx);
        return;
      case 'blockquote': {
        const own: DirectiveSet[] = [];
        const text = flattenBlocks(node, (html) => {
          for (const d of this.readDirectives(html)) own.push(d.set);
        });
        this.emit('blockquote', text, range, ctx, own);
        return;
      }
      case 'list':
        for (const item of node.children ?? []) this.walkListItem(item, ctx);
        return;
      case 'table':
        this.walkTable(node, ctx);
        return;
      // Stryker disable next-line ConditionalExpression: equivalent mutant, the default clause is the last one and only returns
      default:
        return;
    }
  }

  private walkTable(node: MdNode, ctx: Ctx): void {
    const rows = node.children ?? [];
    const header = (rows[0]?.children ?? []).map((c) => normalizeText(inlineText(c)));
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] as MdNode;
      const cells = (row.children ?? []).map((c) => normalizeText(inlineText(c)));
      if (cells.every((c) => c === '')) continue;
      const parts = cells.map((cell, i) => {
        const h = header[i];
        return h === undefined || h === '' ? cell : `${h}: ${cell}`;
      });
      this.emit('tableRow', parts.join('; '), rangeOf(row), ctx);
    }
  }

  private walkListItem(item: MdNode, ctx: Ctx): void {
    const pending: Pending[] = [];
    const itemScopes: DirectiveSet[] = [];
    const own: MdNode[] = [];
    const deferred: { node: MdNode; extra: DirectiveSet[] }[] = [];
    for (const child of item.children ?? []) {
      if (child.type === 'html') {
        pending.push(...this.readDirectives(child));
        continue;
      }
      const isOwn = child.type === 'paragraph' || child.type === 'heading';
      const taken = this.consume(pending, child);
      if (isOwn) {
        own.push(child);
        itemScopes.push(...taken);
      } else {
        deferred.push({ node: child, extra: taken });
      }
    }
    this.reportOrphans(pending);

    let parentId = ctx.parentId;
    if (own.length > 0) {
      const last = own[own.length - 1] as MdNode;
      const itemRange = rangeOf(item);
      const lastRange = rangeOf(last);
      const range: SourceRange = {
        startLine: itemRange.startLine,
        startColumn: itemRange.startColumn,
        endLine: lastRange.endLine,
        endColumn: lastRange.endColumn,
      };
      const text = own.map((n) => inlineText(n, this.inlineHtmlWarning(rangeOf(n)))).join(' ');
      const id = this.emit('listItem', text, range, ctx, itemScopes);
      if (id !== undefined) parentId = id;
    }
    for (const d of deferred) this.walkBlock(d.node, { parentId, extra: [...ctx.extra, ...d.extra] });
  }
}

/** Does this block produce chunks (so that a pending directive can bind to it)? */
function yieldsChunks(node: MdNode): boolean {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'code':
    case 'blockquote':
    case 'list':
    case 'table':
      return true;
    default:
      return false;
  }
}
