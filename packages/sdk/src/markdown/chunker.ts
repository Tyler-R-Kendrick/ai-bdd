import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import type {
  Chunk,
  ChunkedDoc,
  Chunker,
  ChunkOptions,
  CreateChunker,
  Diagnostic,
  ErrorCode,
  JsonValue,
  SourceDoc,
  SourceRange,
} from '../contracts/index.ts';
import { sha256Hex } from '../util/index.ts';
import {
  emptyDirectiveSet,
  parseFrontmatterDirectives,
  resolveDirectives,
  type DirectiveReport,
  type DirectiveSet,
} from './directives.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { limitNesting, MAX_CONTAINER_DEPTH, MAX_DOC_CHARS, neutralizeHostile, normalizeDocText, restorePlaceholders } from './normalize.ts';
import { buildSections, type Member } from './sections.ts';
import type { MdNode } from './text.ts';
import { rangeOf, Walker } from './walker.ts';

/** Total characters of `context` chunks offered to every section (spec 6.4). */
export const CONTEXT_CHAR_BUDGET = 4000;

const DEFAULT_SECTION_DEPTH = 2;
const DEFAULT_MAX_SECTION_CHARS = 12000;

function sanitize(opts: ChunkOptions): ChunkOptions {
  const depth = Number.isFinite(opts.sectionDepth) ? Math.max(0, Math.floor(opts.sectionDepth)) : DEFAULT_SECTION_DEPTH;
  const max = Number.isFinite(opts.maxSectionChars) && opts.maxSectionChars > 0 ? Math.floor(opts.maxSectionChars) : DEFAULT_MAX_SECTION_CHARS;
  return { sectionDepth: depth, maxSectionChars: max };
}

function parseTree(text: string): MdNode {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
  }) as unknown as MdNode;
}

function emptyDoc(doc: SourceDoc, diagnostics: Diagnostic[]): ChunkedDoc {
  return { doc: { uri: doc.uri, sha256: doc.sha256, title: doc.uri }, chunks: [], sections: [], contextChunkIds: [], diagnostics };
}

function chunkDocument(doc: SourceDoc, rawOpts: ChunkOptions): ChunkedDoc {
  const opts = sanitize(rawOpts);
  const raw = typeof doc.text === 'string' ? doc.text : '';
  if (raw.length > MAX_DOC_CHARS) {
    return emptyDoc(doc, [
      {
        code: 'DOC_READ_FAILED',
        severity: 'error',
        message: `document is ${raw.length} characters; the limit is ${MAX_DOC_CHARS}. Split it into smaller documents`,
        uri: doc.uri,
        details: { characters: raw.length, limit: MAX_DOC_CHARS },
      },
    ]);
  }
  const limited = limitNesting(normalizeDocText(raw));
  const neutral = neutralizeHostile(limited.text);
  if (neutral.exhausted) throw new Error('document uses every private-use character and exceeds the inline budgets');
  const text = neutral.text;
  const diagnostics: Diagnostic[] = [];
  const diag = (code: ErrorCode, message: string, range?: SourceRange, details?: JsonValue): void => {
    const d: Diagnostic = { code, severity: 'warning', message, uri: doc.uri };
    if (range !== undefined) d.range = range;
    if (details !== undefined) d.details = details;
    diagnostics.push(d);
  };

  for (const line of limited.blanked) {
    diag('DOC_READ_FAILED', `line nests block quotes or lists more than ${MAX_CONTAINER_DEPTH} levels deep and was skipped`, {
      startLine: line,
      startColumn: 1,
      endLine: line,
      endColumn: 1,
    });
  }

  if (neutral.delimiters > 0) {
    diag('DOC_READ_FAILED', `${neutral.delimiters} inline delimiter(s) beyond the per-paragraph budget are treated as literal text`);
  }
  const firstIndented = neutral.indented[0];
  if (firstIndented !== undefined) {
    diag(
      'DOC_READ_FAILED',
      `${neutral.indented.length} line(s) are indented beyond the supported depth; their extra leading whitespace is treated as text (first at line ${firstIndented})`,
      { startLine: firstIndented, startColumn: 1, endLine: firstIndented, endColumn: 1 },
    );
  }

  const tree = parseTree(text);
  restorePlaceholders(tree, neutral.restore);
  const children = tree.children ?? [];

  // frontmatter
  let frontmatterValue: JsonValue | undefined;
  let base: DirectiveSet = emptyDirectiveSet();
  const yamlNode = children.find((n) => n.type === 'yaml');
  if (yamlNode !== undefined) {
    const range = rangeOf(yamlNode);
    const parsed = parseFrontmatter(yamlNode.value ?? '');
    if (!parsed.ok) {
      diag('DOC_READ_FAILED', `frontmatter is not valid YAML and was ignored: ${parsed.error}`, range);
    } else {
      if (parsed.value !== null) frontmatterValue = parsed.value;
      const value = parsed.value;
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'ai-bdd')) {
        const report: DirectiveReport = (code, message, details) => diag(code, message, range, details);
        base = parseFrontmatterDirectives(value['ai-bdd'] as JsonValue, report);
      }
    }
  }

  const walker = new Walker(doc.uri, base);
  walker.walkRoot(children);
  diagnostics.push(...walker.diagnostics);

  // resolve directives (heading scopes are final now)
  const members: Member[] = walker.chunks.map((raw) => {
    const chunk: Chunk = {
      id: raw.id,
      docUri: doc.uri,
      anchor: raw.anchor,
      kind: raw.kind,
      headingPath: raw.headingPath,
      sectionId: '',
      text: raw.text,
      hash: sha256Hex(raw.text),
      range: raw.range,
      directives: resolveDirectives(raw.scopes),
    };
    if (raw.parentId !== undefined) chunk.parentId = raw.parentId;
    const m: Member = { chunk, pathAnchor: raw.pathAnchor };
    if (raw.level !== undefined) m.level = raw.level;
    return m;
  });

  // a dropped parent (empty item) never leaves a dangling parentId: parents are emitted only when they exist.
  const sections = buildSections(doc.uri, members, opts, diagnostics);

  // context chunks, in document order, within the character budget
  const contextChunkIds: string[] = [];
  let budget = CONTEXT_CHAR_BUDGET;
  let omitted = 0;
  for (const { chunk } of members) {
    if (chunk.directives.context !== true || chunk.directives.ignore === true) continue;
    if (omitted === 0 && chunk.text.length <= budget) {
      contextChunkIds.push(chunk.id);
      budget -= chunk.text.length;
    } else {
      omitted++;
    }
  }
  if (omitted > 0) {
    diag('DIRECTIVE_INVALID', `context chunks exceed the ${CONTEXT_CHAR_BUDGET} character budget; ${omitted} later chunk(s) are not offered as context`, undefined, {
      omitted,
      budget: CONTEXT_CHAR_BUDGET,
    });
  }

  const out: ChunkedDoc = {
    doc: { uri: doc.uri, sha256: doc.sha256, title: walker.title ?? doc.uri },
    chunks: members.map((m) => m.chunk),
    sections,
    contextChunkIds,
    diagnostics,
  };
  if (frontmatterValue !== undefined) out.doc.frontmatter = frontmatterValue;
  return out;
}

/** Spec 6: parse a markdown document into chunks and extraction sections. Never throws. */
export const createChunker: CreateChunker = (): Chunker => ({
  chunk(doc: SourceDoc, opts: ChunkOptions): ChunkedDoc {
    try {
      return chunkDocument(doc, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return emptyDoc(doc, [
        { code: 'DOC_READ_FAILED', severity: 'error', message: `could not parse document: ${message}`, uri: doc.uri },
      ]);
    }
  },
});
