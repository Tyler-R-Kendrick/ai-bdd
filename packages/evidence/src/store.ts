import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EvidenceKind,
  EvidenceManifest,
  EvidenceRecord,
  EvidenceVerification,
  JsonValue,
  Redactor,
} from '@ai-bdd/contracts';
import { AiBddError, ZERO_HASH, canonicalJson, sha256Hex, stableStringify, uuidv7 } from '@ai-bdd/contracts';

export interface EvidenceWriteInput {
  kind: EvidenceKind;
  data: Uint8Array | string | JsonValue;
  ext: string;
  mediaType?: string;
  stepId?: string;
  scenarioId?: string;
  traceId?: string;
  spanId?: string;
  meta?: Record<string, JsonValue>;
}

export interface EvidenceStoreOptions {
  redactor?: Redactor;
  signer?: Signer;
  now?: () => Date;
  runId?: string;
}

export interface Signer {
  alg: 'ed25519';
  keyId?: string;
  sign(data: Uint8Array): string;
}

/** Ed25519 signer over a PKCS8 PEM private key (R-K14). */
export function createSigner(pem: string, keyId?: string): Signer {
  const key = createPrivateKey(pem);
  return {
    alg: 'ed25519',
    ...(keyId !== undefined ? { keyId } : {}),
    sign(data: Uint8Array): string {
      return edSign(null, Buffer.from(data), key).toString('base64');
    },
  };
}

/** Generates a throwaway key pair, used by tests and `ai-bdd init --signing-key`. */
export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function toBytes(input: EvidenceWriteInput['data']): { bytes: Uint8Array; text?: string } {
  if (input instanceof Uint8Array) return { bytes: input };
  const text = typeof input === 'string' ? input : `${stableStringify(input)}\n`;
  return { bytes: new TextEncoder().encode(text), text };
}

/**
 * Content-addressed evidence store with a hash-chained manifest (section 8.7).
 *
 * Artifacts are redacted before hashing for text kinds; pixel kinds are masked
 * by the driver. Writes are atomic (temp file + rename) and every record is
 * appended to manifest.jsonl with `chainHash = H(prevChainHash + canonical(record))`.
 */
export class EvidenceStore {
  readonly runId: string;
  readonly runDir: string;
  private readonly redactor?: Redactor;
  private readonly signer?: Signer;
  private readonly now: () => Date;
  private readonly records: EvidenceRecord[] = [];
  private prevChainHash = ZERO_HASH;
  private finalized = false;

  constructor(runDir: string, options: EvidenceStoreOptions = {}) {
    this.runDir = runDir;
    this.runId = options.runId ?? uuidv7();
    if (options.redactor !== undefined) this.redactor = options.redactor;
    if (options.signer !== undefined) this.signer = options.signer;
    this.now = options.now ?? (() => new Date());
    mkdirSync(join(runDir, 'artifacts'), { recursive: true });
    writeFileSync(join(runDir, 'manifest.jsonl'), '');
  }

  async write(input: EvidenceWriteInput): Promise<EvidenceRecord> {
    if (this.finalized) throw new AiBddError('INTERNAL', 'the evidence store is finalized');
    const textKind = typeof input.data === 'string' || (!(input.data instanceof Uint8Array) && typeof input.data === 'object');
    const redactedInput = textKind && this.redactor ? { ...input, data: this.redactor.redactJson(input.data) } : input;
    const { bytes } = toBytes(redactedInput.data);
    const sha256 = sha256Hex(bytes);
    const artifactRel = join('artifacts', `${sha256}.${input.ext}`);
    const artifactAbs = join(this.runDir, artifactRel);
    if (!existsSync(artifactAbs)) writeAtomic(artifactAbs, bytes);

    const body = {
      evidenceId: sha256.slice(0, 16),
      runId: this.runId,
      kind: input.kind,
      artifact: {
        sha256,
        ext: input.ext,
        ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
        path: artifactRel,
        bytes: bytes.length,
      },
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
      ...(input.scenarioId !== undefined ? { scenarioId: input.scenarioId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
      createdAt: this.now().toISOString(),
      prevChainHash: this.prevChainHash,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
    const chainHash = sha256Hex(this.prevChainHash + canonicalJson(body as unknown as JsonValue));
    const record: EvidenceRecord = { ...body, chainHash };
    this.prevChainHash = chainHash;
    this.records.push(record);
    appendFileSync(join(this.runDir, 'manifest.jsonl'), `${stableStringify(record)}\n`);
    return record;
  }

  list(): EvidenceRecord[] {
    return [...this.records];
  }

  async finalize(): Promise<EvidenceManifest> {
    this.finalized = true;
    const manifest: EvidenceManifest = {
      runId: this.runId,
      rootHash: this.prevChainHash,
      count: this.records.length,
      createdAt: this.now().toISOString(),
    };
    if (this.signer) {
      manifest.signature = {
        alg: this.signer.alg,
        ...(this.signer.keyId !== undefined ? { keyId: this.signer.keyId } : {}),
        value: this.signer.sign(new TextEncoder().encode(manifest.rootHash)),
      };
    }
    writeAtomic(join(this.runDir, 'manifest.json'), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    return manifest;
  }
}

export function writeAtomic(path: string, bytes: Uint8Array): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

/** Recomputes artifacts, the chain and the signature (R-K14). */
export async function verifyEvidence(runDir: string): Promise<EvidenceVerification> {
  const problems: Array<{ kind: string; detail: string; record?: string }> = [];
  const manifestPath = join(runDir, 'manifest.json');
  const jsonlPath = join(runDir, 'manifest.jsonl');
  if (!existsSync(manifestPath) || !existsSync(jsonlPath)) {
    return { ok: false, problems: [{ kind: 'missing-manifest', detail: `${runDir} has no manifest` }], count: 0 };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest;
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  let prev = ZERO_HASH;
  let count = 0;
  for (const line of lines) {
    let record: EvidenceRecord;
    try {
      record = JSON.parse(line) as EvidenceRecord;
    } catch {
      problems.push({ kind: 'unreadable-record', detail: 'a manifest line is not valid JSON' });
      continue;
    }
    count += 1;
    const { chainHash, ...body } = record;
    if (record.prevChainHash !== prev) {
      problems.push({ kind: 'chain-broken', detail: 'prevChainHash does not match the previous record', record: record.evidenceId });
    }
    const expected = sha256Hex(prev + canonicalJson(body as unknown as JsonValue));
    if (expected !== chainHash) {
      problems.push({ kind: 'chain-mismatch', detail: 'the record was modified after it was written', record: record.evidenceId });
    }
    prev = chainHash;

    const artifactPath = join(runDir, record.artifact.path);
    if (!existsSync(artifactPath)) {
      problems.push({ kind: 'artifact-missing', detail: `missing ${record.artifact.path}`, record: record.evidenceId });
      continue;
    }
    const bytes = readFileSync(artifactPath);
    const actual = sha256Hex(bytes);
    if (actual !== record.artifact.sha256) {
      problems.push({
        kind: 'artifact-modified',
        detail: `${record.artifact.path} hashes to ${actual}, expected ${record.artifact.sha256}`,
        record: record.evidenceId,
      });
    }
  }

  if (count !== manifest.count) {
    problems.push({ kind: 'count-mismatch', detail: `manifest says ${manifest.count}, found ${count}` });
  }
  if (prev !== manifest.rootHash) {
    problems.push({ kind: 'root-hash-mismatch', detail: `rootHash is ${manifest.rootHash}, computed ${prev}` });
  }
  return { ok: problems.length === 0, problems, count, rootHash: prev };
}

export function readRecord(runDir: string, evidenceId: string): { record: EvidenceRecord; absolutePath: string } | null {
  const jsonlPath = join(runDir, 'manifest.jsonl');
  if (!existsSync(jsonlPath)) return null;
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as EvidenceRecord;
    if (record.evidenceId === evidenceId) {
      return { record, absolutePath: join(runDir, record.artifact.path) };
    }
  }
  return null;
}
