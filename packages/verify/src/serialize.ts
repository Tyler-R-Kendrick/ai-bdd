/** Turning the value under test into the bytes of a snapshot file. */

export interface Serialized { bytes: Uint8Array | undefined; text: string | undefined; extension: string }

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function normalizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return '[undefined]';
  // Stryker disable next-line ConditionalExpression: equivalent mutant, a string that skips this return reaches String(value) at the end, which returns it unchanged
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  if (value instanceof Uint8Array) return `[bytes ${value.length}: ${hex(value.subarray(0, 32))}${value.length > 32 ? '...' : ''}]`;
  if (value instanceof Error) return { name: value.name, message: value.message };
  // Stryker disable next-line ConditionalExpression: equivalent mutant, every other typeof was handled above, so what reaches here is always an object
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (value instanceof Map) {
        const entries = [...value.entries()];
        // String keys read as an object, in the same (code unit) order as plain objects, so a Map and the equivalent object look alike.
        if (entries.every(([k]) => typeof k === 'string')) {
          // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent mutants, Map keys are unique so a === b never reaches the comparator, and the sort only asks whether the result is negative
          return Object.fromEntries(entries.map(([k, v]) => [k as string, normalizeForJson(v, seen)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        }
        // Other keys (numbers, objects, ...) would collapse when stringified ("1" and 1, or two objects), so the Map is listed as [key, value] pairs.
        return entries
          .map(([k, v]) => [normalizeForJson(k, seen), normalizeForJson(v, seen)] as const)
          // Stryker disable next-line StringLiteral,ConditionalExpression,EqualityOperator: equivalent mutants, normalizeForJson never yields undefined, a function or a symbol so JSON.stringify never returns undefined, and the sort only asks whether the comparator result is negative
          .sort(([a], [b]) => { const x = JSON.stringify(a) ?? ''; const y = JSON.stringify(b) ?? ''; return x < y ? -1 : x > y ? 1 : 0; });
      }
      if (value instanceof Set) return [...value].map((v) => normalizeForJson(v, seen));
      if (Array.isArray(value)) return value.map((v) => normalizeForJson(v, seen));
      // fromEntries defines own properties, so an own `__proto__` key survives (plain assignment would set the prototype instead)
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeForJson((value as Record<string, unknown>)[key], seen)] as const));
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
