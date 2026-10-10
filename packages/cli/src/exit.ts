import { AiBddError, type ErrorCode, type ExitCode } from '@ai-bdd/sdk/contracts';

/**
 * Error code to process exit code (R-RN3, §5.1).
 * 1 = test-outcome style problems, 2 = usage/config/doc errors, 3 = infrastructure, 4 = frozen violation.
 * Declared as an exhaustive record so that adding an `ErrorCode` forces a decision here.
 */
export const EXIT_BY_ERROR_CODE: Record<ErrorCode, ExitCode> = {
  USAGE: 2,
  CONFIG_INVALID: 2,
  CONFIG_NOT_FOUND: 2,
  CONFIG_TS_UNSUPPORTED: 2,
  SECRET_MISSING: 2,
  SECRET_TOO_SHORT: 2,
  DOC_READ_FAILED: 2,
  DOC_CHUNK_TOO_LARGE: 2,
  DIRECTIVE_INVALID: 2,
  DIRECTIVE_UNKNOWN_KEY: 2,
  EXTRACT_MODEL_OUTPUT_INVALID: 1,
  EXTRACT_UNGROUNDED: 1,
  EXTRACT_QUOTE_NOT_FOUND: 1,
  EXTRACT_FIXTURE_INVALID: 1,
  EXTRACT_SECTION_FAILED: 1,
  PLAN_STALE: 4,
  PLAN_CORRUPT: 2,
  PLAN_SCHEMA_UNSUPPORTED: 2,
  PLAN_PINNED_STALE: 1,
  PLAN_CONTEXT_CHANGED: 1,
  SCENARIO_NOT_FOUND: 2,
  FIXTURE_REQUIRED: 1,
  FIXTURE_FAILED: 1,
  ACT_BUDGET_EXHAUSTED: 1,
  ACT_BLOCKED: 1,
  ACT_TARGET_AMBIGUOUS: 1,
  ACT_NO_AGENT: 1,
  REPLAY_DIVERGED: 1,
  CHARACTERIZATION_UNSTABLE: 1,
  CHECK_FAILED: 1,
  CHECK_NOT_DISCRIMINATIVE: 1,
  CHECK_LINT_FAILED: 1,
  CHECK_GENERATION_FAILED: 1,
  CHECK_JUDGE_DISAGREEMENT: 1,
  JUDGE_FAILED: 1,
  JUDGE_INCONCLUSIVE: 1,
  JUDGE_SAME_AS_ACTOR: 2,
  SCREEN_NOT_SETTLED: 1,
  DRIVER_UNAVAILABLE: 3,
  DRIVER_ERROR: 3,
  STALE_REF: 3,
  TARGET_NOT_FOUND: 3,
  POLICY_DENIED: 2,
  PIXEL_TAINTED: 3,
  SESSION_LIMIT: 3,
  VERB_UNSUPPORTED: 3,
  MODEL_UNAVAILABLE: 3,
  MODEL_OUTPUT_INVALID: 3,
  MODEL_NO_RULE: 3,
  RECORDING_CORRUPT: 2,
  RECORDING_READ_ONLY: 2,
  EVIDENCE_CORRUPT: 1,
  NOT_IMPLEMENTED: 3,
  INTERNAL: 3,
  ABORTED: 3,
};

/** Duck-typed so an error from a second copy of the contracts module is still recognized. */
export function asAiBddError(e: unknown): AiBddError | undefined {
  if (e instanceof AiBddError) return e;
  if (
    e instanceof Error &&
    e.name === 'AiBddError' &&
    typeof (e as unknown as { code?: unknown }).code === 'string' &&
    (e as unknown as { code: string }).code in EXIT_BY_ERROR_CODE
  ) {
    return e as AiBddError;
  }
  return undefined;
}

export function hasErrorCode(e: unknown, code: ErrorCode): boolean {
  return asAiBddError(e)?.code === code;
}

export function exitCodeForError(e: unknown): ExitCode {
  const err = asAiBddError(e);
  return err ? EXIT_BY_ERROR_CODE[err.code] : 3;
}

/** The larger of two exit codes by §5.1 precedence: 4 and 2 are pre-run failures, then 3 over 1 over 0. */
export function worstExit(a: ExitCode, b: ExitCode): ExitCode {
  const rank: Record<ExitCode, number> = { 0: 0, 1: 1, 3: 2, 2: 3, 4: 4 };
  return rank[a] >= rank[b] ? a : b;
}

export function describeError(e: unknown, debug: boolean): string {
  const err = asAiBddError(e);
  if (err) return `ai-bdd: error [${err.code}]: ${err.message}`;
  const message = e instanceof Error ? e.message : String(e);
  const stack = debug && e instanceof Error && e.stack ? `\n${e.stack}` : '';
  return `ai-bdd: internal error: ${message}${stack}`;
}
