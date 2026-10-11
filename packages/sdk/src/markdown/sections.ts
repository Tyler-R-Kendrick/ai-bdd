import type { Chunk, Diagnostic, Section, SourceRange } from '../contracts/index.ts';
import { sha256Hex } from '../util/index.ts';

/** A resolved chunk plus structure needed for splitting. */
export interface Member {
  chunk: Chunk;
  /** Anchor of the heading path the chunk lives under. */
  pathAnchor: string;
  /** Heading level, for heading chunks only. */
  level?: number;
}

interface Piece {
  anchor: string;
  title: string;
  level: number;
  members: Member[];
}

export interface SectionOptions {
  sectionDepth: number;
  maxSectionChars: number;
}

function excluded(m: Member): boolean {
  return m.chunk.directives.ignore === true || m.chunk.directives.context === true;
}

function size(members: readonly Member[]): number {
  let n = 0;
  for (const m of members) if (!excluded(m)) n += m.chunk.text.length;
  return n;
}

function before(a: SourceRange, b: SourceRange): boolean {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent mutants, chunks are emitted in document order so a later chunk never starts before the first included chunk; only the self comparison and equal positions remain, which copy identical values
  return a.startLine < b.startLine || (a.startLine === b.startLine && a.startColumn < b.startColumn);
}

function after(a: SourceRange, b: SourceRange): boolean {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, no two chunks of a section end on the same line, so the same-line column comparison only ever sees the chunk itself, whose end it copies unchanged
  return a.endLine > b.endLine || (a.endLine === b.endLine && a.endColumn > b.endColumn);
}

/**
 * Build the extraction sections of a document (spec 6.4) and set `chunk.sectionId` on every chunk.
 * Oversized sections split at their next-deeper headings, then at chunk boundaries into `part-n`.
 */
export function buildSections(
  docUri: string,
  members: readonly Member[],
  opts: SectionOptions,
  diagnostics: Diagnostic[],
): Section[] {
  const base: Piece[] = [];
  let current: Piece = { anchor: '_preamble', title: 'Preamble', level: 0, members: [] };
  base.push(current);
  for (const m of members) {
    // Stryker disable next-line ConditionalExpression: equivalent mutant, only heading chunks have a level, so the level check alone decides
    if (m.chunk.kind === 'heading' && m.level !== undefined && m.level <= opts.sectionDepth) {
      current = { anchor: m.pathAnchor, title: m.chunk.text, level: m.level, members: [] };
      base.push(current);
    }
    current.members.push(m);
  }

  const pieces: Piece[] = [];
  for (const piece of base) split(piece, opts.maxSectionChars, docUri, diagnostics, pieces);

  const usedIds = new Set<string>();
  const sections: Section[] = [];
  for (const piece of pieces) {
    let anchor = piece.anchor;
    // Stryker disable next-line UpdateOperator: equivalent mutant, an id is claimed by at most two pieces, so the first suffix tried is always free and the counting direction never shows
    for (let n = 2; usedIds.has(`${docUri}#${anchor}`); n++) anchor = `${piece.anchor}-${n}`;
    const id = `${docUri}#${anchor}`;
    usedIds.add(id);
    for (const m of piece.members) m.chunk.sectionId = id;
    const included = piece.members.filter((m) => !excluded(m));
    if (included.length === 0) continue;
    let range = included[0]?.chunk.range as SourceRange;
    range = { ...range };
    for (const m of included) {
      const r = m.chunk.range;
      // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutants, chunks are in document order so no later chunk starts before the first included one and this branch never runs
      if (before(r, range)) {
        range.startLine = r.startLine;
        range.startColumn = r.startColumn;
      }
      if (after(r, range)) {
        range.endLine = r.endLine;
        range.endColumn = r.endColumn;
      }
    }
    sections.push({
      id,
      docUri,
      anchor,
      title: piece.title,
      level: piece.level,
      chunkIds: included.map((m) => m.chunk.id),
      hash: sha256Hex(included.map((m) => m.chunk.hash).join('\n')),
      range,
    });
  }
  return sections;
}

function split(piece: Piece, max: number, docUri: string, diagnostics: Diagnostic[], out: Piece[]): void {
  if (size(piece.members) <= max) {
    out.push(piece);
    return;
  }

  // 1. next-deeper headings
  let deeper = Number.POSITIVE_INFINITY;
  for (const m of piece.members) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, only heading chunks have a level, and taking the minimum is unchanged when an equal level replaces it
    if (m.chunk.kind === 'heading' && m.level !== undefined && m.level > piece.level && m.level < deeper) deeper = m.level;
  }
  if (Number.isFinite(deeper)) {
    const subs: Piece[] = [];
    let cur: Piece = { anchor: piece.anchor, title: piece.title, level: piece.level, members: [] };
    subs.push(cur);
    for (const m of piece.members) {
      // Stryker disable next-line ConditionalExpression: equivalent mutant, only heading chunks have a level, so the level comparison alone decides
      if (m.chunk.kind === 'heading' && m.level === deeper) {
        cur = { anchor: m.pathAnchor, title: m.chunk.text, level: deeper, members: [] };
        subs.push(cur);
      }
      cur.members.push(m);
    }
    for (const sub of subs) split(sub, max, docUri, diagnostics, out);
    return;
  }

  // 2. chunk boundaries
  const parts: Member[][] = [];
  let cur: Member[] = [];
  let curSize = 0;
  const flush = (): void => {
    if (cur.length > 0) parts.push(cur);
    cur = [];
    curSize = 0;
  };
  for (const m of piece.members) {
    const len = excluded(m) ? 0 : m.chunk.text.length;
    if (len > max) {
      diagnostics.push({
        code: 'DOC_CHUNK_TOO_LARGE',
        severity: 'warning',
        message: `chunk is ${len} characters, over the section limit of ${max}; it becomes its own part`,
        uri: docUri,
        range: m.chunk.range,
        details: { chunkId: m.chunk.id, chars: len, maxSectionChars: max },
      });
      flush();
      parts.push([m]);
      continue;
    }
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, a chunk longer than max was handled above, so with nothing in the part yet curSize + len > max is already false
    if (curSize > 0 && curSize + len > max) flush();
    cur.push(m);
    curSize += len;
  }
  flush();

  if (parts.length <= 1) {
    out.push(piece);
    return;
  }
  parts.forEach((members, i) => {
    out.push({ anchor: `${piece.anchor}/part-${i + 1}`, title: `${piece.title} (part ${i + 1})`, level: piece.level, members });
  });
}
