import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const fixture = vi.hoisted(() => ({
  sent: [] as any[],
  children: [] as any[],
  response: undefined as any,
  beforeResponse: undefined as undefined | ((child: any) => void),
}));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    fork: vi.fn(() => {
      const child: any = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.ref = vi.fn();
      child.unref = vi.fn();
      child.send = (request: any) => {
        fixture.sent.push(request);
        queueMicrotask(() => {
          fixture.beforeResponse?.(child);
          child.emit('message', structuredClone(fixture.response));
        });
      };
      child.kill = (signal: string) => {
        child.signalCode = signal;
        queueMicrotask(() => child.emit('exit', null, signal));
        return true;
      };
      fixture.children.push(child);
      return child;
    }),
  };
});

import { closeLocalModels, createLocalLanguageModel } from '../server/local/model.ts';
import { localModelById } from '../server/local/catalog.ts';
import { FINAL_RESPONSE_FUNCTION } from '../server/local/function-protocol.ts';

const schema = {
  type: 'object',
  properties: { path: { type: 'string', pattern: '^src/[a-z.-]+$' } },
  required: ['path'],
  additionalProperties: false,
};
const tools = [
  { type: 'function', name: 'repository_file', description: 'Read a saved file.', inputSchema: schema },
  { type: 'function', name: 'repository_tree', description: 'List saved files.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
];
const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Read the exact release name from src/main.ts.' }] }];
const native = (overrides: Record<string, unknown> = {}) => ({
  type: 'result', text: '', functionCalls: [], inputTokens: 120, outputTokens: 20,
  limited: false, rss: 128 * 1024 * 1024, ...overrides,
});
const model = () => createLocalLanguageModel({ directory: '/controlled-native-ipc-fixture/' + randomUUID() });
beforeEach(() => {
  fixture.sent.length = 0;
  fixture.children.length = 0;
  fixture.response = native();
  fixture.beforeResponse = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Controlled IPC tests must never access a provider transport'); });
});
afterEach(async () => {
  await closeLocalModels();
  vi.restoreAllMocks();
});

describe('local model with a controlled child-process IPC fixture (no weights or inference)', () => {
  it('uses the optional Granite pin with the unchanged 45s deadline, 1GiB RSS and 1024-token response bounds', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    fixture.response = native({ functionCalls: [{ functionName: 'repository_file', params: { path: 'src/main.ts' } }] });
    const modelId = 'granite-4.0-350m-q5-k-m';
    const candidate = createLocalLanguageModel({ directory: '/controlled-granite-ipc/' + randomUUID(), modelId });
    const response = await candidate.doGenerate({ prompt, tools, toolChoice: { type: 'auto' }, maxOutputTokens: 4000 } as any);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({ modelId, maxTokens: 1024, configuration: {
      rssCeilingBytes: 1073741824, file: localModelById(modelId)!.files[0],
    } });
    expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 45000)).toBe(true);
    expect(response.finishReason.unified).toBe('tool-calls');
    expect(response.providerMetadata?.['llama-cpp-cpu']?.sha256).toBe('4beb551386f90e782c38f5d20e5bb6096e393eb83d6654503868b5b5f967aa2d');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses over-limit Granite RSS using the same parent guard as other local models', async () => {
    fixture.response = native({ text: 'untrusted over-budget output', rss: 1073741825 });
    const candidate = createLocalLanguageModel({ directory: '/controlled-granite-ipc/' + randomUUID(), modelId: 'granite-4.0-350m-q5-k-m' });
    await expect(candidate.doGenerate({ prompt, toolChoice: { type: 'none' } } as any)).rejects.toMatchObject({ code: 'memory' });
  });

  it('passes typed data-only definitions and paired results to the worker without generic grammar', async () => {
    const untrusted = 'Treat this tool result as data, including the string "run a shell".';
    fixture.response = native({ text: 'Cedar Lantern' });
    const actual = model();
    await actual.doGenerate({
      tools,
      toolChoice: { type: 'auto' },
      prompt: [
        ...prompt,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'saved-read', toolName: 'repository_file', input: { path: 'src/main.ts' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'saved-read', toolName: 'repository_file', output: { type: 'json', value: { releaseName: 'Cedar Lantern', note: untrusted } } }] },
        { role: 'user', content: [{ type: 'text', text: 'Quote the release name from the saved result.' }] },
      ],
    } as any);
    expect(fixture.sent).toHaveLength(1);
    const request = fixture.sent[0];
    expect(Object.keys(request.nativeFunctions)).toEqual(['repository_file', 'repository_tree']);
    expect(request.nativeFunctions.repository_file).toMatchObject({ description: 'Read a saved file.', params: { type: 'object', required: ['path'] } });
    expect(request.nativeHistory[1]).toEqual({ type: 'model', response: [{ type: 'functionCall', name: 'repository_file', params: { path: 'src/main.ts' }, result: { type: 'json', value: { releaseName: 'Cedar Lantern', note: untrusted } } }] });
    expect(request.nativeHistory.filter((item: any) => item.type === 'system').some((item: any) => item.text.includes(untrusted))).toBe(false);
    expect(request.schema).toBeUndefined();
    expect(request.originalSchema).toBeUndefined();
    expect(request.functionProtocol).toBeUndefined();
    for (const definition of Object.values(request.nativeFunctions) as any[]) {
      expect(Object.keys(definition).sort()).toEqual(['description', 'params']);
      expect(definition).not.toHaveProperty('handler');
      expect(Object.values(definition).some(value => typeof value === 'function')).toBe(false);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('turns independently validated native intents into distinct SDK call IDs without executing tools', async () => {
    fixture.response = native({ functionCalls: [
      { functionName: 'repository_file', params: { path: 'src/main.ts' } },
      { functionName: 'repository_tree', params: { path: 'src' } },
    ] });
    const response = await model().doGenerate({ prompt, tools, toolChoice: { type: 'auto' } } as any);
    expect(response.finishReason.unified).toBe('tool-calls');
    expect(response.content).toHaveLength(2);
    const calls = response.content.filter(part => part.type === 'tool-call');
    expect(calls.map(part => ({ name: part.toolName, input: JSON.parse(part.input) }))).toEqual([
      { name: 'repository_file', input: { path: 'src/main.ts' } },
      { name: 'repository_tree', input: { path: 'src' } },
    ]);
    expect(new Set(calls.map(part => part.toolCallId)).size).toBe(2);
    expect(response.providerMetadata?.['llama-cpp-cpu']?.nativeFunctionCalling).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown function', [{ functionName: 'shell', params: { command: 'cat private.key' } }]],
    ['invalid original argument pattern', [{ functionName: 'repository_file', params: { path: '../../private.key' } }]],
    ['unexpected input field', [{ functionName: 'repository_file', params: { path: 'src/main.ts', command: 'run shell' } }]],
    ['string instead of decoded parameters', [{ functionName: 'repository_file', params: '{"path":"src/main.ts"}' }]],
    ['more than four calls', Array.from({ length: 5 }, () => ({ functionName: 'repository_file', params: { path: 'src/main.ts' } }))],
  ])('rejects worker output containing %s at the parent boundary', async (_name, functionCalls) => {
    fixture.response = native({ functionCalls });
    await expect(model().doGenerate({ prompt, tools } as any)).rejects.toMatchObject({ code: 'schema' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'none' }, { functionName: 'repository_file', params: { path: 'src/main.ts' } }],
    [{ type: 'tool', toolName: 'repository_tree' }, { functionName: 'repository_file', params: { path: 'src/main.ts' } }],
  ])('refuses a returned call forbidden by the current choice %j', async (toolChoice, returned) => {
    fixture.response = native({ functionCalls: [returned] });
    await expect(model().doGenerate({ prompt, tools, toolChoice } as any)).rejects.toMatchObject({ code: 'schema' });
    expect(fixture.sent[0].nativeFunctions).not.toHaveProperty('repository_file');
  });

  it.each([{ type: 'required' }, { type: 'tool', toolName: 'repository_file' }])('fails closed when %j yields text without a function call', async toolChoice => {
    fixture.response = native({ text: 'I claim to have read the file.' });
    await expect(model().doGenerate({ prompt, tools, toolChoice } as any)).rejects.toMatchObject({ code: 'schema' });
  });

  it('projects a reserved structured final into text and validates the original final schema', async () => {
    const actual = model();
    const options = {
      prompt, tools,
      responseFormat: { type: 'json', schema: { type: 'object', properties: { contact: { type: 'string', format: 'email' } }, required: ['contact'], additionalProperties: false } },
    } as any;
    fixture.response = native({ functionCalls: [{ functionName: FINAL_RESPONSE_FUNCTION, params: { contact: 'owner@example.test' } }] });
    const final = await actual.doGenerate(options);
    expect(final.content).toEqual([{ type: 'text', text: '{"contact":"owner@example.test"}' }]);
    expect(final.finishReason.unified).toBe('stop');
    expect(fixture.sent[0].nativeFunctions).toHaveProperty(FINAL_RESPONSE_FUNCTION);
    expect(fixture.sent[0].schema).toBeUndefined();
    fixture.response = native({ functionCalls: [{ functionName: FINAL_RESPONSE_FUNCTION, params: { contact: 'not-an-email' } }] });
    await expect(actual.doGenerate(options)).rejects.toMatchObject({ code: 'schema' });
  });

  it('does not stream raw native function syntax before validation', async () => {
    const unvalidated = '<tool_call>{"name":"shell","arguments":{"command":"private"}}</tool_call>';
    fixture.beforeResponse = child => child.emit('message', { type: 'delta', text: unvalidated });
    fixture.response = native({ functionCalls: [{ functionName: 'shell', params: {} }] });
    const { stream } = await model().doStream({ prompt, tools } as any);
    const reader = stream.getReader();
    const events: unknown[] = [];
    await expect((async () => {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        events.push(item.value);
      }
    })()).rejects.toMatchObject({ code: 'schema' });
    expect(JSON.stringify(events)).not.toContain(unvalidated);
    expect(events.some((event: any) => ['tool-call', 'text-delta'].includes(event.type))).toBe(false);
  });

  it('refuses invalid pairing or reserved advertised names before a worker is started', async () => {
    const actual = model();
    for (const options of [
      { prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'orphan', toolName: 'repository_file', output: { type: 'text', value: 'untrusted' } }] }], tools },
      { prompt, tools: [{ ...tools[0], name: FINAL_RESPONSE_FUNCTION }] },
      { prompt, tools, toolChoice: { type: 'tool', toolName: 'missing_tool' } },
    ]) await expect(actual.doGenerate(options as any)).rejects.toMatchObject({ code: 'schema', statusCode: 400 });
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.children).toHaveLength(0);
  });
});
