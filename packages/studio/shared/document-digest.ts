/** Stable node bytes across SQL/Yjs and ProseMirror attribute-key insertion order. Array order remains source-significant. */
export function documentNodeSource(node: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    return value;
  };
  return JSON.stringify(canonical(node));
}
