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

const EVIDENCE_KINDS = new Set([
  'screenshot', 'observation', 'act-transcript', 'action-log', 'judge-request', 'judge-response',
  'checkgen', 'extract-request', 'extract-response', 'report', 'test-report', 'formal-proof', 'log',
]);

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Validate the feature-level obligations of a v2 report: tests, required evidence and manifest membership. */
function verifyFeatureReport(report: unknown, manifest: { runId: string; artifacts: ManifestArtifact[] }): string[] {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return ['report.json is not an object'];
  const r = report as Record<string, unknown>;
  if (r['schemaVersion'] !== 2) return [];
  const features = r['features'];
  if (!Array.isArray(features)) return ['report.json schemaVersion 2 has no features array'];
  const problems: string[] = [];
  const reported = new Set<string>();
  const artifacts = new Set(manifest.artifacts.map((artifact) => `${artifact.kind}\0${artifact.sha256}`));
  for (const value of features) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push('feature result is not an object');
      continue;
    }
    const f = value as Record<string, unknown>;
    const id = typeof f['featureId'] === 'string' ? f['featureId'] : '(unknown)';
    if (typeof f['featureId'] === 'string') reported.add(f['featureId']);
    if (f['selected'] !== true) continue;
    if (!Array.isArray(f['tests']) || f['tests'].length === 0) problems.push(`feature ${id}: TEST_REQUIRED (no associated test result)`);
    if (!stringArray(f['requiredEvidence'])) {
      problems.push(`feature ${id}: requiredEvidence is not a string array`);
      continue;
    }
    const evidence = Array.isArray(f['evidence']) ? f['evidence'] : [];
    const kinds = new Set<string>();
    for (const raw of evidence) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        problems.push(`feature ${id}: malformed evidence reference`);
        continue;
      }
      const ref = raw as Record<string, unknown>;
      if (typeof ref['kind'] !== 'string' || !EVIDENCE_KINDS.has(ref['kind']) || typeof ref['sha256'] !== 'string') {
        problems.push(`feature ${id}: malformed evidence reference`);
        continue;
      }
      if (f['runId'] !== manifest.runId || !artifacts.has(`${ref['kind']}\0${ref['sha256']}`)) {
        problems.push(`feature ${id}: evidence ${ref['kind']} ${ref['sha256']} is not in this run's manifest`);
      } else {
        kinds.add(ref['kind']);
      }
    }
    for (const kind of f['requiredEvidence']) {
      if (!kinds.has(kind)) problems.push(`feature ${id}: EVIDENCE_REQUIRED (${kind})`);
    }
    if (f['formalVerificationRequired'] === true && !kinds.has('formal-proof')) problems.push(`feature ${id}: FORMAL_VERIFICATION_REQUIRED`);
  }
  const scenarios = Array.isArray(r['scenarios']) ? r['scenarios'] : [];
  for (const scenario of scenarios) {
    if (scenario === null || typeof scenario !== 'object') continue;
    const featureId = (scenario as Record<string, unknown>)['featureId'];
    if (typeof featureId === 'string' && !reported.has(featureId)) problems.push(`feature ${featureId}: missing from report features`);
  }
  return problems;
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
  try {
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as unknown;
    problems.push(...verifyFeatureReport(report, manifest));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`report.json cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: problems.length === 0, problems };
};
