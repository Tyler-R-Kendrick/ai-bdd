import { sha256Hex } from '../util/index.ts';

/**
 * Input normalization shared by discovery and the chunker (spec 6.1): strip one
 * leading UTF-8 BOM and convert `\r\n` / `\r` line endings to `\n`.
 * Lines and columns are identical before and after this step (V9).
 */
export function normalizeDocText(raw: string): string {
  let s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
  return s;
}

/** Document digest that does not change with BOM or line-ending style. */
export function docSha256(raw: string): string {
  return sha256Hex(normalizeDocText(raw));
}
