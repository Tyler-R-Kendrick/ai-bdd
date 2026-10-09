import type { ArtifactRef, Observation } from './driver.js';
import type { JsonValue } from './primitives.js';

export type EvidenceKind =
  | 'screenshot'
  | 'observation'
  | 'video'
  | 'har'
  | 'console'
  | 'trace'
  | 'test-result'
  | 'reproduction'
  | 'judge-request'
  | 'judge-response'
  | 'eval-request'
  | 'eval-response'
  | 'action-log'
  | 'check-result'
  | 'act-program'
  | 'check-program'
  | 'log'
  | 'attachment'
  | 'tree'
  | 'dom';

export interface EvidenceRecord {
  evidenceId: string;
  runId: string;
  kind: EvidenceKind;
  artifact: ArtifactRef;
  stepId?: string;
  scenarioId?: string;
  traceId?: string;
  spanId?: string;
  createdAt: string;
  /** H(prevChainHash + canonical(record without chainHash)). */
  chainHash: string;
  prevChainHash: string;
  meta?: Record<string, JsonValue>;
}

export interface EvidenceSignature {
  alg: 'ed25519';
  keyId?: string;
  value: string;
}

export interface EvidenceManifest {
  runId: string;
  rootHash: string;
  count: number;
  createdAt: string;
  signature?: EvidenceSignature;
}

export interface EvidenceVerification {
  ok: boolean;
  problems: Array<{ kind: string; detail: string; record?: string }>;
  count: number;
  rootHash?: string;
}

export interface SettleOptions {
  /** Minimum window with no observed change. Default 300ms. */
  quietMs: number;
  /** Poll interval. Default 100ms. */
  intervalMs: number;
  /** Give up after this long. Default 5000ms. */
  timeoutMs: number;
  /** Allowed fraction of changed pixels across a quiet window. Default 0.001. */
  pixelTolerance: number;
}

export interface SettleResult {
  settled: boolean;
  observation: Observation;
  attempts: number;
  elapsedMs: number;
  reason?: string;
}

export interface Redactor {
  /** Redact one string (exact value, URL-encoded and base64 forms). */
  redact(text: string): string;
  /** Deep-redact a JSON value. */
  redactJson<T>(value: T): T;
  /** Names of the declared secrets. */
  names(): string[];
}
