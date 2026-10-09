/**
 * Step parameter resolution (P6).
 *
 *  - `"static"` is a quoted literal and needs no resolution.
 *  - `<name>` is dynamic and is resolved from the data-table row (or a concept
 *    parameter, handled during concept expansion).
 *  - `<file:rel/path>` is read relative to the spec file, limited to the
 *    project root (POLICY_DENIED otherwise).
 *  - `<table:rel/path.csv>` becomes a step table argument.
 *  - `<secret:name>` stays opaque and is filled by the driver (R-K15).
 */
import { csvToTable, parseCsv } from './text.js';
import type { DataTable, Diagnostic, JsonValue, SourceLocation, StepArg } from '@ai-bdd/contracts';

export interface ParamContext {
  projectRoot: string;
  readFile?: (path: string) => string;
  dataHeader?: string[];
  dataRow?: string[];
  /** Diagnostics already reported, keyed by code/location/message (dedupe). */
  reported: Set<string>;
}

export interface ResolvedParams {
  text: string;
  args: StepArg[];
  diagnostics: Diagnostic[];
}

const SPECIAL_PARAM = /<\s*(file|table|secret)\s*:\s*([^<>]+?)\s*>/giu;
const DYNAMIC_PARAM = /<\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*>/gu;

/** Resolve `rel` against `root`, returning null when it escapes the root. */
export function safeResolve(root: string, rel: string): string | null {
  const normalizedRel = rel.replace(/\\/gu, '/');
  if (normalizedRel.startsWith('/') || /^[A-Za-z]:/u.test(normalizedRel)) return null;
  const absolute = root.startsWith('/');
  const rootSegments = root.replace(/\\/gu, '/').split('/').filter((part) => part !== '' && part !== '.');
  const segments = [...rootSegments];
  for (const part of normalizedRel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length <= rootSegments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

function report(
  ctx: ParamContext,
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  location: SourceLocation,
  details?: JsonValue,
): void {
  const key = `${code}|${location.line}|${location.column}|${message}`;
  if (ctx.reported.has(key)) return;
  ctx.reported.add(key);
  diagnostics.push({
    code,
    severity: 'error',
    message,
    location,
    ...(details === undefined ? {} : { details }),
  });
}

function readRelative(
  ctx: ParamContext,
  relative: string,
  location: SourceLocation,
  diagnostics: Diagnostic[],
): string | null {
  const resolved = safeResolve(ctx.projectRoot, relative);
  if (resolved === null) {
    report(ctx, diagnostics, 'POLICY_DENIED', `Path "${relative}" escapes the project root.`, location, {
      path: relative,
    });
    return null;
  }
  if (ctx.readFile === undefined) return null;
  try {
    return ctx.readFile(resolved);
  } catch {
    report(ctx, diagnostics, 'GAUGE_UNRESOLVED_PARAM', `Could not read "${relative}".`, location, {
      path: relative,
    });
    return null;
  }
}

/** Resolve the special and dynamic parameters of one step. */
export function resolveStepParams(
  text: string,
  args: StepArg[],
  location: SourceLocation,
  ctx: ParamContext,
): ResolvedParams {
  const diagnostics: Diagnostic[] = [];
  const extra: StepArg[] = [];

  for (const match of text.matchAll(SPECIAL_PARAM)) {
    const kind = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (value.length === 0) continue;
    if (kind === 'secret') {
      extra.push({ type: 'secret', name: value, location });
      continue;
    }
    const content = readRelative(ctx, value, location, diagnostics);
    if (kind === 'file') {
      extra.push({ type: 'file', path: value, content: content ?? '', location });
      continue;
    }
    const table = content === null ? null : csvToTable(parseCsv(content));
    if (table === null) {
      if (ctx.readFile === undefined) continue;
      report(ctx, diagnostics, 'GAUGE_UNRESOLVED_PARAM', `Could not read table "${value}".`, location, {
        path: value,
      });
      continue;
    }
    extra.push({ type: 'table', table, location });
  }

  const resolvedText = text.replace(DYNAMIC_PARAM, (whole, name: string) => {
    if (ctx.dataHeader !== undefined && ctx.dataRow !== undefined) {
      const index = ctx.dataHeader.indexOf(name);
      if (index >= 0) return ctx.dataRow[index] ?? '';
    }
    report(ctx, diagnostics, 'GAUGE_UNRESOLVED_PARAM', `Dynamic parameter <${name}> could not be resolved.`, location, {
      parameter: name,
    });
    return whole;
  });

  return { text: resolvedText, args: [...args, ...extra], diagnostics };
}

/** Load an external `table: rel/path.csv` data table (P7). */
export function loadExternalTable(
  relative: string,
  location: SourceLocation,
  ctx: ParamContext,
): { table: DataTable | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const content = readRelative(ctx, relative, location, diagnostics);
  if (content === null) return { table: null, diagnostics };
  const table = csvToTable(parseCsv(content));
  if (table === null) {
    report(ctx, diagnostics, 'GAUGE_UNRESOLVED_PARAM', `External table "${relative}" is empty.`, location, {
      path: relative,
    });
  }
  return { table, diagnostics };
}
