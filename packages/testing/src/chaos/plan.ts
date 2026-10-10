import { AiBddError, type ErrorCode, type ModelPurpose, type Verb } from '@ai-bdd/sdk/contracts';
import { seededRandom, type SeededRandom } from './random.ts';

/** Where in the driver contract a fault can strike. */
export const DRIVER_HOOKS = ['create', 'openSession', 'observe', 'perform', 'request', 'close', 'selfCheck', 'dispose'] as const;
export type DriverHook = (typeof DRIVER_HOOKS)[number];

/** Model purposes a rule can target; `'*'` is every purpose. */
export type ModelHook = ModelPurpose | '*';
export const MODEL_HOOKS: readonly ModelHook[] = ['extract', 'act', 'checkgen', 'judge', '*'];

/** When a rule fires. All given conditions must hold (they are ANDed); a rule with none fires on every matching call. */
export interface RuleTrigger {
  /** Fire on the n-th matching call (1-based), or on each listed call. */
  nth?: number | number[];
  /** Fire on this matching call and every later one (1-based). With `times: N` that is "N consecutive failures, then success". */
  from?: number;
  /** Fire with this probability (0..1), drawn from the plan's seeded generator. */
  probability?: number;
  /** Stop firing after this many injections. */
  times?: number;
}

export const GARBLE_MODES = ['stale', 'shuffle', 'duplicate-refs', 'drop-fields', 'wrong-types', 'drop-nodes', 'empty'] as const;
export type GarbleMode = (typeof GARBLE_MODES)[number];

export const DRIVER_THROW_CODES = ['DRIVER_ERROR', 'DRIVER_UNAVAILABLE', 'SESSION_LIMIT'] as const;
export type DriverThrowCode = (typeof DRIVER_THROW_CODES)[number];

export type DriverFault =
  /** Throw an `AiBddError` with this code (`retryable` defaults to the code's documented value). */
  | { kind: 'throw'; code: DriverThrowCode; message?: string; retryable?: boolean }
  /** Throw a plain `Error` (a driver bug, not a reported failure). */
  | { kind: 'throw-raw'; message?: string }
  /** Report failure the way drivers should: `{ ok: false }` for `perform`, `{ status, body }` for `request`, `{ ok: false, problems }` for `selfCheck`. */
  | { kind: 'fail'; code?: ErrorCode; message?: string; retryable?: boolean; status?: number }
  /** Wait `ms` on the injected (virtual) sleep, then carry on with the real call. */
  | { kind: 'latency'; ms: number }
  /** `observe` only: return a damaged observation instead of the real one. */
  | { kind: 'garble'; mode: GarbleMode }
  /** `observe` / `perform` / `request`: this call and every later call on the same session fail with `code` (a crashed browser). */
  | { kind: 'drop-session'; code?: 'DRIVER_ERROR' | 'DRIVER_UNAVAILABLE'; message?: string }
  /** Never settle. */
  | { kind: 'hang' };

export interface DriverRule extends RuleTrigger {
  at: DriverHook;
  /** Only calls of this verb (`perform` only). */
  verb?: Verb;
  /** Only calls on the n-th session this driver opened (1-based; `observe` / `perform` / `request` / `close`). */
  session?: number;
  fault: DriverFault;
}

export const MODEL_THROW_CODES = ['MODEL_UNAVAILABLE', 'MODEL_OUTPUT_INVALID', 'MODEL_NO_RULE', 'ABORTED', 'INTERNAL'] as const;
export type ModelThrowCode = (typeof MODEL_THROW_CODES)[number];

export type ModelFault =
  /** Throw an `AiBddError` with this code. */
  | { kind: 'throw'; code: ModelThrowCode; message?: string; retryable?: boolean }
  /** Throw a plain `Error`. */
  | { kind: 'throw-raw'; message?: string }
  /** A provider outage: `MODEL_UNAVAILABLE`, retryable unless `permanent`. */
  | { kind: 'unavailable'; message?: string; permanent?: boolean }
  /** HTTP 429: `MODEL_UNAVAILABLE`, retryable, with `details.statusCode: 429`. */
  | { kind: 'rate-limit'; message?: string; retryAfterMs?: number }
  /** Wait `ms` (default 30000) on the injected sleep, then fail with a retryable `MODEL_UNAVAILABLE` ("timed out"). */
  | { kind: 'timeout'; ms?: number }
  /** The real answer, cut off and corrupted so it is no longer JSON; `object` is dropped. */
  | { kind: 'malformed-json' }
  /** Valid JSON of the wrong shape (a missing key, a wrong type, a wrong root, an unknown key). Tool calls get invalid arguments. */
  | { kind: 'schema-invalid' }
  /** No text, no object, no tool calls. */
  | { kind: 'empty' }
  /** Replace the tool calls with hostile ones. */
  | { kind: 'bad-tool-call'; mode: 'unknown-tool' | 'bad-args' | 'extra-unknown' }
  /** Pad the answer with `chars` characters (default 1_000_000) of text or inside the object. */
  | { kind: 'oversized'; chars?: number; where?: 'text' | 'object' }
  /** The real answer cut in half with `finishReason: 'length'`. */
  | { kind: 'truncated' }
  /** The real answer, with another finish reason. */
  | { kind: 'finish-reason'; reason: 'length' | 'error' | 'other' }
  /** Wait `ms` on the injected sleep, then carry on with the real call. */
  | { kind: 'latency'; ms: number }
  /** Never settle (rejects with `ABORTED` when the request's signal fires, unless `ignoreSignal`). */
  | { kind: 'hang'; ignoreSignal?: boolean };

export interface ModelRule extends RuleTrigger {
  at: ModelHook;
  /** Only requests whose structured `context` has these top-level values (e.g. `{ attempt: 1 }`). */
  context?: Record<string, string | number | boolean>;
  fault: ModelFault;
}

/** A fault plan is data: a seed and a list of rules. The same plan with the same seed injects the same faults on every run. */
export interface FaultPlan<R extends DriverRule | ModelRule = DriverRule | ModelRule> {
  seed: number | string;
  rules: R[];
}
export type DriverFaultPlan = FaultPlan<DriverRule>;
export type ModelFaultPlan = FaultPlan<ModelRule>;

const DRIVER_ALLOWED: Record<DriverFault['kind'], readonly DriverHook[]> = {
  throw: DRIVER_HOOKS,
  'throw-raw': DRIVER_HOOKS,
  fail: ['perform', 'request', 'selfCheck'],
  latency: DRIVER_HOOKS,
  garble: ['observe'],
  'drop-session': ['observe', 'perform', 'request'],
  hang: DRIVER_HOOKS,
};

function isCount(n: unknown, min: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= min;
}

function triggerProblems(r: RuleTrigger, where: string, out: string[]): void {
  if (r.nth !== undefined) {
    const list = Array.isArray(r.nth) ? r.nth : [r.nth];
    if (list.length === 0 || !list.every((n) => isCount(n, 1))) out.push(`${where}: nth must be a positive integer or a non-empty list of them`);
  }
  if (r.from !== undefined && !isCount(r.from, 1)) out.push(`${where}: from must be a positive integer`);
  if (r.times !== undefined && !isCount(r.times, 1)) out.push(`${where}: times must be a positive integer`);
  if (r.probability !== undefined && !(typeof r.probability === 'number' && r.probability >= 0 && r.probability <= 1)) {
    out.push(`${where}: probability must be a number between 0 and 1`);
  }
}

function planShapeProblems(plan: unknown, out: string[]): plan is { seed: number | string; rules: unknown[] } {
  if (typeof plan !== 'object' || plan === null) {
    out.push('plan must be an object { seed, rules }');
    return false;
  }
  const p = plan as { seed?: unknown; rules?: unknown };
  if (!(typeof p.seed === 'string' || (typeof p.seed === 'number' && Number.isFinite(p.seed)))) out.push('seed must be a string or a finite number');
  if (!Array.isArray(p.rules)) {
    out.push('rules must be an array');
    return false;
  }
  return true;
}

function fail(kind: string, problems: string[]): never {
  throw new AiBddError('CONFIG_INVALID', `invalid ${kind} fault plan:\n- ${problems.join('\n- ')}`, { details: { problems } });
}

/** Throws `CONFIG_INVALID` listing every problem of a driver plan; returns the plan when it is sound. */
export function validateDriverPlan(plan: DriverFaultPlan): DriverFaultPlan {
  const problems: string[] = [];
  if (planShapeProblems(plan, problems)) {
    plan.rules.forEach((rule, i) => {
      const where = `rules[${i}]`;
      if (typeof rule !== 'object' || rule === null) return void problems.push(`${where}: must be an object`);
      if (!(DRIVER_HOOKS as readonly string[]).includes(rule.at)) problems.push(`${where}: unknown hook "${String(rule.at)}"`);
      triggerProblems(rule, where, problems);
      if (rule.session !== undefined && !isCount(rule.session, 1)) problems.push(`${where}: session must be a positive integer`);
      if (rule.verb !== undefined && rule.at !== 'perform') problems.push(`${where}: verb only applies to "perform"`);
      const fault = rule.fault as DriverFault | undefined;
      if (typeof fault !== 'object' || fault === null || !(fault.kind in DRIVER_ALLOWED)) {
        return void problems.push(`${where}: unknown fault kind "${String((fault as { kind?: unknown } | undefined)?.kind)}"`);
      }
      if (!DRIVER_ALLOWED[fault.kind].includes(rule.at)) problems.push(`${where}: fault "${fault.kind}" cannot strike "${rule.at}"`);
      if (fault.kind === 'throw' && !(DRIVER_THROW_CODES as readonly string[]).includes(fault.code)) problems.push(`${where}: unsupported code "${String(fault.code)}"`);
      if (fault.kind === 'latency' && !(typeof fault.ms === 'number' && fault.ms >= 0 && Number.isFinite(fault.ms))) problems.push(`${where}: latency ms must be >= 0`);
      if (fault.kind === 'garble' && !(GARBLE_MODES as readonly string[]).includes(fault.mode)) problems.push(`${where}: unknown garble mode "${String(fault.mode)}"`);
      if (rule.session !== undefined && !(['observe', 'perform', 'request', 'close'] as DriverHook[]).includes(rule.at)) {
        problems.push(`${where}: session only applies to observe, perform, request and close`);
      }
    });
  }
  if (problems.length > 0) fail('driver', problems);
  return plan;
}

/** Throws `CONFIG_INVALID` listing every problem of a model plan; returns the plan when it is sound. */
export function validateModelPlan(plan: ModelFaultPlan): ModelFaultPlan {
  const problems: string[] = [];
  const kinds = ['throw', 'throw-raw', 'unavailable', 'rate-limit', 'timeout', 'malformed-json', 'schema-invalid', 'empty', 'bad-tool-call', 'oversized', 'truncated', 'finish-reason', 'latency', 'hang'];
  if (planShapeProblems(plan, problems)) {
    plan.rules.forEach((rule, i) => {
      const where = `rules[${i}]`;
      if (typeof rule !== 'object' || rule === null) return void problems.push(`${where}: must be an object`);
      if (!MODEL_HOOKS.includes(rule.at)) problems.push(`${where}: unknown purpose "${String(rule.at)}"`);
      triggerProblems(rule, where, problems);
      const fault = rule.fault as ModelFault | undefined;
      if (typeof fault !== 'object' || fault === null || !kinds.includes(fault.kind)) {
        return void problems.push(`${where}: unknown fault kind "${String((fault as { kind?: unknown } | undefined)?.kind)}"`);
      }
      if (fault.kind === 'throw' && !(MODEL_THROW_CODES as readonly string[]).includes(fault.code)) problems.push(`${where}: unsupported code "${String(fault.code)}"`);
      if (fault.kind === 'latency' && !(typeof fault.ms === 'number' && fault.ms >= 0 && Number.isFinite(fault.ms))) problems.push(`${where}: latency ms must be >= 0`);
      if (fault.kind === 'bad-tool-call' && !['unknown-tool', 'bad-args', 'extra-unknown'].includes(fault.mode)) problems.push(`${where}: unknown bad-tool-call mode "${String(fault.mode)}"`);
      if (fault.kind === 'finish-reason' && !['length', 'error', 'other'].includes(fault.reason)) problems.push(`${where}: unknown finish reason "${String(fault.reason)}"`);
      if (fault.kind === 'oversized' && fault.chars !== undefined && !isCount(fault.chars, 1)) problems.push(`${where}: oversized chars must be a positive integer`);
    });
  }
  if (problems.length > 0) fail('model', problems);
  return plan;
}

/** Per-rule bookkeeping: how many matching calls were seen and how many faults fired, with the rule's own generator. */
export interface RuleCursor {
  seen: number;
  fired: number;
  readonly rng: SeededRandom;
}

export function cursorsFor(plan: { seed: number | string; rules: readonly unknown[] }): RuleCursor[] {
  const root = seededRandom(plan.seed);
  return plan.rules.map((_, i) => ({ seen: 0, fired: 0, rng: root.fork(`rule-${i}`) }));
}

/**
 * Registers one matching call on the cursor and decides whether the rule fires. The probability draw is consumed on every
 * matching call, so the decisions of one rule never depend on whether another rule (or the `times` cap) fired.
 */
export function decide(trigger: RuleTrigger, cursor: RuleCursor): boolean {
  cursor.seen += 1;
  const roll = cursor.rng.next();
  if (trigger.times !== undefined && cursor.fired >= trigger.times) return false;
  if (trigger.nth !== undefined) {
    const list = Array.isArray(trigger.nth) ? trigger.nth : [trigger.nth];
    if (!list.includes(cursor.seen)) return false;
  }
  if (trigger.from !== undefined && cursor.seen < trigger.from) return false;
  if (trigger.probability !== undefined && !(roll < trigger.probability)) return false;
  cursor.fired += 1;
  return true;
}

/** What an injector did, in order. `detail` is a short human description. */
export interface ChaosEvent {
  seq: number;
  /** `create`, `observe`, ... for drivers; the purpose for models. */
  at: string;
  rule: number;
  fault: string;
  /** Driver session id, when the call belonged to a session. */
  session?: string;
  detail?: string;
}

export interface ChaosOptions {
  /** Used by `latency` and `timeout` faults. Default: a virtual sleep that yields one macrotask and records the delay (no real waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Called synchronously for every injected fault. */
  onEvent?: (event: ChaosEvent) => void;
  /**
   * A `hang` fault normally holds no handle, so a hung call cannot keep the process alive. With `keepAlive` it holds the event loop
   * open like a real stuck connection would; use it in spawned processes, where "the process never ends" is the thing under test.
   */
  keepAlive?: boolean;
}

/** Shared bookkeeping of an injector: the event log, the virtual delay and the default sleep. */
export function createRecorder(options: ChaosOptions): {
  events: ChaosEvent[];
  virtualDelayMs: () => number;
  sleep: (ms: number) => Promise<void>;
  record: (e: Omit<ChaosEvent, 'seq'>) => void;
} {
  const events: ChaosEvent[] = [];
  let delay = 0;
  return {
    events,
    virtualDelayMs: () => delay,
    sleep:
      options.sleep ??
      (async (ms) => {
        delay += Math.max(0, ms);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }),
    record(e) {
      const event: ChaosEvent = { seq: events.length + 1, ...e };
      events.push(event);
      options.onEvent?.(event);
    },
  };
}

/** A promise that never settles. It holds no timer unless `keepAlive` (see {@link ChaosOptions.keepAlive}). */
export function hang<T = never>(keepAlive = false): Promise<T> {
  return new Promise<T>(() => {
    if (keepAlive) setInterval(() => {}, 2 ** 30);
  });
}
