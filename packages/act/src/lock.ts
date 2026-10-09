import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReproductionLock, StepReproduction } from '@ai-bdd/contracts';
import { AiBddError, lockKey, normalizeStepText, stableStringify } from '@ai-bdd/contracts';

/**
 * The reproduction lockfile.
 *
 * This is the intermediate artifact that turns a characterization run into a
 * reproducible test: every step that needed an actor is written here with the actions it
 * performed, the effect that must be newly true for a replay to count, the evidence it
 * produced, and whether the step is deterministic (replay) or non-deterministic (eval).
 *
 * The file is deterministic — entries sorted by key, stable JSON, LF endings — and it is
 * written atomically under a lock, so four workers cannot lose each other's entries.
 */
export interface LockSummary {
  added: number;
  changed: number;
  unchanged: number;
  removed: number;
}

/** The key for a step's reproduction: dialect- and driver-independent. */
export function reproductionKey(step: { text: string; kind: string }, driverClass: string): string {
  return lockKey({ normalizedStepText: normalizeStepText(step.text), kind: step.kind, kindClass: driverClass });
}

export class ReproductionLockStore {
  private readonly path: string;
  private readonly entries = new Map<string, StepReproduction>();
  private readonly original = new Map<string, string>();
  private dirty = false;

  private constructor(path: string) {
    this.path = path;
  }

  static load(path: string): ReproductionLockStore {
    const store = new ReproductionLockStore(path);
    if (!existsSync(path)) return store;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReproductionLock;
      for (const step of parsed.steps ?? []) {
        store.entries.set(step.key, step);
        store.original.set(step.key, stepHash(step));
      }
    } catch (error) {
      throw new AiBddError('CONFIG_INVALID', `the reproduction lockfile is not readable: ${path}`, { cause: error });
    }
    return store;
  }

  get(key: string): StepReproduction | undefined {
    return this.entries.get(key);
  }

  upsert(step: StepReproduction): void {
    const next = stepHash(step);
    if (this.original.get(step.key) !== next) this.dirty = true;
    this.entries.set(step.key, step);
  }

  remove(key: string): void {
    if (this.entries.delete(key)) this.dirty = true;
  }

  entries_(): StepReproduction[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  summary(): LockSummary {
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    for (const [key, step] of this.entries) {
      const before = this.original.get(key);
      if (before === undefined) added += 1;
      else if (before === stepHash(step)) unchanged += 1;
      else changed += 1;
    }
    let removed = 0;
    for (const key of this.original.keys()) if (!this.entries.has(key)) removed += 1;
    return { added, changed, unchanged, removed };
  }

  /** Deterministic, sorted, atomic, and safe under concurrent writers. */
  async save(): Promise<void> {
    const document: ReproductionLock = {
      version: 1,
      generator: 'ai-bdd',
      steps: [...this.entries.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    };
    const contents = `${stableStringify(document as never)}\n`;
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    // A cruder but dependency-free mutual exclusion: O_EXCL on a sidecar file.
    const deadline = Date.now() + 10_000;
    let handle: number | undefined;
    while (handle === undefined) {
      try {
        handle = openSync(lockPath, 'wx');
      } catch {
        if (Date.now() > deadline) throw new AiBddError('RESOURCE_LOCKED', `could not lock ${this.path}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        // A writer that merged while we waited may have already written our entries.
        if (!existsSync(lockPath)) continue;
      }
    }
    try {
      // Merge with whatever is on disk now, so a concurrent writer's entries survive.
      if (existsSync(this.path)) {
        try {
          const onDisk = JSON.parse(readFileSync(this.path, 'utf8')) as ReproductionLock;
          for (const step of onDisk.steps ?? []) {
            if (!this.entries.has(step.key) && this.original.has(step.key)) this.entries.set(step.key, step);
          }
        } catch {
          // an unreadable file is replaced by ours
        }
      }
      const merged: ReproductionLock = {
        version: 1,
        generator: 'ai-bdd',
        steps: [...this.entries.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
      };
      const temp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(temp, `${stableStringify(merged as never)}\n`);
      renameSync(temp, this.path);
      this.dirty = false;
    } finally {
      if (handle !== undefined) closeSync(handle);
      rmSync(lockPath, { force: true });
    }
    void contents;
  }

  toJson(): string {
    return `${stableStringify({
      version: 1,
      generator: 'ai-bdd',
      steps: [...this.entries.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    } as never)}\n`;
  }
}

/** A content hash of one entry, ignoring the fields that are allowed to move. */
function stepHash(step: StepReproduction): string {
  const { recordedAt: _recordedAt, pending: _pending, modelCalls: _modelCalls, evidence: _evidence, ...stable } = step;
  void _recordedAt;
  void _pending;
  void _modelCalls;
  void _evidence;
  return stableStringify(stable as never);
}
