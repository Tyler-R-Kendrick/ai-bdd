import {
  APICallError,
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
  TypeValidationError,
  UnsupportedFunctionalityError,
} from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { AiBddError, type ModelMessage } from '@ai-bdd/sdk/contracts';
import { mapModelError } from '../src/errors.ts';
import { aiSdkModels, createModelSet } from '../src/index.ts';
import { toAiMessages } from '../src/messages.ts';
import { ACT_TOOLS, mockModel, mockProvider, request, textResult, toolCallResult } from './helpers.ts';

const ctx = { purpose: 'judge' as const, modelId: 'judge-model' };
const apiError = (over: { statusCode?: number; isRetryable?: boolean; message?: string } = {}) =>
  new APICallError({ message: over.message ?? 'boom', url: 'https://api.example.test', requestBodyValues: {}, ...over });

describe('mapModelError: passthrough and aborts', () => {
  it('returns an AiBddError unchanged (same object), whatever the context', () => {
    const own = new AiBddError('POLICY_DENIED', 'denied');
    expect(mapModelError(own, ctx)).toBe(own);
  });

  it('an aborted signal wins over the error shape: ABORTED, not retryable, with purpose, model and cause', () => {
    const ac = new AbortController();
    ac.abort();
    const cause = apiError({ statusCode: 500, isRetryable: true });
    const err = mapModelError(cause, { ...ctx, signal: ac.signal });
    expect(err.code).toBe('ABORTED');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('model call aborted (judge)');
    expect(err.details).toEqual({ purpose: 'judge', modelId: 'judge-model' });
    expect(err.cause).toBe(cause);
  });

  it('a signal that is not aborted does not by itself make the error an abort', () => {
    const err = mapModelError(new Error('network down'), { ...ctx, signal: new AbortController().signal });
    expect(err.code).toBe('MODEL_UNAVAILABLE');
  });

  it('a RetryError with reason "abort" is ABORTED even without a signal', () => {
    const retry = new RetryError({ message: 'aborted while retrying', reason: 'abort', errors: [new Error('x')] });
    const err = mapModelError(retry, ctx);
    expect(err.code).toBe('ABORTED');
    expect(err.cause).toBe(retry);
  });

  it('a RetryError with another reason is classified by its last error', () => {
    const retry = new RetryError({ message: 'gave up', reason: 'maxRetriesExceeded', errors: [new Error('first'), new Error('the last one')] });
    const err = mapModelError(retry, ctx);
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.message).toBe('model unavailable (judge/judge-model): the last one');
    expect(err.retryable).toBe(true);
  });

  it('an Error named AbortError (directly or as the last retry error) is ABORTED', () => {
    const e = Object.assign(new Error('stopped'), { name: 'AbortError' });
    expect(mapModelError(e, ctx).code).toBe('ABORTED');
    const wrapped = new RetryError({ message: 'm', reason: 'errorNotRetryable', errors: [e] });
    expect(mapModelError(wrapped, ctx).code).toBe('ABORTED');
  });

  it('a provider TimeoutError the caller did not ask for is a retryable outage, not an abort (an abort would end the whole run)', () => {
    const e = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const mapped = mapModelError(e, ctx);
    expect(mapped.code).toBe('MODEL_UNAVAILABLE');
    expect(mapped.retryable).toBe(true);
    const wrapped = new RetryError({ message: 'm', reason: 'maxRetriesExceeded', errors: [e] });
    expect(mapModelError(wrapped, ctx).code).toBe('MODEL_UNAVAILABLE');
  });

  it('an Error with another name and a non-Error object named AbortError are not aborts', () => {
    expect(mapModelError(Object.assign(new Error('x'), { name: 'RangeError' }), ctx).code).toBe('MODEL_UNAVAILABLE');
    expect(mapModelError({ name: 'AbortError' }, ctx).code).toBe('MODEL_UNAVAILABLE');
  });
});

describe('mapModelError: unavailable models', () => {
  it.each([
    ['a string', 'plain failure', 'plain failure'],
    ['a number', 503, '503'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
  ])('%s is stringified, retryable, with the context in the message', (_label, thrown, text) => {
    const err = mapModelError(thrown, ctx);
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(`model unavailable (judge/judge-model): ${text}`);
    expect(err.cause).toBe(thrown);
  });

  it('records the HTTP status code only when the provider error has one', () => {
    expect(mapModelError(apiError({ statusCode: 429 }), ctx).details).toEqual({ purpose: 'judge', modelId: 'judge-model', statusCode: 429 });
    const noStatus = mapModelError(apiError(), ctx);
    expect(noStatus.details).toEqual({ purpose: 'judge', modelId: 'judge-model' });
    expect(Object.hasOwn(noStatus.details as object, 'statusCode')).toBe(false);
  });

  it('keeps the status code of the last error of a RetryError', () => {
    const retry = new RetryError({ message: 'm', reason: 'maxRetriesExceeded', errors: [apiError({ statusCode: 500 }), apiError({ statusCode: 503 })] });
    expect(mapModelError(retry, ctx).details).toMatchObject({ statusCode: 503 });
  });

  it.each([
    ['LoadAPIKeyError', () => new LoadAPIKeyError({ message: 'OPENAI_API_KEY is missing' })],
    ['LoadSettingError', () => new LoadSettingError({ message: 'region is missing' })],
    ['NoSuchModelError', () => new NoSuchModelError({ modelId: 'x', modelType: 'languageModel' })],
    ['UnsupportedFunctionalityError', () => new UnsupportedFunctionalityError({ functionality: 'tool calling' })],
    ['InvalidPromptError', () => new InvalidPromptError({ prompt: 'p', message: 'bad prompt' })],
    ['InvalidArgumentError', () => new InvalidArgumentError({ parameter: 'temperature', value: 9, message: 'too hot' })],
  ])('%s is a permanent failure: MODEL_UNAVAILABLE, not retryable', (_name, make) => {
    const cause = make();
    const err = mapModelError(cause, ctx);
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain(cause.message);
  });

  it('the same classes wrapped in a RetryError stay permanent', () => {
    const retry = new RetryError({ message: 'm', reason: 'errorNotRetryable', errors: [new LoadAPIKeyError({ message: 'no key' })] });
    expect(mapModelError(retry, ctx).retryable).toBe(false);
  });

  it('generic errors are retryable; a provider error is retryable exactly when the provider says so', () => {
    for (const e of [new Error('ECONNRESET'), new TypeError('fetch failed'), apiError({ statusCode: 503, isRetryable: true })]) {
      expect(mapModelError(e, ctx).retryable).toBe(true);
    }
    expect(mapModelError(apiError({ statusCode: 400, isRetryable: false }), ctx).retryable).toBe(false);
  });
});
