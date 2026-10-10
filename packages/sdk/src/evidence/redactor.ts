import { AiBddError, type CreateRedactor, type JsonValue } from '../contracts/index.ts';

export const MIN_SECRET_LENGTH = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lone surrogates become U+FFFD, as UTF-8 encoding would make them (`encodeURIComponent` throws on them). */
function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** Every textual form in which a secret value may surface (raw, URL-encoded, base64, JSON-escaped). */
function variantsOf(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    if (s.length > 0) out.add(s);
  };
  add(value);
  const uri = encodeURIComponent(wellFormed(value));
  add(uri);
  add(uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  add(uri.replace(/%20/g, '+'));
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  add(b64);
  add(b64.replace(/=+$/, ''));
  add(Buffer.from(value, 'utf8').toString('base64url'));
  add(JSON.stringify(value).slice(1, -1));
  return [...out];
}

/**
 * Secret redactor (R-SE1). Each secret value, its encodeURIComponent form and its base64 form are replaced by
 * `<secret:name>`, longest candidates first, in a single pass so placeholders are never re-scanned.
 * Values shorter than 4 characters are rejected with SECRET_TOO_SHORT (the value is never put in the error).
 */
export const createRedactor: CreateRedactor = (secrets) => {
  const names = Object.keys(secrets).sort();
  const byVariant = new Map<string, string>();
  for (const name of names) {
    const value = secrets[name];
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) {
      throw new AiBddError('SECRET_TOO_SHORT', `secret "${name}" must be at least ${MIN_SECRET_LENGTH} characters long`, { details: { name } });
    }
    for (const v of variantsOf(value)) {
      if (!byVariant.has(v)) byVariant.set(v, name);
    }
  }
  const ordered = [...byVariant.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const pattern = ordered.length === 0 ? undefined : new RegExp(ordered.map(escapeRegExp).join('|'), 'g');

  const redact = (text: string): string => {
    if (pattern === undefined || text.length === 0) return text;
    return text.replace(pattern, (m) => `<secret:${byVariant.get(m) ?? 'unknown'}>`);
  };

  const mapJson = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(mapJson);
    if (value !== null && typeof value === 'object') {
      const entries: [string, JsonValue][] = [];
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) entries.push([redact(k), mapJson(v)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  };

  return {
    redact,
    redactJson: <T extends JsonValue>(value: T): T => mapJson(value) as T,
    secretNames: names,
  };
};
