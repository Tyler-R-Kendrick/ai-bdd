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

  it('a TimeoutError the caller did not ask for is the provider timing out: MODEL_UNAVAILABLE, retryable', () => {
    const e = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const err = mapModelError(e, ctx);
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
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

  it('transient provider errors and generic errors are retryable; a provider-classified permanent failure is not', () => {
    for (const e of [apiError({ statusCode: 503, isRetryable: true }), new Error('ECONNRESET'), new TypeError('fetch failed')]) {
      expect(mapModelError(e, ctx).retryable).toBe(true);
    }
    expect(mapModelError(apiError({ statusCode: 400, isRetryable: false }), ctx).retryable).toBe(false);
  });
});

describe('mapModelError: unusable output', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never;
  const response = { id: 'r', timestamp: new Date(0), modelId: 'm' } as never;

  it.each([
    ['NoOutputGeneratedError', () => new NoOutputGeneratedError()],
    ['NoContentGeneratedError', () => new NoContentGeneratedError({})],
    ['JSONParseError', () => new JSONParseError({ text: '{', cause: new Error('bad') })],
    ['TypeValidationError', () => new TypeValidationError({ value: 1, cause: new Error('bad') })],
    ['InvalidToolInputError', () => new InvalidToolInputError({ toolName: 'click', toolInput: '{', cause: new Error('bad') })],
    ['NoSuchToolError', () => new NoSuchToolError({ toolName: 'teleport' })],
    ['InvalidResponseDataError', () => new InvalidResponseDataError({ data: {}, message: 'garbled' })],
  ])('%s -> MODEL_OUTPUT_INVALID, not retryable, no finish reason', (_name, make) => {
    const cause = make();
    const err = mapModelError(cause, ctx);
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ purpose: 'judge', modelId: 'judge-model' });
    expect(err.message).toBe(`model returned invalid output (judge/judge-model): ${cause.message}`);
  });

  it('NoObjectGeneratedError records the finish reason when it has one', () => {
    const e = new NoObjectGeneratedError({ message: 'no object', text: 'x', response, usage, finishReason: 'length' });
    const err = mapModelError(e, ctx);
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.details).toEqual({ purpose: 'judge', modelId: 'judge-model', finishReason: 'length' });
  });

  it('NoObjectGeneratedError without a finish reason records none', () => {
    const e = new NoObjectGeneratedError({ message: 'no object', text: 'x', response, usage, finishReason: undefined as never });
    const err = mapModelError(e, ctx);
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(Object.hasOwn(err.details as object, 'finishReason')).toBe(false);
  });

  it('an output error inside a RetryError is still output-invalid and the RetryError is the cause', () => {
    const inner = new JSONParseError({ text: '{', cause: new Error('bad') });
    const retry = new RetryError({ message: 'm', reason: 'maxRetriesExceeded', errors: [inner] });
    const err = mapModelError(retry, ctx);
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.cause).toBe(retry);
  });
});

describe('toAiMessages', () => {
  const user = (...parts: Extract<ModelMessage, { role: 'user' }>['content']): ModelMessage => ({ role: 'user', content: parts });
  const assistant = (content: Extract<ModelMessage, { role: 'assistant' }>['content'], toolCalls?: { id: string; name: string; args: Record<string, never> }[]): ModelMessage =>
    ({ role: 'assistant', content, ...(toolCalls === undefined ? {} : { toolCalls }) }) as ModelMessage;

  it('drops empty text parts but keeps the message (and its role) even when nothing is left', () => {
    expect(toAiMessages([user({ type: 'text', text: '' }, { type: 'text', text: 'kept' }, { type: 'text', text: '' })])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    ]);
    expect(toAiMessages([user({ type: 'text', text: '' })])).toEqual([{ role: 'user', content: [] }]);
  });

  it('maps images to png file parts in place, between text parts', () => {
    const png = new Uint8Array([1, 2, 3]);
    expect(toAiMessages([user({ type: 'text', text: 'a' }, { type: 'image', png, sha256: 'h' }, { type: 'text', text: 'b' })])).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'file', mediaType: 'image/png', data: png }, { type: 'text', text: 'b' }] },
    ]);
  });

  it('assistant messages: text then tool calls; calls-only; text-only; and nothing at all is skipped', () => {
    const out = toAiMessages([
      assistant([{ type: 'text', text: 'thinking' }], [{ id: 'c1', name: 'click', args: {} }, { id: 'c2', name: 'wait', args: {} }]),
      assistant([], [{ id: 'c3', name: 'click', args: {} }]),
      assistant([{ type: 'text', text: 'only text' }]),
      assistant([{ type: 'text', text: '' }]),
      assistant([], []),
      assistant([]),
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'click', input: {} },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'wait', input: {} },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'click', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'only text' }] },
    ]);
  });

  it('tool messages become a single json tool-result part, and the message order is preserved', () => {
    const out = toAiMessages([
      user({ type: 'text', text: 'go' }),
      { role: 'tool', toolCallId: 'c1', toolName: 'click', result: { ok: true, n: [1, 2] } } as ModelMessage,
      user({ type: 'text', text: 'again' }),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'tool', 'user']);
    expect(out[1]).toEqual({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'click', output: { type: 'json', value: { ok: true, n: [1, 2] } } }],
    });
  });

  it('no messages, no output', () => {
    expect(toAiMessages([])).toEqual([]);
  });
});

describe('generate: request and response edge cases', () => {
  const setOf = (m: ReturnType<typeof mockModel>, opts?: { maxRetries?: number }) => aiSdkModels({ extract: m, act: m, checkgen: m, judge: m }, opts);

  it('an empty system prompt sends no system message at all', async () => {
    const m = mockModel(textResult('ok'));
    await setOf(m).act.generate(request({ system: '' }));
    expect(m.doGenerateCalls[0]?.prompt.some((p) => p.role === 'system')).toBe(false);
    expect(m.doGenerateCalls[0]?.prompt.map((p) => p.role)).toEqual(['user']);
  });

  it('a non-empty system prompt is the first message', async () => {
    const m = mockModel(textResult('ok'));
    await setOf(m).act.generate(request({ system: 'Be brief.' }));
    expect(m.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: 'Be brief.' });
  });

  it.each([
    ['an array', [1, 2]],
    ['a string', 'text'],
    ['a number', 5],
    ['null', null],
  ])('a tool call whose arguments are %s is MODEL_OUTPUT_INVALID naming the tool, without a cause', async (_label, input) => {
    const m = mockModel(toolCallResult([{ id: 'c1', name: 'click', input }]));
    let error: unknown;
    try {
      await setOf(m).act.generate(request({ tools: ACT_TOOLS }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AiBddError);
    const err = error as AiBddError;
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.message).toBe('model emitted an invalid tool call "click" (act/mock-model)');
    expect(err.details).toEqual({ purpose: 'act', modelId: 'mock-model', toolName: 'click' });
    expect(err.retryable).toBe(false);
  });

  it('a valid tool call is returned with its id, name and arguments', async () => {
    const m = mockModel(toolCallResult([{ id: 'c1', name: 'click', input: { ref: 'e7' } }]));
    const res = await setOf(m).act.generate(request({ tools: ACT_TOOLS }));
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'click', args: { ref: 'e7' } }]);
    expect(res.finishReason).toBe('tool-calls');
  });
});

describe('createModelSet: maxRetries', () => {
  const ids = { extract: 'p/a', act: 'p/b', checkgen: 'p/c', judge: 'p/d' };
  const previous = globalThis.AI_SDK_DEFAULT_PROVIDER;
  afterEach(() => {
    globalThis.AI_SDK_DEFAULT_PROVIDER = previous;
  });

  it('maxRetries: 0 reaches the AI SDK, so a retryable error is attempted exactly once', async () => {
    const m = mockModel(() => Promise.reject(apiError({ statusCode: 503, isRetryable: true })), 'p/b');
    globalThis.AI_SDK_DEFAULT_PROVIDER = mockProvider({ 'p/b': m, 'p/a': m, 'p/c': m, 'p/d': m });
    const set = createModelSet({ ...ids, maxRetries: 0 });
    await expect(set.act.generate(request())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
    expect(m.doGenerateCalls).toHaveLength(1);
  });

  it.each([
    ['a fraction', 1.5],
    ['a negative number', -1],
    ['a numeric string', '2'],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
  ])('maxRetries as %s is CONFIG_INVALID naming the key', (_label, maxRetries) => {
    let error: unknown;
    try {
      createModelSet({ ...ids, maxRetries });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AiBddError);
    expect((error as AiBddError).code).toBe('CONFIG_INVALID');
    expect((error as AiBddError).message).toBe('models option "maxRetries" must be a non-negative integer');
    expect((error as AiBddError).details).toEqual({ key: 'maxRetries' });
  });

  it('an unknown option and a bad purpose are CONFIG_INVALID with the offending key in the details', () => {
    expect(() => createModelSet({ ...ids, retries: 1 })).toThrow('unknown models option "retries"');
    try {
      createModelSet({ ...ids, judge: '' });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as AiBddError).details).toEqual({ key: 'judge' });
      expect((e as AiBddError).message).toBe('models option "judge" must be a non-empty model id string');
    }
  });

  it('a missing maxRetries leaves the AI SDK default in place (a model set is built)', () => {
    const set = createModelSet(ids);
    expect(set.judge.id).toBe('p/d');
  });
});

describe('aiSdkModels: model values', () => {
  it('accepts an AI SDK model object or a non-empty string, and rejects everything else naming the purpose', () => {
    const m = mockModel(textResult('x'));
    const base = { extract: m, act: m, checkgen: m, judge: m };
    expect(aiSdkModels({ ...base, judge: 'some/judge' }).judge.id).toBe('some/judge');
    for (const bad of ['', 5, null, undefined, {}, [], { id: 'x' }]) {
      let error: unknown;
      try {
        aiSdkModels({ ...base, checkgen: bad as never });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AiBddError);
      expect((error as AiBddError).code).toBe('CONFIG_INVALID');
      expect((error as AiBddError).message).toBe('models.checkgen must be a model id string or an AI SDK language model');
      expect((error as AiBddError).details).toEqual({ purpose: 'checkgen' });
    }
  });
});
