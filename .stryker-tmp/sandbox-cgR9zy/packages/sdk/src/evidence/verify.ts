// @ts-nocheck
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { VerifyRun } from '../contracts/index.ts';
import { sha256Hex } from '../util/index.ts';
import { ARTIFACTS_DIR, MANIFEST_FILE, isInside, manifestDigest } from './store.ts';

interface ManifestArtifact { sha256: string; path: string; kind: string; bytes: number }

const HEX64 = /^[0-9a-f]{64}$/;

function parseManifest(text: string): { runId: string; artifacts: ManifestArtifact[]; digest: string } | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `manifest.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'manifest.json is not an object';
  const m = raw as Record<string, unknown>;
  if (typeof m['runId'] !== 'string') return 'manifest.json has no runId';
  if (typeof m['digest'] !== 'string') return 'manifest.json has no digest';
  const list = m['artifacts'];
  if (!Array.isArray(list)) return 'manifest.json has no artifacts array';
  const artifacts: ManifestArtifact[] = [];
  for (const a of list as unknown[]) {
    if (a === null || typeof a !== 'object') return 'manifest.json has a malformed artifact entry';
    const e = a as Record<string, unknown>;
    if (typeof e['sha256'] !== 'string' || typeof e['path'] !== 'string' || typeof e['kind'] !== 'string' || typeof e['bytes'] !== 'number') {
      return 'manifest.json has a malformed artifact entry';
    }
    artifacts.push({ sha256: e['sha256'], path: e['path'], kind: e['kind'], bytes: e['bytes'] });
  }
  return { runId: m['runId'], artifacts, digest: m['digest'] };
}

async function listFiles(root: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * Recomputes every artifact hash and the manifest digest (R-EV1). Reports missing, extra and modified files.
 * Threat model: detects corruption and naive edits; it does NOT defend against a malicious runner host that
 * rewrites artifacts and the manifest consistently.
 * An unreadable or malformed manifest yields `ok: false` with an `EVIDENCE_CORRUPT:` problem (it does not throw).
 */
export const verifyRun: VerifyRun = async (runDir) => {
  const root = resolve(runDir);
  let text: string;
  try {
    text = await readFile(join(root, MANIFEST_FILE), 'utf8');
  } catch (err) {
    return { ok: false, problems: [`EVIDENCE_CORRUPT: cannot read ${MANIFEST_FILE} (${err instanceof Error ? err.message : String(err)})`] };
  }
  const manifest = parseManifest(text);
  if (typeof manifest === 'string') return { ok: false, problems: [`EVIDENCE_CORRUPT: ${manifest}`] };

  const problems: string[] = [];
  const digest = manifestDigest(manifest.artifacts);
  if (digest !== manifest.digest) problems.push(`digest mismatch: manifest says ${manifest.digest}, artifacts hash to ${digest}`);

  const listed = new Set<string>();
  const artifactsRoot = join(root, ARTIFACTS_DIR);
  for (const a of manifest.artifacts) {
    listed.add(a.path);
    const abs = resolve(root, a.path);
    if (a.path.includes('\\') || a.path.split('/').includes('..') || !isInside(artifactsRoot, abs) || abs === artifactsRoot) {
      problems.push(`unsafe path in manifest: ${JSON.stringify(a.path)}`);
      continue;
    }
    if (!HEX64.test(a.sha256) || !a.path.startsWith(`${ARTIFACTS_DIR}/${a.sha256}.`)) {
      problems.push(`manifest entry inconsistent: ${a.path} does not match sha256 ${a.sha256}`);
    }
    let bytes: Buffer;
    try {
      const st = await lstat(abs);
      if (!st.isFile()) {
        problems.push(`not a regular file: ${a.path}`);
        continue;
      }
      bytes = await readFile(abs);
    } catch {
      problems.push(`missing: ${a.path}`);
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== a.sha256) problems.push(`modified: ${a.path} (expected ${a.sha256}, found ${actual})`);
    else if (bytes.byteLength !== a.bytes) problems.push(`modified: ${a.path} (expected ${a.bytes} bytes, found ${bytes.byteLength})`);
  }

  for (const f of (await listFiles(root, ARTIFACTS_DIR)).sort()) {
    if (!listed.has(f)) problems.push(`extra: ${f}`);
  }
  return { ok: problems.length === 0, problems };
};
