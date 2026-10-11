import {
  AiBddError,
  ERROR_CODES,
  type AiBddErrorPayload,
  type ErrorCode,
  type JsonValue,
  type Observation,
  type Redactor,
  type ScenarioStatus,
  type StepStatus,
  type Usage,
} from '../contracts/index.ts';

/** Prompt versions stamped on recordings (S-AGENT / S-ASSERT / S-JUDGE own the prompts; values fixed by the spec). */
export const PROMPT_VERSIONS = { act: 'act-v1', checkgen: 'checkgen-v1', judge: 'judge-v1' } as const;

const RANK: Record<StepStatus, number> = {
  skipped: 0,
  passed: 1,
  healed: 2,
  blocked: 3,
  inconclusive: 4,
  failed: 5,
  error: 6,
};

/** Precedence error > failed > inconclusive > blocked > healed > passed > skipped (§9.7). */
export function aggregateStatus(statuses: readonly StepStatus[]): ScenarioStatus {
  let best: StepStatus = 'skipped';
  for (const s of statuses) if (RANK[s] > RANK[best]) best = s;
  return best;
}

export function zeroUsage(): Usage {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
}

export function addUsage(into: Usage, add: Usage | undefined): void {
  if (!add) return;
  into.modelCalls += add.modelCalls;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
}

export function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** JSON round trip so interface-typed values can be stored in `details`. */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function makePayload(code: ErrorCode, message: string, details?: unknown): AiBddErrorPayload {
  const p: AiBddErrorPayload = { code, message, retryable: false };
  if (details !== undefined) p.details = toJson(details);
  return p;
}

export function errorPayload(err: unknown): AiBddErrorPayload {
  if (err instanceof AiBddError) return err.toPayload();
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; message?: unknown; name?: unknown; retryable?: unknown; details?: unknown };
    if (typeof e.code === 'string' && CODE_SET.has(e.code) && typeof e.message === 'string') {
      const p: AiBddErrorPayload = { code: e.code as ErrorCode, message: e.message, retryable: e.retryable === true };
      if (e.details !== undefined) p.details = toJson(e.details);
      return p;
    }
    if (e.name === 'AbortError') return makePayload('ABORTED', typeof e.message === 'string' ? e.message : 'aborted');
  }
  return makePayload('INTERNAL', err instanceof Error ? err.message : String(err));
}

/** Secret values must not leak through error text (R-SE1). */
export function redactPayload(redactor: Redactor, p: AiBddErrorPayload): AiBddErrorPayload {
  const out: AiBddErrorPayload = { code: p.code, message: redactor.redact(p.message), retryable: p.retryable };
  if (p.details !== undefined) out.details = redactor.redactJson(p.details);
  return out;
}

/** The directive `fuzzy` is carried as the scenario tag `@fuzzy` (§8.4.6). */
export function isFuzzyTagged(tags: readonly string[]): boolean {
  return tags.some((t) => t === '@fuzzy' || t === 'fuzzy');
}

/** Single-slot cache of the most recent settled observation; invalidated by anything that can change the page. */
export class ObservationRing {
  private obs: Observation | undefined;

  remember(obs: Observation, settled: boolean): void {
    this.obs = settled ? obs : undefined;
  }

  invalidate(): void {
    this.obs = undefined;
  }

  take(needPixels: boolean): Observation | undefined {
    const o = this.obs;
    if (o === undefined) return undefined;
    if (needPixels && o.screenshot === undefined) return undefined;
    return o;
  }
}
