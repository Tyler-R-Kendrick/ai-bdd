/**
 * Local copy of the volatile-text patterns of SPEC §10.4. The shared, authoritative version
 * lives in `assert/volatile.ts` (owned by S-ASSERT); this one only exists so effect exclusion
 * (§10.2) does not depend on a sibling module. All patterns are linear-time.
 */
const VOLATILE_PATTERNS: readonly RegExp[] = [
  /\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/i,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b\d{5,}\b/i,
  /\b\d+\s+(second|minute|hour|day)s?\s+ago\b/i,
  /\bjust now\b/i,
];

const HEX_ID = /\b[0-9a-f]{8,}\b/gi;

export function isVolatileText(text: string): boolean {
  for (const re of VOLATILE_PATTERNS) {
    if (re.test(text)) return true;
  }
  for (const m of text.matchAll(HEX_ID)) {
    const s = m[0];
    if (/\d/.test(s) && /[a-f]/i.test(s)) return true;
  }
  return false;
}
