import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JsonValue, ObservedNode, Policy, Sha256 } from '../contracts/index.ts';

export function sha256Hex(data: string | Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 8785 (JCS) canonical JSON for JSON-compatible values. Keys with undefined values are omitted. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as { [k: string]: JsonValue | undefined };
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as JsonValue)}`).join(',')}}`;
}

function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as { [k: string]: JsonValue | undefined };
    const out: { [k: string]: JsonValue } = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (v !== undefined) out[k] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** Diff-friendly deterministic JSON: sorted keys, 2-space indent, LF, trailing newline. */
export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Normalization used for quote grounding, fingerprints and step keys. */
export function normalizeForQuote(s: string): string {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u2026/g, '...');
}

export function slugify(input: string, max = 64): string {
  const s = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : `h-${sha256Hex(input).slice(0, 8)}`;
}

/** Canonical one-line-per-node rendering used for prompts and tree hashes. */
export function renderTree(nodes: readonly ObservedNode[], opts: { refs: boolean }): string {
  return nodes
    .map((n) => {
      const parts: string[] = [`${'  '.repeat(n.depth)}- ${n.role}`];
      if (n.name) parts.push(JSON.stringify(n.name));
      if (n.level !== undefined) parts.push(`[level=${n.level}]`);
      const states = Object.entries(n.states)
        .filter(([, v]) => v !== undefined && v !== false)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => (v === true ? `[${k}]` : `[${k}=${String(v)}]`));
      parts.push(...states);
      if (n.value !== undefined) parts.push(`value=${JSON.stringify(n.value)}`);
      if (n.text !== undefined && n.text !== n.name) parts.push(`text=${JSON.stringify(n.text)}`);
      if (n.testId !== undefined) parts.push(`[testid=${JSON.stringify(n.testId)}]`);
      if (n.url !== undefined) parts.push(`[url=${JSON.stringify(n.url)}]`);
      if (opts.refs) parts.push(`[ref=${n.ref}]`);
      return parts.join(' ');
    })
    .join('\n');
}

export function treeHash(nodes: readonly ObservedNode[]): Sha256 {
  return sha256Hex(renderTree(nodes, { refs: false }));
}

export type NavigationCheck = { ok: true; url: string } | { ok: false; reason: string };

export function checkNavigation(rawUrl: string, baseURL: string | undefined, policy: Policy): NavigationCheck {
  let u: URL;
  try {
    u = baseURL === undefined ? new URL(rawUrl) : new URL(rawUrl, baseURL);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `scheme ${u.protocol} not allowed` };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'credentials in URL not allowed' };
  const host = u.hostname.toLowerCase();
  const allowed = policy.allowHosts.some((h) => {
    const a = h.toLowerCase();
    return a.startsWith('*.') ? host.endsWith(a.slice(1)) : host === a;
  });
  return allowed ? { ok: true, url: u.toString() } : { ok: false, reason: `host ${host} not in allowHosts` };
}

/** RFC 9562 UUIDv7. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Write via temp file + fsync + rename. */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function toPosix(p: string): string {
  return p.split('\\').join('/');
}
