import { describe, expect, it } from 'vitest';
import { generateText, stepCountIs, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { nativeT3CpuOptions, nativeT3CpuPrompt } from '../server/local/native-t3-protocol.ts';
import { managedT3LanguageModel } from '../server/local/native-t3-runtime.ts';

function history(value: unknown) {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Inspect the owned value.' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'owned-finite', toolName: 'inspect_value', input: 4 }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owned-finite', toolName: 'inspect_value', output: { type: 'json', value } }] },
  ] as any[];
}
const tools = [{ type: 'function', name: 'inspect_value', inputSchema: true }];
describe('finite JSON before the native SDK prompt-version bridge', () => {
  it.each([NaN, Infinity, -Infinity, JSON.parse('1e999'), JSON.parse('-1e999')])('rejects non-finite historical results before a clone can normalize them (%s)', value => {
    for (const output of [value, { nested: [value] }]) {
      const prompt = history(output);
      expect(() => nativeT3CpuPrompt(prompt as any)).toThrow('Invalid native function protocol');
      expect(() => nativeT3CpuOptions({ prompt, tools } as any, prompt as any)).toThrow('Invalid native function protocol');
    }
  });
  it('roundtrips legitimate finite values and null without sharing the caller output object', () => {
    const value = { nested: [null, 0, 42.25, Number.MAX_VALUE, -Number.MAX_VALUE] };
    const prompt = history(value);
    const options = nativeT3CpuOptions({ prompt, tools } as any, prompt as any);
    expect(options.prompt).toEqual(prompt);
    const message = options.prompt[2]!;
    if (message.role !== 'tool') throw new Error('Typed tool role was lost');
    const part = message.content[0]!;
    if (part.type !== 'tool-result') throw new Error('Typed tool result was lost');
    expect(part.output).not.toBe(prompt[2].content[0].output);
    value.nested[0] = 12;
    expect(part.output).toEqual({ type: 'json', value: { nested: [null, 0, 42.25, Number.MAX_VALUE, -Number.MAX_VALUE] } });
  });
  it('does not relabel an unsupported message role as a paired tool result', () => {
    const prompt = history({ finite: 4 });
    prompt[2].role = 'unsupported-review-role';
    expect(() => nativeT3CpuPrompt(prompt as any)).toThrow('Unsupported local prompt role');
    expect(() => nativeT3CpuOptions({ prompt, tools } as any, prompt as any)).toThrow('Unsupported local prompt role');
  });
  it.each([NaN, Infinity, -Infinity])('rejects a real SDK-executed tool result before native processes or CPU inference (%s)', async value => {
    const cpu = new MockLanguageModelV4({ modelId: 'controlled-unused-cpu' });
    const managed = managedT3LanguageModel({
      store: {} as any, objects: {} as any, key: new Uint8Array(32), artifactId: 'owned-finite-history',
      toolsDirectory: '/controlled-native-tools-must-never-start', localModel: cpu,
    }, { harness: 't3-code', provider: 'studioLocal', model: 'studio-local/' + cpu.modelId }, 'controlled-finite-sdk-history');
    const received: any[] = [];
    const observed = { ...managed, async doGenerate(options: any) { received.push(options); return managed.doGenerate(options); } };
    const first = new MockLanguageModelV4({ doGenerate: {
      content: [{ type: 'tool-call', toolCallId: 'owned-finite', toolName: 'inspect_value', input: '4' }],
      finishReason: { unified: 'tool-calls', raw: 'controlled' }, warnings: [],
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    } });
    let executions = 0;
    await expect(generateText({ model: first, prompt: 'Inspect the owned numeric result.',
      tools: { inspect_value: tool({ inputSchema: z.number(), execute: async () => { executions++; return { nested: value }; },
        // AI SDK's default tool serializer already JSON-normalizes outputs.
        // Its supported typed-output hook lets this regression exercise the
        // actual bridge boundary with the original non-finite result intact.
        toModelOutput: ({ output }) => ({ type: 'json', value: output }),
      }) },
      prepareStep: ({ stepNumber }) => stepNumber === 1 ? { model: observed } : {},
      stopWhen: stepCountIs(2), maxRetries: 0,
    })).rejects.toMatchObject({ statusCode: 400, message: 'The native local model received invalid tools, history or response schema' });
    expect(executions).toBe(1); expect(received).toHaveLength(1);
    const result = received[0].prompt.find((message: any) => message.role === 'tool').content[0].output;
    expect(result.type).toBe('json');
    expect(Object.is(result.value.nested, value)).toBe(true);
    expect(cpu.doGenerateCalls).toHaveLength(0);
  });
});
