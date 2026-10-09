import type { CheckPredicate, CheckProgram, JsonValue } from '@ai-bdd/contracts';

/** Volatile literal patterns that must not be baked into a check (R-K10). */
export const VOLATILE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'date', regex: /\b\d{4}-\d{2}-\d{2}\b/u },
  { name: 'time', regex: /\b\d{1,2}:\d{2}(:\d{2})?\b/u },
  { name: 'uuid', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu },
  { name: 'hex-id', regex: /\b[0-9a-f]{8,}\b/iu },
  { name: 'long-number', regex: /\b\d{5,}\b/u },
  { name: 'duration', regex: /\b\d+\s?(ms|s|sec|seconds|minutes)\b/iu },
];

/**
 * Rejects literals that would make a check program unstable over time, unless
 * the literal came from a step parameter (R-K10).
 */
export function lintCheckProgram(program: CheckProgram, params: Record<string, JsonValue> = {}): string[] {
  const problems: string[] = [];
  const paramValues = new Set(Object.values(params).map((value) => String(value)));
  for (const predicate of program.predicates) {
    for (const literal of literalsOf(predicate)) {
      if (paramValues.has(literal)) continue;
      const volatile = VOLATILE_PATTERNS.find((pattern) => pattern.regex.test(literal));
      if (volatile) problems.push(`predicate ${predicate.kind} embeds a volatile ${volatile.name}: ${literal}`);
    }
  }
  if (program.predicates.length === 0) problems.push('the check program has no predicates');
  return problems;
}

function literalsOf(predicate: CheckPredicate): string[] {
  switch (predicate.kind) {
    case 'textEquals':
    case 'textContains':
      return predicate.fromParam !== undefined ? [] : [predicate.value];
    case 'textMatches':
      return [predicate.regex];
    case 'routeMatches':
      return [predicate.regex];
    case 'count':
      return String(predicate.value).length >= 5 ? [String(predicate.value)] : [];
    default:
      return [];
  }
}
