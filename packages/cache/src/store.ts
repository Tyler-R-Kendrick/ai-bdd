import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  canonicalJson,
  type ActProgram,
  type CacheEntry,
  type CacheMode,
  type CheckProgram,
  type InvalidationContext,
  type InvalidationResult,
  type InvalidationStrategy,
  type JsonValue,
} from '@ai-bdd/contracts';
import { buildStrategies, effectVerify, type StrategyOptions } from './strategies.js';

export interface InvalidationOutcome {
  strategy: string;
  result: InvalidationResult;
}

export interface CacheRead<T> {
  program: T;
  invalidation: InvalidationOutcome[];
  valid: boolean;
}

export interface CacheStore {
  getAct(key: string, ctx?: InvalidationContext): Promise<{ program: ActProgram; invalidation: InvalidationOutcome[] } | null>;
  getCheck(key: string, ctx?: InvalidationContext): Promise<{ program: CheckProgram; invalidation: InvalidationOutcome[] } | null>;
  putAct(program: ActProgram, ctx: InvalidationContext): Promise<void>;
  putCheck(program: CheckProgram, ctx: InvalidationContext): Promise<void>;
  commitPending(): Promise<void>;
  evict(): Promise<void>;
  peekAct(key: string, ctx?: InvalidationContext): Promise<CacheRead<ActProgram> | null>;
  peekCheck(key: string, ctx?: InvalidationContext): Promise<CacheRead<CheckProgram> | null>;
  pending(): { act: number; check: number };
}

export interface CacheStoreOptions extends StrategyOptions {
  dir: string;
  mode: CacheMode;
  strategies?: InvalidationStrategy[];
  /** Strategy names resolved through `buildStrategies` when `strategies` is absent. */
  invalidation?: string[];
  now?: () => Date;
}

let tempCounter = 0;

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/gu, '_');
}

function encodeFingerprints(fingerprints: Record<string, string | null>): string {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(fingerprints).sort()) {
    const value = fingerprints[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return canonicalJson(out);
}

function decodeFingerprints(encoded: string | undefined): Record<string, string> {
  if (encoded === undefined) return {};
  try {
    const parsed = JSON.parse(encoded) as Record<string, JsonValue>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') out[key] = value;
    return out;
  } catch {
    return {};
  }
}

function readEntry<T>(path: string): CacheEntry<T> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as CacheEntry<T>;
    if (parsed === null || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeEntry<T>(path: string, entry: CacheEntry<T>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${tempCounter}.tmp`;
  tempCounter += 1;
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(temp, path);
}

/**
 * The act/check cache store (section 8.5). Reads validate the stored entry
 * through every configured strategy; writes are staged (`putAct`/`putCheck`)
 * and flushed atomically by `commitPending`. `read-only` and `off` never write.
 */
export function createCacheStore(opts: CacheStoreOptions): CacheStore {
  const mode = opts.mode;
  const strategies =
    opts.strategies ??
    (opts.invalidation !== undefined
      ? buildStrategies(opts.invalidation, {
          ...(opts.files !== undefined ? { files: opts.files } : {}),
          ...(opts.buildChecksum !== undefined ? { buildChecksum: opts.buildChecksum } : {}),
          ...(opts.manual !== undefined ? { manual: opts.manual } : {}),
          ...(opts.custom !== undefined ? { custom: opts.custom } : {}),
          ...(opts.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
        })
      : [effectVerify()]);
  const now = opts.now ?? (() => new Date());
  const pendingAct = new Map<string, CacheEntry<ActProgram>>();
  const pendingCheck = new Map<string, CacheEntry<CheckProgram>>();
  const actPath = (key: string): string => join(opts.dir, 'act', `${sanitizeKey(key)}.json`);
  const checkPath = (key: string): string => join(opts.dir, 'check', `${sanitizeKey(key)}.json`);

  function computeFingerprint(ctx: InvalidationContext): string {
    const fingerprints: Record<string, string | null> = {};
    for (const strategy of strategies) fingerprints[strategy.name] = strategy.fingerprint(ctx);
    return encodeFingerprints(fingerprints);
  }

  function validate<T>(entry: CacheEntry<T>, ctx: InvalidationContext | undefined): InvalidationOutcome[] {
    if (ctx === undefined) return [];
    const fingerprints = decodeFingerprints(entry.fingerprint);
    return strategies.map((strategy) => {
      const fingerprint = fingerprints[strategy.name];
      const input = {
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        program: entry.program as ActProgram | CheckProgram,
      };
      return { strategy: strategy.name, result: strategy.validate(input, ctx) };
    });
  }

  function isValid(invalidation: InvalidationOutcome[]): boolean {
    for (const outcome of invalidation) {
      if (outcome.result === 'invalid') return false;
      if (outcome.result === 'unknown' && outcome.strategy !== 'effect-verify') return false;
    }
    return true;
  }

  async function peekAct(key: string, ctx?: InvalidationContext): Promise<CacheRead<ActProgram> | null> {
    if (mode === 'off') return null;
    const entry = readEntry<ActProgram>(actPath(key));
    if (entry === null) return null;
    const invalidation = validate(entry, ctx);
    return { program: entry.program, invalidation, valid: isValid(invalidation) };
  }

  async function peekCheck(key: string, ctx?: InvalidationContext): Promise<CacheRead<CheckProgram> | null> {
    if (mode === 'off') return null;
    const entry = readEntry<CheckProgram>(checkPath(key));
    if (entry === null) return null;
    const invalidation = validate(entry, ctx);
    return { program: entry.program, invalidation, valid: isValid(invalidation) };
  }

  function stage<T>(pending: Map<string, CacheEntry<T>>, program: T & { key: string }, ctx: InvalidationContext): void {
    if (mode !== 'read-write') return;
    const entry: CacheEntry<T> = {
      key: program.key,
      version: 1,
      createdAt: now().toISOString(),
      mode,
      program,
    };
    const fingerprint = computeFingerprint(ctx);
    if (fingerprint !== '{}') entry.fingerprint = fingerprint;
    pending.set(program.key, entry);
  }

  return {
    async getAct(key, ctx) {
      const peeked = await peekAct(key, ctx);
      if (peeked === null || !peeked.valid) return null;
      return { program: peeked.program, invalidation: peeked.invalidation };
    },
    async getCheck(key, ctx) {
      const peeked = await peekCheck(key, ctx);
      if (peeked === null || !peeked.valid) return null;
      return { program: peeked.program, invalidation: peeked.invalidation };
    },
    async putAct(program, ctx) {
      stage(pendingAct, program, ctx);
    },
    async putCheck(program, ctx) {
      stage(pendingCheck, program, ctx);
    },
    async commitPending() {
      if (mode !== 'read-write') return;
      for (const [key, entry] of pendingAct) writeEntry(actPath(key), entry);
      for (const [key, entry] of pendingCheck) writeEntry(checkPath(key), entry);
      pendingAct.clear();
      pendingCheck.clear();
    },
    async evict() {
      pendingAct.clear();
      pendingCheck.clear();
      if (mode !== 'read-write') return;
      rmSync(join(opts.dir, 'act'), { recursive: true, force: true });
      rmSync(join(opts.dir, 'check'), { recursive: true, force: true });
    },
    peekAct,
    peekCheck,
    pending() {
      return { act: pendingAct.size, check: pendingCheck.size };
    },
  };
}
