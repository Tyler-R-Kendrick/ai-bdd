// @ts-nocheck
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretForms {
  raw: string;
  urlEncoded: string;
  base64: string;
  base64Unpadded: string;
}

/** The encodings the redactor must scrub (SPEC 10.6) plus the unpadded base64 form. */
export function secretForms(secret: string): SecretForms {
  const base64 = Buffer.from(secret).toString('base64');
  return { raw: secret, urlEncoded: encodeURIComponent(secret), base64, base64Unpadded: base64.replace(/=+$/, '') };
}

export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out.sort();
}

export interface SecretHit {
  file: string;
  form: keyof SecretForms;
}

/** Byte-search every file under `roots` (files or directories) for the secret in all of its encodings. */
export function findSecret(roots: readonly string[], secret: string): SecretHit[] {
  const forms = secretForms(secret);
  const hits: SecretHit[] = [];
  const files = roots.flatMap((r) => {
    try {
      return statSync(r).isDirectory() ? walkFiles(r) : [r];
    } catch {
      return [];
    }
  });
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const [form, needle] of Object.entries(forms) as [keyof SecretForms, string][]) {
      if (needle.length >= 4 && bytes.includes(Buffer.from(needle))) hits.push({ file, form });
    }
  }
  return hits;
}

/** Same search on an in-memory value (JSON-serialized). */
export function valueContainsSecret(value: unknown, secret: string): boolean {
  const text = JSON.stringify(value) ?? '';
  return Object.values(secretForms(secret)).some((n) => n.length >= 4 && text.includes(n));
}
