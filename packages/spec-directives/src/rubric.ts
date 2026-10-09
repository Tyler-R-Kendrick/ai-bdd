/**
 * Data-table rubric directives (section 7.3).
 *
 * A step table whose header is exactly `| ai-bdd | value |` is consumed as
 * directives and removed from the step arguments.
 */
import type { DataTable, Diagnostic, SourceLocation, StepOptions } from '@ai-bdd/contracts';
import { assignOption, coerceDirective } from './options.js';

export const RUBRIC_HEADER: readonly [string, string] = ['ai-bdd', 'value'];

function isRubricHeader(header: string[]): boolean {
  return header.length === 2 && header[0]?.trim() === 'ai-bdd' && header[1]?.trim() === 'value';
}

export interface RubricTableResult {
  options: Partial<StepOptions>;
  diagnostics: Diagnostic[];
}

/** Parse a rubric table and keep the diagnostics (used by the dialect parsers). */
export function consumeRubricTableDetailed(table: DataTable, loc?: SourceLocation): RubricTableResult | null {
  if (!isRubricHeader(table.header)) return null;
  const options: Partial<StepOptions> = {};
  const diagnostics: Diagnostic[] = [];
  for (const row of table.rows) {
    const key = (row[0] ?? '').trim();
    const value = (row[1] ?? '').trim();
    if (key.length === 0) continue;
    const result = coerceDirective(key, value, loc);
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
 * Consume a rubric table. Returns null when the header is not exactly
 * `['ai-bdd', 'value']`. Invalid rows are skipped (the dialect parsers use
 * `consumeRubricTableDetailed` when they need the diagnostics).
 */
export function consumeRubricTable(table: DataTable): Partial<StepOptions> | null {
  return consumeRubricTableDetailed(table)?.options ?? null;
}
