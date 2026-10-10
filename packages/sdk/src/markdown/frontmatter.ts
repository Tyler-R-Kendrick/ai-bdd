import { parse } from 'yaml';
import type { JsonValue } from '../contracts/index.ts';

const MAX_DEPTH = 64;

/** Convert an arbitrary parsed YAML value into JSON-safe data (no NaN/Infinity/Date/Map, no `__proto__`). */
export function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v, depth + 1));
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Map) {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of value) {
      const key = String(k);
      if (key !== '__proto__') out[key] = toJsonValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== '__proto__') out[k] = toJsonValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

export type FrontmatterResult = { ok: true; value: JsonValue } | { ok: false; error: string };

/** Strict YAML parse; never throws. */
export function parseFrontmatter(source: string): FrontmatterResult {
  try {
    const parsed: unknown = parse(source, { strict: true, logLevel: 'error' });
    return { ok: true, value: toJsonValue(parsed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const firstLine = message.split('\n')[0] ?? 'invalid YAML';
    return { ok: false, error: firstLine.slice(0, 300) };
  }
}
