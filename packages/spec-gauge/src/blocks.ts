/**
 * Shared block readers for Gauge markdown: steps (with their table, docstring
 * and directive attachments), tags and multiline strings.
 */
import type { Diagnostic, SourceLocation, StepArg, StepOptions, StepPhase } from '@ai-bdd/contracts';
import { consumeRubricTableDetailed, parseDirectives } from '@ai-bdd/spec-directives';
import {
  isDocString,
  location,
  parseTableRow,
  parseTableRows,
  RE_TAGS,
  type Line,
} from './text.js';

export interface RawStep {
  text: string;
  args: StepArg[];
  options: Partial<StepOptions>;
  location: SourceLocation;
  phase: StepPhase;
}

export interface StepBlock {
  raw: RawStep;
  /** Index of the first line after the block. */
  next: number;
  /** 1-based line number of the last consumed line. */
  lastLine: number;
}

export interface DocStringBlock {
  content: string;
  mediaType?: string;
  next: number;
  lastLine: number;
}

/** Read a `"""` multiline step argument (section 4.3). */
export function readDocString(lines: Line[], start: number): DocStringBlock {
  const open = lines[start]?.text ?? '"""';
  const mediaType = open.slice(3).trim();
  const content: string[] = [];
  let index = start + 1;
  let lastLine = lines[start]?.number ?? 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current === undefined) break;
    lastLine = current.number;
    index += 1;
    if (current.text.startsWith('"""')) break;
    content.push(current.raw);
  }
  return mediaType.length > 0
    ? { content: content.join('\n'), mediaType, next: index, lastLine }
    : { content: content.join('\n'), next: index, lastLine };
}

/**
 * Read a step line and its immediately following block: inline tables (which
 * may be rubric directive tables), a `"""` docstring and directive comments.
 * The block ends at a blank line or any non-argument line (P7).
 */
export function readStepBlock(
  lines: Line[],
  start: number,
  uri: string,
  phase: StepPhase,
  diagnostics: Diagnostic[],
): StepBlock {
  const line = lines[start] as Line;
  const raw: RawStep = {
    text: line.text.slice(1).trim(),
    args: [],
    options: {},
    location: location(uri, line),
    phase,
  };
  let index = start + 1;
  let lastLine = line.number;
  while (index < lines.length) {
    const current = lines[index] as Line;
    if (current.text === '') break;

    if (parseTableRow(current.text) !== null) {
      const parsed = parseTableRows(lines, index);
      if (parsed === null) break;
      const rubric = consumeRubricTableDetailed(parsed.table, location(uri, current));
      if (rubric !== null) {
        Object.assign(raw.options, rubric.options);
        diagnostics.push(...rubric.diagnostics);
      } else {
        raw.args.push({ type: 'table', table: parsed.table, location: location(uri, current) });
      }
      lastLine = parsed.lastLine;
      index = parsed.next;
      continue;
    }

    if (isDocString(current.text)) {
      const doc = readDocString(lines, index);
      raw.args.push({
        type: 'docString',
        content: doc.content,
        ...(doc.mediaType === undefined ? {} : { mediaType: doc.mediaType }),
        location: location(uri, current),
      });
      lastLine = doc.lastLine;
      index = doc.next;
      continue;
    }

    const directive = parseDirectives(current.raw, 'gauge', location(uri, current));
    if (directive !== null) {
      Object.assign(raw.options, directive.directives);
      diagnostics.push(...directive.diagnostics);
      lastLine = current.number;
      index += 1;
      continue;
    }
    break;
  }
  return { raw, next: index, lastLine };
}

export interface TagsBlock {
  tags: string[];
  next: number;
  lastLine: number;
}

/**
 * Read a `Tags:` line. A trailing comma continues the list on the next line
 * (section 4.3). Tags are stored without a leading `@` so both dialects agree.
 */
export function readTags(lines: Line[], start: number): TagsBlock {
  const tags: string[] = [];
  let index = start;
  let lastLine = lines[start]?.number ?? 0;
  const first = lines[start]?.text ?? '';
  const prefix = RE_TAGS.exec(first);
  let rest = prefix === null ? first : first.slice(prefix[0].length);
  for (;;) {
    const trailing = rest.trimEnd().endsWith(',');
    const parts = rest.split(',');
    if (trailing) parts.pop();
    for (const part of parts) {
      const value = part.trim().replace(/^@/u, '');
      if (value.length > 0) tags.push(value);
    }
    lastLine = lines[index]?.number ?? lastLine;
    index += 1;
    if (!trailing || index >= lines.length) break;
    rest = lines[index]?.text ?? '';
    if (rest === '') break;
  }
  return { tags, next: index, lastLine };
}
