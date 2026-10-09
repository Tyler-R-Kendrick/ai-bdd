import { createHash, randomBytes } from 'node:crypto';
import type { Binding, BindingDescriptor, ParamDecl } from './bindings.js';
import type { JsonValue } from './primitives.js';

/**
 * Step text normalization (P5): NFC, trim, collapse internal whitespace to a
 * single space, strip a single trailing period. Case is preserved for display
 * and lowered only for embedding cache keys.
 */
export function normalizeStepText(text: string): string {
  const nfc = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return nfc.endsWith('.') ? nfc.slice(0, -1).trim() : nfc;
}

/** Lowercased normalization, used for embedding keys only. */
export function embeddingKey(text: string): string {
  return normalizeStepText(text).toLowerCase();
}

/** RFC 8785 (JCS) canonical JSON. */
export function canonicalJson(value: JsonValue): string {
  return writeCanonical(value);
}

function writeCanonical(value: JsonValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => writeCanonical(item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, JsonValue>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${writeCanonical(item)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** Stable JSON stringify with sorted keys at every level (JSON-compatible values only). */
export function stableStringify(value: unknown): string {
  return writeCanonical(toJsonValue(value));
}

/** Coerce arbitrary JSON-compatible values to JsonValue, dropping functions/undefined. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = toJsonValue(item);
    }
    return out;
  }
  return null;
}

export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return hash.digest('hex');
}

/** sha256 over the canonical JSON form of a value. */
export function hashJson(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}

/** 64 zeros: the prevChainHash of the first evidence record. */
export const ZERO_HASH = '0'.repeat(64);

/** UUIDv7 (time ordered), used for run ids. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
