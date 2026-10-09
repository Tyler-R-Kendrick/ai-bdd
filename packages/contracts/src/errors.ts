import type { JsonValue } from './primitives.js';

export type ErrorGroup =
  | 'parse'
  | 'config'
  | 'resolution'
  | 'act'
  | 'assert'
  | 'driver'
  | 'model'
  | 'daemon'
  | 'evidence'
  | 'internal';

export interface ErrorCodeInfo {
  group: ErrorGroup;
  retryable: boolean;
  message: string;
  /** Reserved codes exist in the taxonomy but are not reachable yet (section 17). */
  reserved?: boolean;
}

/**
 * The single source of truth for error codes. docs/errors.md is generated from
 * this table, and a test asserts the document is in sync (section 9.3).
 */
export const ERROR_CODES = {
  // Parse
  GAUGE_NO_SPEC_HEADING: { group: 'parse', retryable: false, message: 'The spec file has no spec heading.' },
  GAUGE_MULTIPLE_SPEC_HEADINGS: { group: 'parse', retryable: false, message: 'The spec file has more than one spec heading.' },
  GAUGE_DUPLICATE_SCENARIO: { group: 'parse', retryable: false, message: 'Two scenarios in one spec share a name.' },
  GAUGE_UNRESOLVED_PARAM: { group: 'parse', retryable: false, message: 'A dynamic step parameter could not be resolved.' },
  GAUGE_CONCEPT_CYCLE: { group: 'parse', retryable: false, message: 'Concept expansion is recursive.' },
  GHERKIN_PARSE: { group: 'parse', retryable: false, message: 'The Gherkin document could not be parsed.' },
  DIRECTIVE_UNKNOWN_KEY: { group: 'parse', retryable: false, message: 'The directive uses an unknown key.' },
  DIRECTIVE_INVALID_VALUE: { group: 'parse', retryable: false, message: 'The directive uses an invalid value.' },
  DIRECTIVE_ORPHAN: { group: 'parse', retryable: false, message: 'The directive is not attached to a step, scenario, or spec.' },

  // Config
  CONFIG_UNKNOWN_KEY: { group: 'config', retryable: false, message: 'The configuration contains an unknown key.' },
  CONFIG_INVALID: { group: 'config', retryable: false, message: 'The configuration is invalid.' },
  CONFIG_TS_UNSUPPORTED: { group: 'config', retryable: false, message: 'This Node runtime cannot load a TypeScript config file.' },
  SECRET_TOO_SHORT: { group: 'config', retryable: false, message: 'A secret value is shorter than 4 characters.' },

  // Resolution
  STEP_AMBIGUOUS: { group: 'resolution', retryable: false, message: 'More than one binding matches the step.' },
  RESOLUTION_NOT_LOCKED: { group: 'resolution', retryable: false, message: 'The step is not present in the lockfile (--frozen).' },
  SETUP_UNBOUND: { group: 'resolution', retryable: false, message: 'A setup step has no binding.' },
  PARAM_EXTRACTION_FAILED: { group: 'resolution', retryable: false, message: 'Parameter extraction failed validation.' },

  // Act
  ACT_BUDGET_EXHAUSTED: { group: 'act', retryable: false, message: 'The act agent exhausted its action or model budget.' },
  ACT_TARGET_AMBIGUOUS: { group: 'act', retryable: false, message: 'Grounding produced more than one candidate target.' },
  ACT_BLOCKED: { group: 'act', retryable: false, message: 'The act agent reported that it is blocked.' },
  CACHE_REPLAY_DIVERGED: { group: 'act', retryable: false, message: 'A cached act program was healed (--strict-cache).' },

  // Assert
  CHECK_FAILED: { group: 'assert', retryable: false, message: 'A deterministic check predicate was not satisfied.' },
  CHECK_NOT_DISCRIMINATIVE: { group: 'assert', retryable: false, message: 'A generated check is true on both before and after.' },
  CHECK_GENERATION_FAILED: { group: 'assert', retryable: false, message: 'No discriminative check could be generated.' },
  JUDGE_FAILED: { group: 'assert', retryable: false, message: 'The judge verdict was fail.' },
  JUDGE_INCONCLUSIVE: { group: 'assert', retryable: false, message: 'The judge verdict was inconclusive.' },
  SCREEN_NOT_SETTLED: { group: 'assert', retryable: false, message: 'The screen did not settle before the deadline.' },

  // Driver
  DRIVER_UNAVAILABLE: { group: 'driver', retryable: true, message: 'The driver could not be started.' },
  DRIVER_INCOMPATIBLE: { group: 'driver', retryable: false, message: 'The driver is missing a required tool or parameter.' },
  SESSION_LIMIT: { group: 'driver', retryable: true, message: 'The driver reached its session limit.' },
  RESOURCE_LOCKED: { group: 'driver', retryable: true, message: 'An exclusive driver resource is held by another scenario.' },
  POLICY_DENIED: { group: 'driver', retryable: false, message: 'Policy denied the action or navigation.' },
  PIXEL_TAINTED: { group: 'driver', retryable: false, message: 'Pixels are withheld because the observation is tainted.' },

  // Model
  MODEL_UNAVAILABLE: { group: 'model', retryable: true, message: 'The model provider is unreachable.' },
  MODEL_OUTPUT_INVALID: { group: 'model', retryable: false, message: 'The model returned output that failed validation.' },

  // Daemon
  DAEMON_UNAUTHORIZED: { group: 'daemon', retryable: false, message: 'Missing or invalid bearer token.' },
  NO_SESSION: { group: 'daemon', retryable: false, message: 'The session id is unknown or expired.' },
  INVALID_ARGUMENT: { group: 'daemon', retryable: false, message: 'The request failed schema validation.' },

  // Evidence
  EVIDENCE_TAMPERED: { group: 'evidence', retryable: false, message: 'Evidence verification found a mismatch.' },

  // Internal
  INTERNAL: { group: 'internal', retryable: false, message: 'An unexpected internal error occurred.' },
} as const satisfies Record<string, ErrorCodeInfo>;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface AiBddErrorPayload {
  code: ErrorCode | string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
  group?: ErrorGroup;
}

export class AiBddError extends Error {
  readonly code: ErrorCode | string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
  readonly group?: ErrorGroup;

  constructor(
    code: ErrorCode | string,
    message?: string,
    options: { retryable?: boolean; details?: JsonValue; cause?: unknown } = {},
  ) {
    const info: ErrorCodeInfo | undefined = (ERROR_CODES as Record<string, ErrorCodeInfo>)[code];
    super(message ?? info?.message ?? code);
    this.name = 'AiBddError';
    this.code = code;
    this.retryable = options.retryable ?? info?.retryable ?? false;
    this.group = info?.group;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  static isAiBddError(value: unknown): value is AiBddError {
    return value instanceof AiBddError;
  }

  static from(value: unknown): AiBddError {
    if (value instanceof AiBddError) return value;
    if (value instanceof Error) return new AiBddError('INTERNAL', value.message, { cause: value });
    return new AiBddError('INTERNAL', String(value));
  }

  toPayload(): AiBddErrorPayload {
    const payload: AiBddErrorPayload = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) payload.details = this.details;
    if (this.group !== undefined) payload.group = this.group;
    return payload;
  }

  static payload(error: unknown): AiBddErrorPayload {
    return AiBddError.from(error).toPayload();
  }
}

export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/** Exit codes defined in section 9.2. */
export const EXIT_CODES = {
  ok: 0,
  failure: 1,
  usage: 2,
  infrastructure: 3,
  frozen: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
