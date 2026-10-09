/**
 * Low level text helpers for the Gauge markdown dialect (section 4.3).
 */
import type { DataTable, SourceLocation } from '@ai-bdd/contracts';

export interface Line {
  /** 1-based line number on the original text (P1). */
  number: number;
  /** The raw line without its terminator. */
  raw: string;
  /** `raw` with surrounding whitespace removed, used for structural detection. */
  text: string;
  /** 1-based column of the first non-whitespace character. */
  column: number;
}

const BOM = '\uFEFF';

/** P1: strip a leading UTF-8 BOM. */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** P1: split on \r\n, \n and \r and keep 1-based line numbers. */
export function splitLines(text: string): Line[] {
  const body = stripBom(text);
  const raw = body.split(/\r\n|\r|\n/u);
  return raw.map((value, index) => {
    const trimmedStart = value.trimStart();
    const indent = value.length - trimmedStart.length;
    return {
      number: index + 1,
      raw: value,
      text: value.trim(),
      column: indent + 1,
    };
  });
}

export function location(uri: string, line: Line, endColumn?: number): SourceLocation {
  return endColumn === undefined
    ? { uri, line: line.number, column: line.column }
    : { uri, line: line.number, column: line.column, endColumn };
}

export const RE_SPEC_H1 = /^#(?!#)/u;
export const RE_SCENARIO_H2 = /^##(?!#)/u;
export const RE_STEP = /^\*(?!\*)/u;
export const RE_TAGS = /^tags\s*:/iu;
export const RE_TEARDOWN = /^_{3,}$/u;
export const RE_FENCE = /^(?:`{3,}|~{3,})/u;
export const RE_EXTERNAL_TABLE = /^table\s*:\s*(.+)$/iu;
export const RE_UNDERLINE_EQ = /^=+\s*$/u;
export const RE_UNDERLINE_DASH = /^-+\s*$/u;
export const RE_DOCSTRING = /^"""/u;

export const isSpecHeading = (text: string): boolean => RE_SPEC_H1.test(text);
export const isScenarioHeading = (text: string): boolean => RE_SCENARIO_H2.test(text);
export const isStep = (text: string): boolean => RE_STEP.test(text);
export const isTeardown = (text: string): boolean => RE_TEARDOWN.test(text);
export const isFence = (text: string): boolean => RE_FENCE.test(text);
export const isTagsLine = (text: string): boolean => RE_TAGS.test(text);
export const isDocString = (text: string): boolean => RE_DOCSTRING.test(text);
export const isUnderlineEq = (text: string): boolean => RE_UNDERLINE_EQ.test(text);
export const isUnderlineDash = (text: string): boolean => RE_UNDERLINE_DASH.test(text);

export function headingName(text: string, hashes: number): string {
  return text.slice(hashes).trim();
}

/** Parse a `| a | b |` row, honouring `\|` escapes. Returns null when not a row. */
export function parseTableRow(text: string): string[] | null {
  if (!text.startsWith('|') || !text.endsWith('|') || text.length < 2) return null;
  const inner = text.slice(1, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/u.test(cell));
}

export interface ParsedTable {
  table: DataTable;
  /** Index of the first line after the table. */
  next: number;
  /** 1-based line number of the last consumed row. */
  lastLine: number;
}

/** Collect consecutive markdown table rows starting at `start`. */
export function parseTableRows(lines: Line[], start: number): ParsedTable | null {
  const rows: string[][] = [];
  let index = start;
  let lastLine = lines[start]?.number ?? 0;
  while (index < lines.length) {
    const cells = parseTableRow(lines[index]?.text ?? '');
    if (cells === null) break;
    lastLine = lines[index]?.number ?? lastLine;
    if (!isSeparatorRow(cells)) rows.push(cells);
    index += 1;
  }
  if (rows.length === 0) return null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const pad = (row: string[]): string[] => {
    const copy = [...row];
    while (copy.length < width) copy.push('');
    return copy.slice(0, width);
  };
  const [header, ...body] = rows;
  return { table: { header: pad(header ?? []), rows: body.map(pad) }, next: index, lastLine };
}

/** Minimal RFC 4180 CSV reader used for `table:` and `<table:>` (P6/P7). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ''));
}

/** Convert parsed CSV rows into a DataTable (first row is the header). */
export function csvToTable(rows: string[][]): DataTable | null {
  if (rows.length === 0) return null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const pad = (row: string[]): string[] => {
    const copy = [...row];
    while (copy.length < width) copy.push('');
    return copy;
  };
  const [header, ...body] = rows;
  return { header: pad(header ?? []), rows: body.map(pad) };
}
