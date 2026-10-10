// @ts-nocheck
import { APICallError, JSONParseError, RetryError, TypeValidationError } from 'ai';
import { describe, expect, it } from 'vitest';
import { AiBddError, RETRYABLE_CODES } from '@ai-bdd/sdk/contracts';
import { aiSdkModels } from '../src/index.ts';
import { ACT_TOOLS, mockModel, mockProvider, request, textResult, toolCallResult } from './helpers.ts';

function actModel(m: ReturnType<typeof mockModel>, maxRetries = 0) {
  return aiSdkModels({ extract: m, act: m, checkgen: m, judge: m }, { maxRetries }).act;
}

async function failure(p: Promise<unknown>): Promise<AiBddError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AiBddError);
    return e as AiBddError;
  }
  throw new Error('expected rejection');
}

function apiError(statusCode: number, isRetryable: boolean, message = 'boom') {
  return new APICallError({ message, url: 'https://api.example.test/v1', requestBodyValues: {}, statusCode, isRetryable });
}

describe('provider errors -> MODEL_UNAVAILABLE', () => {
  it('maps a rate limit (429) and preserves the cause', async () => {
    const cause = apiError(429, true, 'rate limited');
    const m = mockModel(() => Promise.reject(cause));
    const err = await failure(actModel(m).generate(request()));
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(RETRYABLE_CODES.has(err.code)).toBe(true);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('rate limited');
    expect(err.details).toMatchObject({ purpose: 'act', statusCode: 429 });
  });

  it('maps a 500 provider error', async () => {
    const m = mockModel(() => Promise.reject(apiError(500, true)));
    const err = await failure(actModel(m).generate(request()));
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });

  it('maps a raw network failure', async () => {
    const cause = new TypeError('fetch failed');
    const m = mockModel(() => Promise.reject(cause));
    const err = await failure(actModel(m).generate(request()));
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(cause);
  });

  it('unwraps RetryError to classify by the last error while keeping it as cause', async () => {
    const last = apiError(503, true, 'overloaded');
    const retry = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [last, last, last] });
    const m = mockModel(() => Promise.reject(retry));
    const err = await failure(actModel(m).generate(request()));
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.cause).toBe(retry);
    expect(err.message).toContain('overloaded');
  });

  it('marks configuration-class failures (unknown model id) as non-retryable', async () => {
    const previous = globalThis.AI_SDK_DEFAULT_PROVIDER;
    globalThis.AI_SDK_DEFAULT_PROVIDER = mockProvider({});
    try {
      const set = aiSdkModels({ extract: 'x/none', act: 'x/none', checkgen: 'x/none', judge: 'x/none' });
      const err = await failure(set.act.generate(request()));
      expect(err.code).toBe('MODEL_UNAVAILABLE');
      expect(err.retryable).toBe(false);
    } finally {
      globalThis.AI_SDK_DEFAULT_PROVIDER = previous;
    }
  });
});

describe('output errors -> MODEL_OUTPUT_INVALID', () => {
  it('maps unparsable structured output', async () => {
    const m = mockModel(textResult('this is not json', { finish: 'stop' }));
    const err = await failure(
      actModel(m).generate(request({ output: { name: 'o', schema: { type: 'object' } } })),
    );
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.retryable).toBe(false);
    expect(err.cause).toBeDefined();
    expect(err.details).toMatchObject({ purpose: 'act', finishReason: 'stop' });
  });

  it('maps truncated structured output (length) and records the finish reason', async () => {
    const m = mockModel(textResult('{"a": [1, 2', { finish: 'length' }));
    const err = await failure(
      actModel(m).generate(request({ output: { name: 'o', schema: { type: 'object' } } })),
    );
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.details).toMatchObject({ finishReason: 'length' });
  });

  it('maps an AI SDK JSON parse / type validation failure thrown by the provider layer', async () => {
    const parse = new JSONParseError({ text: '{', cause: new Error('bad') });
    const m1 = mockModel(() => Promise.reject(parse));
    expect((await failure(actModel(m1).generate(request()))).code).toBe('MODEL_OUTPUT_INVALID');
    const validation = new TypeValidationError({ value: 1, cause: new Error('bad') });
    const m2 = mockModel(() => Promise.reject(validation));
    expect((await failure(actModel(m2).generate(request()))).code).toBe('MODEL_OUTPUT_INVALID');
  });

  it('maps a tool call whose arguments are not JSON', async () => {
    const m = mockModel(toolCallResult([{ id: 'c', name: 'click', input: '{not json' }]));
    const err = await failure(actModel(m).generate(request({ tools: ACT_TOOLS })));
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
    expect(err.details).toMatchObject({ toolName: 'click' });
  });

  it('maps a tool call to an unknown tool', async () => {
    const m = mockModel(toolCallResult([{ id: 'c', name: 'teleport', input: {} }]));
    const err = await failure(actModel(m).generate(request({ tools: ACT_TOOLS })));
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
  });

  it('maps a missing tool call when a tool call was required', async () => {
    const m = mockModel(textResult('I refuse to call tools'));
    const err = await failure(
      actModel(m).generate(request({ tools: ACT_TOOLS, toolChoice: 'required' })),
    );
    expect(err.code).toBe('MODEL_OUTPUT_INVALID');
  });
});

describe('retries and aborts', () => {
  it('passes maxRetries through (0 means a single attempt)', async () => {
    const m = mockModel(() => Promise.reject(apiError(503, true)));
    await failure(actModel(m, 0).generate(request()));
    expect(m.doGenerateCalls).toHaveLength(1);
  });

  it('retries retryable provider errors when maxRetries allows it', async () => {
    let n = 0;
    const m = mockModel(() => {
      n += 1;
      return n === 1 ? Promise.reject(apiError(503, true)) : Promise.resolve(textResult('recovered'));
    });
    const res = await actModel(m, 1).generate(request());
    expect(res.text).toBe('recovered');
    expect(m.doGenerateCalls).toHaveLength(2);
  }, 15_000);

  it('maps an already-aborted call to ABORTED', async () => {
    const ac = new AbortController();
    ac.abort();
    const m = mockModel(({ abortSignal }) => {
      abortSignal?.throwIfAborted();
      return Promise.resolve(textResult('never'));
    });
    const err = await failure(actModel(m).generate(request({ signal: ac.signal })));
    expect(err.code).toBe('ABORTED');
    expect(err.retryable).toBe(false);
  });

  it('maps an abort during the call to ABORTED', async () => {
    const ac = new AbortController();
    const m = mockModel(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
          setTimeout(() => ac.abort(), 5);
        }),
    );
    const err = await failure(actModel(m).generate(request({ signal: ac.signal })));
    expect(err.code).toBe('ABORTED');
  });
});
