/**
 * Directive line grammar (section 7.3).
 *
 * Gauge markdown carries directives in an HTML comment line:
 *   <!-- ai-bdd: kind=action threshold=0.85 -->
 * Gherkin carries them in a comment line:
 *   # ai-bdd: kind=action threshold=0.85
 *
 * Both use the same `key=value` assignment list, so a single grammar serves
 * both dialects (R-K18).
 */
import type { DataTable, Dialect, Diagnostic, SourceLocation, StepOptions } from '@ai-bdd/contracts';
import { assignOption, coerceDirective, parseAssignmentList } from './options.js';

export interface ParsedDirectives {
  directives: Partial<StepOptions>;
  diagnostics: Diagnostic[];
}

const GAUGE_DIRECTIVE = /^<!--\s*ai-bdd\s*:(?<body>[\s\S]*?)(?:-->|$)/u;
const GHERKIN_DIRECTIVE = /^#\s*ai-bdd\s*:(?<body>.*)$/u;

/** Extract the assignment list from a directive line, or null when not a directive. */
export function extractDirectiveBody(line: string, dialect: Dialect): string | null {
  const trimmed = line.trim();
  if (dialect === 'gauge') {
    if (!trimmed.startsWith('<!--')) return null;
    const match = GAUGE_DIRECTIVE.exec(trimmed);
    return match?.groups?.body === undefined ? null : match.groups.body;
  }
  if (!trimmed.startsWith('#')) return null;
  const match = GHERKIN_DIRECTIVE.exec(trimmed);
  return match?.groups?.body === undefined ? null : match.groups.body;
}

function applyEntries(entries: ReturnType<typeof parseAssignmentList>['entries'], loc?: SourceLocation): {
  options: Partial<StepOptions>;
  diagnostics: Diagnostic[];
} {
  const options: Partial<StepOptions> = {};
  const diagnostics: Diagnostic[] = [];
  for (const entry of entries) {
    const result = coerceDirective(entry.key, entry.value, loc);
    if (result.ok) {
      assignOption(options, result.key, result.value);
    } else {
      diagnostics.push(result.diagnostic);
    }
  }
  if (
    options.threshold !== undefined &&
    options.failThreshold !== undefined &&
    !(options.failThreshold < options.threshold)
  ) {
    diagnostics.push({
      code: 'DIRECTIVE_INVALID_VALUE',
      severity: 'error',
      message: `failThreshold (${options.failThreshold}) must be lower than threshold (${options.threshold}).`,
      ...(loc === undefined ? {} : { location: loc }),
    });
  }
  return { options, diagnostics };
}

/**
 * Parse one candidate directive line. Returns null when the line is not a
 * directive for the given dialect. Diagnostics are returned (never thrown) for
 * unknown keys, invalid values and malformed assignments.
 */
export function parseDirectives(line: string, dialect: Dialect, loc: SourceLocation): ParsedDirectives | null {
  const body = extractDirectiveBody(line, dialect);
  if (body === null) return null;
  const parsed = parseAssignmentList(body, loc);
  const applied = applyEntries(parsed.entries, loc);
  return { directives: applied.options, diagnostics: [...parsed.diagnostics, ...applied.diagnostics] };
}
