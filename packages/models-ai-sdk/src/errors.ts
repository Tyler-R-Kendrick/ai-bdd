import {
  InvalidArgumentError,
  InvalidPromptError,
  InvalidResponseDataError,
  InvalidToolInputError,
  JSONParseError,
  LoadAPIKeyError,
  LoadSettingError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  NoSuchModelError,
  NoSuchToolError,
  RetryError,
  ToolChoiceViolationError,
  TypeValidationError,
  UnsupportedFunctionalityError,
  APICallError,
} from 'ai';
import { AiBddError, type JsonObject, type ModelPurpose } from '@ai-bdd/sdk/contracts';

export interface ErrorContext {
  purpose: ModelPurpose;
  modelId: string;
  signal?: AbortSignal | undefined;
}

/** Errors that mean "the model answered, but not with something usable". */
function isOutputInvalid(error: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    NoContentGeneratedError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    InvalidToolInputError.isInstance(error) ||
    NoSuchToolError.isInstance(error) ||
    ToolChoiceViolationError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error)
  );
}

/** Errors that no retry can fix (bad credentials, unknown model, unsupported feature, bad request). */
function isPermanent(error: unknown): boolean {
  return (
    LoadAPIKeyError.isInstance(error) ||
    LoadSettingError.isInstance(error) ||
    NoSuchModelError.isInstance(error) ||
    UnsupportedFunctionalityError.isInstance(error) ||
    InvalidPromptError.isInstance(error) ||
    InvalidArgumentError.isInstance(error)
  );
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (RetryError.isInstance(error) && error.reason === 'abort') return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps whatever `generateText` threw to an {@link AiBddError}.
 * The original error is always preserved as `cause`.
 */
export function mapModelError(error: unknown, ctx: ErrorContext): AiBddError {
  if (error instanceof AiBddError) return error;
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  const details: JsonObject = { purpose: ctx.purpose, modelId: ctx.modelId };

  if (isAbort(error, ctx.signal) || isAbort(inner, ctx.signal)) {
    return new AiBddError('ABORTED', `model call aborted (${ctx.purpose})`, { details, cause: error });
  }
  if (isOutputInvalid(inner)) {
    if (NoObjectGeneratedError.isInstance(inner) && inner.finishReason !== undefined) {
      details.finishReason = inner.finishReason;
    }
    return new AiBddError(
      'MODEL_OUTPUT_INVALID',
      `model returned invalid output (${ctx.purpose}/${ctx.modelId}): ${messageOf(inner)}`,
      { details, cause: error },
    );
  }
  if (APICallError.isInstance(inner)) {
    if (inner.statusCode !== undefined) details.statusCode = inner.statusCode;
  }
  const permanent = isPermanent(inner);
  return new AiBddError(
    'MODEL_UNAVAILABLE',
    `model unavailable (${ctx.purpose}/${ctx.modelId}): ${messageOf(inner)}`,
    { retryable: !permanent, details, cause: error },
  );
}

