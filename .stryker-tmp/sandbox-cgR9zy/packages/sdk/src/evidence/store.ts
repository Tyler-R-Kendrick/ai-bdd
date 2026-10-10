// @ts-nocheck
import { appendFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AiBddError,
  type ArtifactKind,
  type ArtifactRef,
  type CreateEvidenceStore,
  type EvidenceStore,
  type JsonObject,
  type JsonValue,
  type Redactor,
  type Sha256,
} from '../contracts/index.ts';
import { assertInsideRealRoot, atomicWriteFile, canonicalJson, sha256Hex, stableJson } from '../util/index.ts';

export const MANIFEST_FILE = 'manifest.json';
export const EVENTS_FILE = 'events.jsonl';
export const ARTIFACTS_DIR = 'artifacts';

/** True when `child` is `parent` itself or lies below it, after resolution. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertSafeRunId(runId: string): void {
  if (runId === '' || runId === '.' || runId === '..' || /[\\/\0]/.test(runId)) {
    throw new AiBddError('POLICY_DENIED', `unsafe run id: ${JSON.stringify(runId)}`);
  }
}

function compareRefs(a: ArtifactRef, b: ArtifactRef): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** Digest over the (sorted) artifact list, as stored in manifest.json. */
export function manifestDigest(artifacts: readonly { sha256: string; path: string; kind: string; bytes: number }[]): Sha256 {
  return sha256Hex(canonicalJson(artifacts.map((a) => ({ sha256: a.sha256, path: a.path, kind: a.kind, bytes: a.bytes }))));
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Content-addressed evidence store (SPEC 10.6). Text artifacts are redacted BEFORE hashing and writing.
 * Screenshots are stored byte-for-byte (pixels cannot be redacted; taint gating is the caller's job, R-SE2).
 */
export const createEvidenceStore: CreateEvidenceStore = async ({ runsDir, runId, redactor }: { runsDir: string; runId: string; redactor: Redactor }): Promise<EvidenceStore> => {
  assertSafeRunId(runId);
  const dir = resolve(runsDir, runId);
  await assertInsideRealRoot(dir); // a symlinked runs directory must not redirect evidence outside the project (F-09)
  await mkdir(join(dir, ARTIFACTS_DIR), { recursive: true });

  const refs = new Map<string, ArtifactRef>();
  let eventsChain: Promise<void> = Promise.resolve();

  const store: EvidenceStore = {
    runId,
    dir,

    async putArtifact(kind: ArtifactKind, data: Uint8Array | string): Promise<ArtifactRef> {
      let bytes: Uint8Array;
      let ext: 'png' | 'json' | 'txt';
      if (typeof data !== 'string' && kind === 'screenshot') {
        bytes = data;
        ext = 'png';
      } else {
        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const text = redactor.redact(raw);
        bytes = Buffer.from(text, 'utf8');
        ext = isJson(text) ? 'json' : 'txt';
      }
      const sha256 = sha256Hex(bytes);
      const path = `${ARTIFACTS_DIR}/${sha256}.${ext}`;
      const abs = resolve(dir, path);
      if (!isInside(join(dir, ARTIFACTS_DIR), abs)) throw new AiBddError('POLICY_DENIED', 'artifact path escapes the run directory');
      await atomicWriteFile(abs, bytes);
      const ref: ArtifactRef = { sha256, path, kind, bytes: bytes.byteLength };
      refs.set(`${path}\0${kind}`, ref);
      return { ...ref };
    },

    async record(entry: JsonObject): Promise<void> {
      const line = `${JSON.stringify(redactor.redactJson(entry as JsonValue))}\n`;
      const next = eventsChain.then(() => appendFile(join(dir, EVENTS_FILE), line, 'utf8'));
      eventsChain = next.catch(() => undefined);
      await next;
    },

    async finalize(): Promise<{ runId: string; artifacts: ArtifactRef[]; digest: Sha256 }> {
      await eventsChain;
      const artifacts = [...refs.values()].map((r) => ({ ...r })).sort(compareRefs);
      const digest = manifestDigest(artifacts);
      const manifest = { runId, artifacts, digest };
      await atomicWriteFile(join(dir, MANIFEST_FILE), stableJson(manifest as unknown as JsonValue));
      return { runId, artifacts, digest };
    },
  };
  return store;
};
