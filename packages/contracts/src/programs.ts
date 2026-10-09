import type { ArtifactRef, Observation, Selector, Verb } from './driver.js';
import type { JsonValue } from './primitives.js';

/** A recorded action value that may be a literal or a step-parameter slot (R-K10). */
export type TypedValue = { literal: string } | { param: string } | { secret: string };

/** One recorded action inside an ActProgram. */
export interface ActAction {
  verb: Verb;
  selector?: Selector;
  value?: TypedValue;
  params?: JsonValue;
  delivery?: 'background' | 'foreground';
}

export type EffectChange = 'appeared' | 'disappeared' | 'state';

export interface EffectElement {
  selector: Selector;
  change: EffectChange;
  /** For `state` changes: `checked=true`, `disabled=false`, ... */
  detail?: string;
}

/** What must have changed for a replay to count as successful (F-E5). */
export interface EffectSignature {
  elements: EffectElement[];
  route?: { before?: string; after?: string };
}

export interface StartFingerprint {
  route?: string;
  landmarks: Array<{ role: string; name?: string }>;
}

export interface ActProgram {
  version: 1;
  key: string;
  /** Normalized step text with parameters replaced by `<name>`. */
  text: string;
  driver: string;
  driverMajor: number;
  params: string[];
  start: StartFingerprint;
  actions: ActAction[];
  effect: EffectSignature;
  recordedAt: string;
  /** True until a later assertion in the same scenario passes (commit rule). */
  pending?: boolean;
}

export type CheckPredicate =
  | { kind: 'exists'; selector: Selector }
  | { kind: 'notExists'; selector: Selector }
  | { kind: 'visible'; selector: Selector }
  | { kind: 'textEquals'; selector: Selector; value: string; fromParam?: string }
  | { kind: 'textContains'; selector: Selector; value: string; fromParam?: string }
  | { kind: 'textMatches'; selector: Selector; regex: string }
  | { kind: 'count'; selector: Selector; value: number }
  | { kind: 'routeMatches'; regex: string }
  | { kind: 'driverNative'; tool: string; args: JsonValue };

export type PredicateResultValue = 'satisfied' | 'unsatisfied' | 'unknown';

export interface PredicateResult {
  predicate: CheckPredicate;
  result: PredicateResultValue;
  detail?: string;
}

export interface CheckProgram {
  version: 1;
  key: string;
  text: string;
  driver: string;
  driverMajor: number;
  predicates: CheckPredicate[];
  /** `invariant` means the criterion asserts that state did NOT change (R-K9). */
  classification: 'change' | 'invariant';
  invariant?: boolean;
  generatedBy?: string;
  createdAt?: string;
  /** True once the program was discriminative and the judge passed (commit rule). */
  verified?: boolean;
}

export type CacheMode = 'read-write' | 'read-only' | 'off';

export type InvalidationResult = 'valid' | 'invalid' | 'unknown';

export interface InvalidationContext {
  observation?: Observation;
  driver: string;
  driverMajor: number;
  stepText: string;
  params?: Record<string, JsonValue>;
}

/** Pluggable cache invalidation strategy (section 8.5). */
export interface InvalidationStrategy {
  name: string;
  /** Fingerprint stored at write time; `null` means "not applicable". */
  fingerprint(ctx: InvalidationContext): string | null;
  /** Validate a stored entry at read time. */
  validate(entry: { fingerprint?: string; program: ActProgram | CheckProgram }, ctx: InvalidationContext): InvalidationResult;
}

export interface CacheOutcome {
  mode: 'replayed' | 'healed' | 'missed' | 'recorded' | 'bypassed' | 'read-only' | 'invalid';
  key?: string;
  invalidation?: Array<{ strategy: string; result: InvalidationResult }>;
  reason?: string;
}

export interface CacheEntry<T> {
  key: string;
  version: 1;
  createdAt: string;
  fingerprint?: string;
  mode: CacheMode;
  program: T;
}

export interface ActOutcome {
  status: 'passed' | 'failed';
  cache: CacheOutcome;
  actions: ActAction[];
  modelCalls: number;
  summary?: string;
  /** Number of replayed actions before a hand-off, when healed. */
  replayedActions?: number;
  error?: { code: string; message: string };
  pending?: () => Promise<void>;
}

export interface AssertOutcome {
  status: 'passed' | 'failed';
  check?: {
    programKey?: string;
    results: PredicateResult[];
    status: 'passed' | 'failed' | 'skipped';
    invariant?: boolean;
    judgeOnly?: boolean;
  };
  judge?: import('./judge.js').JudgeVerdict;
  modelCalls?: number;
  evidence?: ArtifactRef[];
  error?: { code: string; message: string };
}
