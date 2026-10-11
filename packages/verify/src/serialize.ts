/** Turning the value under test into the bytes of a snapshot file. */

export interface Serialized { bytes: Uint8Array | undefined; text: string | undefined; extension: string }

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function normalizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return '[undefined]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  if (value instanceof Uint8Array) return `[bytes ${value.length}: ${hex(value.subarray(0, 32))}${value.length > 32 ? '...' : ''}]`;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (value instanceof Map) {
        return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), normalizeForJson(v, seen)]).sort(([a], [b]) => String(a).localeCompare(String(b))));
      }
      if (value instanceof Set) return [...value].map((v) => normalizeForJson(v, seen));
      if (Array.isArray(value)) return value.map((v) => normalizeForJson(v, seen));
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) out[key] = normalizeForJson((value as Record<string, unknown>)[key], seen);
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

/** Stable JSON: sorted keys, two-space indent, no information lost to `undefined`/`NaN`/`Map`/`Set`/`Error`/`Date`/bytes. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value, new WeakSet()), null, 2);
}

/** Strings are kept as they are (`txt`), bytes stay bytes (`bin`), everything else becomes stable JSON (`json`). */
export function serialize(value: unknown, extension?: string): Serialized {
  if (value instanceof Uint8Array) return { bytes: value, text: undefined, extension: extension ?? 'bin' };
  if (typeof value === 'string') return { bytes: undefined, text: value, extension: extension ?? 'txt' };
  return { bytes: undefined, text: stableStringify(value), extension: extension ?? 'json' };
}
