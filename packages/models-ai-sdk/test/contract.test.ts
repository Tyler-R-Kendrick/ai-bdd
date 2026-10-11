import { APICallError } from 'ai';
import type { MockLanguageModelV4 } from 'ai/test';
import type { ModelPurpose } from '@ai-bdd/sdk/contracts';
import { aiSdkModels } from '../src/index.ts';
import { runModelContract, type FailureKind, type ModelScript } from '../../sdk/test/kit/model-contract.ts';
import { mockModel, textResult, toolCallResult } from './helpers.ts';

type DoGenerate = Parameters<typeof mockModel>[0];

function providerFailure(kind: FailureKind): DoGenerate {
  switch (kind) {
    case 'rate-limit':
      return () => Promise.reject(new APICallError({ message: 'rate limited', url: 'https://api.example.test/v1', requestBodyValues: {}, statusCode: 429, isRetryable: true }));
    case 'permanent':
      return () => Promise.reject(new APICallError({ message: 'invalid api key', url: 'https://api.example.test/v1', requestBodyValues: {}, statusCode: 401, isRetryable: false }));
    case 'timeout':
      return () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    case 'malformed-json':
      return textResult('this is {not json', { finish: 'stop' });
    case 'refusal':
      return {
        content: [],
        finishReason: { unified: 'content-filter', raw: 'refusal' },
        usage: textResult('').usage,
        warnings: [],
      };
    case 'unscripted':
      throw new Error('the AI SDK adapter has no "unscripted" failure');
  }
}

function provider(script: ModelScript): DoGenerate {
  switch (script.kind) {
    case 'text':
      return textResult(script.text);
    case 'structured':
      return textResult(JSON.stringify(script.object));
    case 'tool-call':
      return toolCallResult([{ id: 'call-1', name: script.toolName, input: script.args }]);
    case 'hang':
      return ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          if (abortSignal?.aborted === true) reject(abortSignal.reason);
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        });
    case 'failure':
      return providerFailure(script.failure);
  }
}

// The adapter over the AI SDK's mock language model: every provider behavior is scripted, nothing touches the network.
runModelContract(
  'aiSdkModels (AI SDK mock provider)',
  (script) => {
    const models = Object.fromEntries(
      (['extract', 'act', 'checkgen', 'judge'] as const).map((p): [ModelPurpose, MockLanguageModelV4] => [p, mockModel(provider(script), `mock-${p}`)]),
    ) as Record<ModelPurpose, MockLanguageModelV4>;
    // maxRetries 0: the AI SDK's own back-off sleeps in real time, and retrying is the provider layer's business, not the contract's.
    return aiSdkModels(models, { maxRetries: 0 });
  },
  {
    failures: ['rate-limit', 'permanent', 'timeout', 'malformed-json', 'refusal'],
    textUsage: { inputTokens: 10, outputTokens: 5 },
  },
);
