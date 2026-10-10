// @ts-nocheck
import type { JsonObject, JsonValue } from '@ai-bdd/sdk/contracts';
import type { FakeMatcher, FakeRule } from './types.ts';

const NOT_FOUND = Symbol('not-found');

/** Resolve a dotted path (object keys and array indexes) in `root`; `undefined` when it does not resolve. */
export function resolvePath(root: JsonObject, path: string): JsonValue | undefined {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    let next: unknown = NOT_FOUND;
    if (Array.isArray(cur)) {
      if (/^(0|[1-9]\d*)$/.test(seg)) next = cur[Number(seg)] ?? NOT_FOUND;
    } else if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, seg)) {
      next = (cur as Record<string, unknown>)[seg];
    }
    if (next === NOT_FOUND || next === undefined) return undefined;
    cur = next;
  }
  return cur as JsonValue;
}

function scalarText(v: JsonValue): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
}

function contains(v: JsonValue, needle: string): boolean {
  if (typeof v === 'string') return v.includes(needle);
  if (Array.isArray(v)) return v.some((x) => scalarText(x) === needle);
  return false;
}

/** Does the value found at a path satisfy the matcher? Callers handle the unresolved case. */
export function matchValue(v: JsonValue, m: FakeMatcher): boolean {
  if (typeof m === 'string') return scalarText(v) === m;
  if ('contains' in m) return contains(v, m.contains);
  if ('notContains' in m) return !contains(v, m.notContains);
  return m.in.includes(scalarText(v) ?? '\u0000');
}

/** A rule matches when its purpose is equal and every `when` path resolves and satisfies its matcher. */
export function ruleMatches(rule: FakeRule, purpose: string, context: JsonObject): boolean {
  if (rule.purpose !== purpose) return false;
  for (const [path, matcher] of Object.entries(rule.when ?? {})) {
    const v = resolvePath(context, path);
    if (v === undefined) return false;
    if (!matchValue(v, matcher)) return false;
  }
  return true;
}
