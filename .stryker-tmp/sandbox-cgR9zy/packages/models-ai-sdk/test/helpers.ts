// @ts-nocheck
import { MockLanguageModelV4, MockProviderV4 } from 'ai/test';
import type { ModelRequest, ToolSpec } from '@ai-bdd/sdk/contracts';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

export function usage(input: number | undefined, output: number | undefined): GenerateResult['usage'] {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

export function textResult(
  text: string,
  extra: { finish?: GenerateResult['finishReason']['unified']; usage?: GenerateResult['usage'] } = {},
): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: extra.finish ?? 'stop', raw: undefined },
    usage: extra.usage ?? usage(10, 5),
    warnings: [],
  };
}

export function toolCallResult(calls: Array<{ id: string; name: string; input: unknown }>): GenerateResult {
  return {
    content: calls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: c.id,
      toolName: c.name,
      input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
    })),
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: usage(20, 8),
    warnings: [],
  };
}

export function mockModel(
  doGenerate: ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O
    ? O extends { doGenerate?: infer D }
      ? D
      : never
    : never,
  modelId = 'mock-model',
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ provider: 'mock', modelId, doGenerate });
}

export function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: 'act',
    system: 'You are a test agent.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    context: {},
    ...overrides,
  };
}

/** A provider suitable for `globalThis.AI_SDK_DEFAULT_PROVIDER` that resolves the given language models. */
export function mockProvider(languageModels: Record<string, MockLanguageModelV4>): NonNullable<typeof globalThis.AI_SDK_DEFAULT_PROVIDER> {
  return new MockProviderV4({ languageModels }) as unknown as NonNullable<typeof globalThis.AI_SDK_DEFAULT_PROVIDER>;
}

export const ACT_TOOLS: ToolSpec[] = [
  {
    name: 'click',
    description: 'Click an element',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  { name: 'complete_step', description: 'Finish', inputSchema: { type: 'object', properties: {} } },
];
