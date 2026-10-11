import { afterEach, describe, expect, it } from 'vitest';
import type { MockLanguageModelV4 } from 'ai/test';
import { aiSdkModels } from '../src/index.ts';
import { ACT_TOOLS, mockModel, mockProvider, request, textResult, toolCallResult, usage } from './helpers.ts';

function setOf(m: MockLanguageModelV4, opts?: { maxRetries?: number }) {
  return aiSdkModels({ extract: m, act: m, checkgen: m, judge: m }, opts);
}

describe('request mapping', () => {
  it('maps system, text messages, and ids', async () => {
    const m = mockModel(textResult('hi there'), 'model-x');
    const set = setOf(m);
    expect(set.act.id).toBe('model-x');
    const res = await set.act.generate(request({ system: 'SYS' }));
    expect(res).toEqual({
      text: 'hi there',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'stop',
      modelId: 'model-x',
    });
    const call = m.doGenerateCalls[0]!;
    expect(call.prompt[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(call.prompt[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(call.tools).toBeUndefined();
    expect(call.responseFormat).toBeUndefined();
  });

  it('maps image parts to png file parts', async () => {
    const m = mockModel(textResult('ok'));
    const png = new Uint8Array([137, 80, 78, 71]);
    await setOf(m).act.generate(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', png, sha256: 'abc' },
            ],
          },
        ],
      }),
    );
    const user = m.doGenerateCalls[0]!.prompt.find((p) => p.role === 'user')!;
    expect(user.content).toHaveLength(2);
    const file = (user.content as Array<{ type: string; mediaType?: string; data?: { type: string; data: Uint8Array } }>)[1]!;
    expect(file.type).toBe('file');
    expect(file.mediaType).toBe('image/png');
    expect(Array.from(file.data!.data)).toEqual([137, 80, 78, 71]);
  });

  it('maps assistant tool calls and tool messages to tool-call / tool-result parts', async () => {
    const m = mockModel(textResult('ok'));
    await setOf(m).act.generate(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'clicking' }], toolCalls: [{ id: 'c1', name: 'click', args: { ref: 'e1' } }] },
          { role: 'tool', toolCallId: 'c1', toolName: 'click', result: { ok: true } },
        ],
        tools: ACT_TOOLS,
      }),
    );
    const prompt = m.doGenerateCalls[0]!.prompt;
    expect(prompt[2]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'clicking' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'click', input: { ref: 'e1' } },
      ],
    });
    expect(prompt[3]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'click', output: { type: 'json', value: { ok: true } } }],
    });
  });

  it('passes tools as schema-only function tools with the given toolChoice', async () => {
    const m = mockModel(toolCallResult([{ id: 'call-1', name: 'click', input: { ref: 'e7' } }]));
    const res = await setOf(m).act.generate(request({ tools: ACT_TOOLS, toolChoice: 'required' }));
    const call = m.doGenerateCalls[0]!;
    expect(call.tools).toEqual([
      {
        type: 'function',
        name: 'click',
        description: 'Click an element',
        inputSchema: ACT_TOOLS[0]!.inputSchema,
      },
      { type: 'function', name: 'complete_step', description: 'Finish', inputSchema: ACT_TOOLS[1]!.inputSchema },
    ]);
    expect(call.toolChoice).toEqual({ type: 'required' });
    expect(res.toolCalls).toEqual([{ id: 'call-1', name: 'click', args: { ref: 'e7' } }]);
    expect(res.finishReason).toBe('tool-calls');
    expect(res.object).toBeUndefined();
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it('returns multiple tool calls in order and keeps them unexecuted', async () => {
    const m = mockModel(
      toolCallResult([
        { id: 'a', name: 'click', input: { ref: 'e1' } },
        { id: 'b', name: 'complete_step', input: {} },
      ]),
    );
    const res = await setOf(m).act.generate(request({ tools: ACT_TOOLS, toolChoice: 'auto' }));
    expect(res.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(m.doGenerateCalls).toHaveLength(1);
    expect(m.doGenerateCalls[0]!.toolChoice).toEqual({ type: 'auto' });
  });

  it('maps structured output through Output.object(jsonSchema)', async () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
    const m = mockModel(textResult('{"verdict":"pass","n":[1,2]}'));
    const res = await setOf(m).judge.generate(request({ purpose: 'judge', output: { name: 'verdict', schema } }));
    expect(res.object).toEqual({ verdict: 'pass', n: [1, 2] });
    expect(res.text).toBe('{"verdict":"pass","n":[1,2]}');
    expect(m.doGenerateCalls[0]!.responseFormat).toEqual({ type: 'json', schema, name: 'verdict' });
  });

  it('honors temperature, seed, maxOutputTokens and abortSignal', async () => {
    const m = mockModel(textResult('ok'));
    const ac = new AbortController();
    await setOf(m).extract.generate(
      request({ purpose: 'extract', temperature: 0.3, seed: 42, maxOutputTokens: 777, signal: ac.signal }),
    );
    const call = m.doGenerateCalls[0]!;
    expect(call.temperature).toBe(0.3);
    expect(call.seed).toBe(42);
    expect(call.maxOutputTokens).toBe(777);
    expect(call.abortSignal).toBeDefined();
  });

  it('omits sampling settings that were not requested', async () => {
    const m = mockModel(textResult('ok'));
    await setOf(m).act.generate(request());
    const call = m.doGenerateCalls[0]!;
    expect(call.temperature).toBeUndefined();
    expect(call.seed).toBeUndefined();
    expect(call.maxOutputTokens).toBeUndefined();
  });

  it('uses a distinct model per purpose', async () => {
    const a = mockModel(textResult('A'), 'a');
    const b = mockModel(textResult('B'), 'b');
    const set = aiSdkModels({ extract: a, act: a, checkgen: b, judge: b });
    expect((await set.act.generate(request())).text).toBe('A');
    expect((await set.judge.generate(request({ purpose: 'judge' }))).modelId).toBe('b');
    expect(a.doGenerateCalls).toHaveLength(1);
    expect(b.doGenerateCalls).toHaveLength(1);
  });
});

describe('context is never sent to the provider', () => {
  it('does not leak request.context anywhere in the provider call', async () => {
    const m = mockModel(textResult('ok'));
    await setOf(m).extract.generate(
      request({
        purpose: 'extract',
        context: { docUri: 'SECRET-DOC-URI', sectionId: 'SECRET-SECTION', nested: { deep: 'SECRET-DEEP' }, attempt: 987654 },
      }),
    );
    const serialized = JSON.stringify(m.doGenerateCalls);
    expect(serialized).not.toContain('SECRET-DOC-URI');
    expect(serialized).not.toContain('SECRET-SECTION');
    expect(serialized).not.toContain('SECRET-DEEP');
    expect(serialized).not.toContain('987654');
    expect(serialized).not.toContain('docUri');
    const call = m.doGenerateCalls[0]!;
    expect(call.providerOptions).toBeUndefined();
  });
});

describe('response mapping', () => {
  it('counts undefined token usage as 0', async () => {
    const m = mockModel(textResult('x', { usage: usage(undefined, undefined) }));
    const res = await setOf(m).act.generate(request());
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('reports real token usage', async () => {
    const m = mockModel(textResult('x', { usage: usage(1234, 56) }));
    const res = await setOf(m).act.generate(request());
    expect(res.usage).toEqual({ inputTokens: 1234, outputTokens: 56 });
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool-calls', 'tool-calls'],
    ['error', 'error'],
    ['content-filter', 'other'],
    ['other', 'other'],
  ] as const)('maps finish reason %s -> %s', async (given, expected) => {
    const m = mockModel(textResult('partial', { finish: given }));
    const res = await setOf(m).act.generate(request());
    expect(res.finishReason).toBe(expected);
  });

  it('omits text when the model returned none', async () => {
    const m = mockModel(toolCallResult([{ id: 'x', name: 'complete_step', input: {} }]));
    const res = await setOf(m).act.generate(request({ tools: ACT_TOOLS }));
    expect('text' in res).toBe(false);
  });
});

describe('string model ids', () => {
  const previous = globalThis.AI_SDK_DEFAULT_PROVIDER;
  afterEach(() => {
    globalThis.AI_SDK_DEFAULT_PROVIDER = previous;
  });

  it('are passed to the AI SDK as-is and resolved by its global provider', async () => {
    const m = mockModel(textResult('via provider'), 'claude-test');
    globalThis.AI_SDK_DEFAULT_PROVIDER = mockProvider({ 'vendor/claude-test': m });
    const set = aiSdkModels({
      extract: 'vendor/claude-test',
      act: 'vendor/claude-test',
      checkgen: 'vendor/claude-test',
      judge: 'vendor/claude-test',
    });
    expect(set.act.id).toBe('vendor/claude-test');
    const res = await set.act.generate(request());
    expect(res.text).toBe('via provider');
    expect(res.modelId).toBe('vendor/claude-test');
    expect(m.doGenerateCalls).toHaveLength(1);
  });
});
