import type { JsonValue, KindSource, StepKind } from './primitives.js';

/** One ranked candidate for a semantic match. */
export interface Candidate {
  bindingId: string;
  bindingHash: string;
  score: number;
  /** Score margin against the runner-up in this candidate's own ranking. */
  margin?: number;
  /** Human-readable guard rejection reason, when the candidate was filtered. */
  guard?: string;
}

export interface ParamExtraction {
  modelId: string;
  promptVersion: string;
  raw: JsonValue;
  validated: boolean;
}

export type AmbiguityReason = 'margin' | 'multiple-exact' | 'guard-rejected';

export type Resolution =
  | {
      type: 'exact';
      bindingId: string;
      bindingHash: string;
      params: Record<string, JsonValue>;
    }
  | {
      type: 'semantic';
      bindingId: string;
      bindingHash: string;
      params: Record<string, JsonValue>;
      score: number;
      margin: number;
      candidates: Candidate[];
      extraction: ParamExtraction;
    }
  | {
      type: 'agent';
      mode: 'act' | 'assert';
      reason: 'no-match' | 'guard-rejected' | 'below-threshold';
    }
  | {
      type: 'ambiguous';
      reason: AmbiguityReason;
      candidates: Candidate[];
      message: string;
    }
  | {
      type: 'unbound';
      reason: 'setup-unbound' | 'no-binding';
      message: string;
    };

export type LockStatus = 'new' | 'unchanged' | 'revalidated' | 'changed' | 'ambiguous' | 'missing';

export interface ResolutionResult {
  resolution: Resolution;
  kind: StepKind;
  kindSource: KindSource;
  lockStatus?: LockStatus;
  lockKey?: string;
}

/** Kind classification source class that is dialect independent (R-K7). */
export type KindClass = 'explicit-keyword' | 'declared-binding' | 'inferred' | 'directive';

/**
 * One lockfile entry. The key is dialect and driver independent (R-K7); every
 * non-exact resolution must appear here (R-K5f).
 */
export interface LockEntry {
  key: string;
  stepText: string;
  normalizedStepText: string;
  kind: StepKind;
  kindClass: KindClass;
  status: 'semantic' | 'agent' | 'ambiguous' | 'inferred-kind';
  resolution: Resolution;
  bindingSetHash: string;
  candidates: Candidate[];
  extraction?: ParamExtraction;
  /** True when the winner survived an incremental revalidation (R-K6). */
  revalidated?: boolean;
  updatedAt: string;
}

export interface LockFile {
  version: 1;
  generator: string;
  entries: LockEntry[];
}
