import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AiBddError,
  type Candidate,
  type JsonValue,
  type LockEntry,
  type LockFile,
  type LockSummary,
  type ParamExtraction,
  type Resolution,
} from '@ai-bdd/contracts';

/** Version string written into `generator` so lockfiles are self-describing. */
export const LOCK_GENERATOR = 'ai-bdd/lock@0.1.0';

export interface LockStoreOptions {
  /** Injectable clock; deterministic tests pass a fixed function. */
  now?: () => Date;
  generator?: string;
}

let tempCounter = 0;

function sortedRecord(record: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key] as JsonValue;
  return out;
}

function serializeCandidate(candidate: Candidate): JsonValue {
  const out: Record<string, JsonValue> = {
    bindingId: candidate.bindingId,
    bindingHash: candidate.bindingHash,
    score: candidate.score,
  };
  if (candidate.margin !== undefined) out.margin = candidate.margin;
  if (candidate.guard !== undefined) out.guard = candidate.guard;
  return out;
}

function serializeExtraction(extraction: ParamExtraction): JsonValue {
  return {
    modelId: extraction.modelId,
    promptVersion: extraction.promptVersion,
    raw: extraction.raw === null || typeof extraction.raw !== 'object' || Array.isArray(extraction.raw)
      ? extraction.raw
      : sortedRecord(extraction.raw as Record<string, JsonValue>),
    validated: extraction.validated,
  };
}

function serializeResolution(resolution: Resolution): JsonValue {
  switch (resolution.type) {
    case 'exact':
      return {
        type: 'exact',
        bindingId: resolution.bindingId,
        bindingHash: resolution.bindingHash,
        params: sortedRecord(resolution.params),
      };
    case 'semantic':
      return {
        type: 'semantic',
        bindingId: resolution.bindingId,
        bindingHash: resolution.bindingHash,
        params: sortedRecord(resolution.params),
        score: resolution.score,
        margin: resolution.margin,
        candidates: resolution.candidates.map(serializeCandidate),
        extraction: serializeExtraction(resolution.extraction),
      };
    case 'agent':
      return { type: 'agent', mode: resolution.mode, reason: resolution.reason };
    case 'ambiguous':
      return {
        type: 'ambiguous',
        reason: resolution.reason,
        candidates: resolution.candidates.map(serializeCandidate),
        message: resolution.message,
      };
    case 'unbound':
      return { type: 'unbound', reason: resolution.reason, message: resolution.message };
    default:
      return { type: 'unbound', reason: 'no-binding', message: 'unknown resolution' };
  }
}

/** Serialize one entry with a fixed field order so the bytes are stable. */
export function serializeEntry(entry: LockEntry): JsonValue {
  const out: Record<string, JsonValue> = {
    key: entry.key,
    stepText: entry.stepText,
    normalizedStepText: entry.normalizedStepText,
    kind: entry.kind,
    kindClass: entry.kindClass,
    status: entry.status,
    bindingSetHash: entry.bindingSetHash,
    resolution: serializeResolution(entry.resolution),
    candidates: entry.candidates.map(serializeCandidate),
  };
  if (entry.extraction !== undefined) out.extraction = serializeExtraction(entry.extraction);
  if (entry.revalidated === true) out.revalidated = true;
  out.updatedAt = entry.updatedAt;
  return out;
}

function readLockFile(path: string): LockFile | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: LockFile;
  try {
    parsed = JSON.parse(text) as LockFile;
  } catch (error) {
    throw new AiBddError('INTERNAL', `Invalid lockfile at ${path}: ${(error as Error).message}`);
  }
  if (parsed === null || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new AiBddError('INTERNAL', `Invalid lockfile at ${path}: unexpected shape`);
  }
  return parsed;
}

async function acquireFileLock(lockPath: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - start > timeoutMs) {
        throw new AiBddError('INTERNAL', `Could not acquire lockfile lock at ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function releaseFileLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best effort: a missing lock file is already released
  }
}

function sameEntry(a: LockEntry, b: LockEntry): boolean {
  return JSON.stringify(serializeEntry(a)) === JSON.stringify(serializeEntry(b));
}

/**
 * The resolution lockfile (R-K5f, R-K6, R-K7). Entries are keyed by the
 * dialect-independent `lockKey`, sorted by key, serialized with a fixed field
 * order and written atomically (temp file + rename) under an O_EXCL lock so
 * concurrent writers never lose entries.
 */
export class LockStore {
  private readonly entriesMap = new Map<string, LockEntry>();
  private readonly stats: LockSummary = { added: 0, changed: 0, revalidated: 0, unchanged: 0, ambiguous: 0 };
  private readonly nowFn: () => Date;
  readonly generator: string;
  readonly path: string;

  private constructor(path: string, opts: LockStoreOptions) {
    this.path = path;
    this.generator = opts.generator ?? LOCK_GENERATOR;
    this.nowFn = opts.now ?? (() => new Date());
  }

  /** Load an existing lockfile, or an empty store when the file is missing. */
  static load(path: string, opts: LockStoreOptions = {}): LockStore {
    const store = new LockStore(path, opts);
    const file = readLockFile(path);
    if (file !== null) {
      for (const entry of file.entries) store.entriesMap.set(entry.key, entry);
    }
    return store;
  }

  static empty(path: string, opts: LockStoreOptions = {}): LockStore {
    return new LockStore(path, opts);
  }

  now(): Date {
    return this.nowFn();
  }

  get(key: string): LockEntry | undefined {
    return this.entriesMap.get(key);
  }

  upsert(entry: LockEntry): void {
    const previous = this.entriesMap.get(entry.key);
    if (previous === undefined) this.stats.added += 1;
    else if (entry.revalidated === true) this.stats.revalidated += 1;
    else if (sameEntry(previous, entry)) this.stats.unchanged += 1;
    else this.stats.changed += 1;
    if (entry.resolution.type === 'ambiguous') this.stats.ambiguous += 1;
    this.entriesMap.set(entry.key, entry);
  }

  entries(): LockEntry[] {
    return [...this.entriesMap.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  summary(): LockSummary {
    return { ...this.stats };
  }

  toJson(): string {
    const file = {
      version: 1,
      generator: this.generator,
      entries: this.entries().map(serializeEntry),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  /** Deterministic, sorted, atomic save; merges any entries already on disk. */
  async save(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    await acquireFileLock(lockPath);
    try {
      const disk = readLockFile(this.path);
      if (disk !== null) {
        for (const entry of disk.entries) {
          if (!this.entriesMap.has(entry.key)) this.entriesMap.set(entry.key, entry);
        }
      }
      const temp = `${this.path}.${process.pid}.${tempCounter}.tmp`;
      tempCounter += 1;
      writeFileSync(temp, this.toJson());
      renameSync(temp, this.path);
    } finally {
      releaseFileLock(lockPath);
    }
  }
}
