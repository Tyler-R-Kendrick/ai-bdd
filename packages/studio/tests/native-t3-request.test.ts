import { afterEach, describe, expect, it } from 'vitest';
import { generateText, Output } from 'ai';
import { createManagedT3Request } from '../server/local/native-t3-request.ts';
import { nativeT3CpuOptions, nativeT3ResultEnvelope, NATIVE_T3_TRANSPORT_PROTOCOL_REVISION } from '../server/local/native-t3-protocol.ts';
import { nativeT3Prompt, t3LanguageModel } from '../server/integrations/t3-model.ts';
import { codeEditProposalSchema } from '../shared/code-edit.ts';
import { nativeT3Fixture } from './t3-native-fixture.ts';

const scope = (overrides = {}) => ({ key: new Uint8Array(32).fill(7), artifactId: 'owned-artifact', profile: { harness: 't3-code', provider: 'studioLocal', model: 'studio-local/owned-model' } as const, idempotencyKey: 'owned-stable-job:step', ...overrides });
const options = (overrides: Record<string, unknown> = {}): any => ({
  prompt: [{ role: 'system', content: 'Studio constraints' }, { role: 'user', content: [{ type: 'text', text: 'Exact saved source and latest request.' }] }],
  tools: [{ type: 'function', name: 'repository_file', description: 'Read only', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
  toolChoice: { type: 'auto' }, maxOutputTokens: 512, stopSequences: ['END'],
  responseFormat: { type: 'json', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } },
  ...overrides,
});
const nativeMessages = (reference: string): any[] => [{ role: 'system', content: 'Genuine native harness context' }, { role: 'user', content: reference }];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('scoped managed native request references', () => {
  it('launches a short opaque reference while retaining complete CPU-effective typed SDK data', () => {
    const call = options();
    const expected = structuredClone(nativeT3CpuOptions(call, call.prompt));
    const request = createManagedT3Request(scope(), call);
    expect(NATIVE_T3_TRANSPORT_PROTOCOL_REVISION).toBe('managed-native-t3-reference-v1');
    expect(request.reference).toMatch(/^studio-native-request-v1:[a-f0-9]{64}$/);
    expect(request.reference.length).toBeLessThan(100);
    expect(request.reference).not.toContain('source'); expect(request.reference).not.toContain('repository');
    const expanded = request.expand(nativeMessages(request.reference));
    expect(expanded.matches).toBe(1);
    expect(expanded.prompt[0]).toEqual({ role: 'system', content: 'Genuine native harness context' });
    expect(expanded.prompt.slice(2)).toEqual(call.prompt);
    expect(nativeT3CpuOptions(request.call, expanded.prompt)).toEqual({ ...expected, prompt: expanded.prompt });
    expect(request.call).not.toHaveProperty('abortSignal');
  });
  it('freezes every supported effective field before asynchronous native work, including history/results', () => {
    const result = { type: 'json', value: { text: 'Exact saved source\n' } };
    const call = options({ prompt: [
      { role: 'user', content: [{ type: 'text', text: 'Read source' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'owned-read', toolName: 'repository_file', input: { path: 'src/main.ts' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owned-read', toolName: 'repository_file', output: result }] },
    ], toolChoice: { type: 'none' }, abortSignal: new AbortController().signal });
    const expected = structuredClone(nativeT3CpuOptions(call, call.prompt));
    const request = createManagedT3Request(scope(), call);
    result.value.text = 'mutated'; call.prompt[1].content[0].input.path = 'other.ts'; call.prompt[0].content[0].text = 'mutated';
    call.tools[0].description = 'changed'; call.tools[0].inputSchema.required = []; call.responseFormat.schema.required = [];
    call.maxOutputTokens = 12; call.stopSequences[0] = 'different'; call.toolChoice.type = 'auto';
    expect(nativeT3CpuOptions(request.call, request.call.prompt)).toEqual(expected);
    expect(() => { (request.call as any).maxOutputTokens = 3; }).toThrow();
    expect(() => { (request.call.prompt[0] as any).content[0].text = 'mutated'; }).toThrow();
  });
  it('binds scope and every CPU-effective field, with stable canonical object ordering', () => {
    const call = options(); const reference = createManagedT3Request(scope(), call).reference;
    expect(createManagedT3Request(scope(), structuredClone(call)).reference).toBe(reference);
    for (const overrides of [
      { key: new Uint8Array(32).fill(8) }, { artifactId: 'other-artifact' }, { idempotencyKey: 'other-job' },
      { profile: { ...scope().profile, model: 'studio-local/other-model' } },
      { profile: { ...scope().profile, provider: 'other-provider' } },
    ]) expect(createManagedT3Request(scope(overrides), call).reference).not.toBe(reference);
    for (const overrides of [
      { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Other source/request' }] }] },
      { tools: [{ ...call.tools[0], description: 'Different tool definition' }] },
      { tools: [{ ...call.tools[0], inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 20 } }, required: ['path'], additionalProperties: false } }] },
      { toolChoice: { type: 'none' } }, { maxOutputTokens: 64 }, { stopSequences: ['OTHER'] },
      { responseFormat: { type: 'json', schema: { type: 'integer' } } },
    ]) expect(createManagedT3Request(scope(), options(overrides)).reference).not.toBe(reference);
    const reordered = options(); reordered.responseFormat.schema = { additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } }, type: 'object' };
    expect(createManagedT3Request(scope(), reordered).reference).toBe(reference);
    expect(() => createManagedT3Request(scope({ profile: { ...scope().profile, harness: 'local-cpu' } } as any), call)).toThrow();
  });
  it.each(['foreign', 'duplicate', 'prefixed', 'system', 'assistant', 'missing', 'foreign-plus-current', 'embedded', 'unsupported-role', 'unsupported-part'])('refuses %s references before any CPU invocation', kind => {
    const request = createManagedT3Request(scope(), options());
    const foreign = createManagedT3Request(scope({ artifactId: 'foreign' }), options()).reference;
    const cases: Record<string, any[]> = {
      foreign: nativeMessages(foreign), duplicate: [...nativeMessages(request.reference), { role: 'user', content: request.reference }],
      prefixed: nativeMessages('[User]: ' + request.reference), system: [{ role: 'system', content: request.reference }],
      assistant: [{ role: 'assistant', content: request.reference }], missing: nativeMessages('ordinary unrelated text'),
      'foreign-plus-current': [...nativeMessages(request.reference), { role: 'user', content: foreign }],
      embedded: nativeMessages('Quoted ' + request.reference + ' suffix'),
      'unsupported-role': [...nativeMessages(request.reference), { role: 'unexpected', content: 'data' }],
      'unsupported-part': [{ role: 'user', content: [{ type: 'image', data: request.reference }] }],
    };
    let cpuCalls = 0;
    expect(() => { const expanded = request.expand(cases[kind]!); nativeT3CpuOptions(request.call, expanded.prompt); cpuCalls++; }).toThrow();
    expect(cpuCalls).toBe(0);
  });
  it('supports text-part transport and retains other genuine native context without substituting artifact guesses', () => {
    const request = createManagedT3Request(scope(), options());
    const { prompt } = request.expand([{ role: 'developer', content: 'Native constraints' }, { role: 'user', content: [{ type: 'text', text: 'Before' }, { type: 'text', text: request.reference }, { type: 'text', text: 'After' }] }]);
    expect(prompt[0]).toEqual({ role: 'system', content: 'Native constraints' });
    expect(prompt[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Before' }] });
    expect(prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'After' }] });
    expect(() => request.expand(nativeMessages(nativeT3Prompt(options())))).toThrow();
  });
  it('retains raw finite validation and the original full payload input budget before native startup', () => {
    expect(() => createManagedT3Request(scope(), options({ responseFormat: { type: 'json', schema: { type: 'number', maximum: Infinity } } }))).toThrow();
    expect(() => createManagedT3Request(scope(), options({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(120001) }] }] }))).toThrow();
  });
  it('sends only the short reference through real SDK/MCP while a long code schema and full source reach the controlled CPU provider', async () => {
    const fixture = await nativeT3Fixture(); cleanup.push(fixture.close);
    const selected = { harness: 't3-code', provider: 'codex-fixture', model: 'fixture-model' } as const;
    const source = 'Saved source exact bytes\n'.repeat(150), output = { summary: 'A literal edit.', changes: [{ op: 'replace' as const, path: 'src/page.html', find: 'old', replacement: 'new' }] };
    let cpuCalls = 0, recorded: any;
    const model: any = { specificationVersion: 'v3', provider: 'controlled-managed-native', modelId: 'fixture-model', supportedUrls: {}, async doGenerate(call: any) {
      const request = createManagedT3Request(scope({ profile: selected }), call);
      fixture.state.onLaunch = arguments_ => {
        expect(arguments_.message).toBe(request.reference);
        expect(arguments_.message.length).toBeLessThan(100);
        expect(arguments_.message).not.toContain(source); expect(arguments_.message).not.toContain('changes');
        const { prompt } = request.expand(nativeMessages(arguments_.message));
        recorded = nativeT3CpuOptions(request.call, prompt); cpuCalls++;
        return nativeT3ResultEnvelope(request.call, { content: [{ type: 'text', text: JSON.stringify(output) }] });
      };
      return t3LanguageModel(fixture.config, selected, 'controlled-long-code-request', request.launch).doGenerate({ ...request.call, abortSignal: call.abortSignal });
    } };
    const result = await generateText({ model, prompt: source, output: Output.object({ schema: codeEditProposalSchema }), maxRetries: 0 });
    expect(result.output).toEqual(output); expect(cpuCalls).toBe(1);
    expect(JSON.stringify(recorded.prompt)).toContain('Saved source exact bytes');
    expect(JSON.stringify(recorded.responseFormat.schema)).toContain('replacement');
    expect(recorded.prompt.at(-1).content[0].text).toBe(source);
    expect(recorded.maxOutputTokens).toBe(1024); expect(await fixture.cliStarted()).toBe(false);
  });
  it('rejects a scoped launch whose server-side payload changed before any MCP launch', async () => {
    const fixture = await nativeT3Fixture(); cleanup.push(fixture.close);
    const selected = { harness: 't3-code', provider: 'codex-fixture', model: 'fixture-model' } as const;
    const request = createManagedT3Request(scope({ profile: selected }), options());
    const model = t3LanguageModel(fixture.config, selected, 'controlled-wrong-payload', request.launch);
    await expect(model.doGenerate(options({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Changed' }] }] }))).rejects.toMatchObject({ statusCode: 400 });
    expect(fixture.calls).toHaveLength(0);
  });
  it('retains the frozen effective request when the caller mutates its data after native asynchronous work begins', async () => {
    const fixture = await nativeT3Fixture(); cleanup.push(fixture.close);
    const selected = { harness: 't3-code', provider: 'codex-fixture', model: 'fixture-model' } as const;
    const call = options({ tools: [], toolChoice: { type: 'none' }, responseFormat: { type: 'text' } });
    const expected = structuredClone(nativeT3CpuOptions(call, call.prompt));
    const request = createManagedT3Request(scope({ profile: selected }), call);
    let observations = 0;
    fixture.state.onLaunch = arguments_ => {
      const expanded = request.expand(nativeMessages(arguments_.message));
      expect(nativeT3CpuOptions(request.call, expanded.prompt)).toEqual({ ...expected, prompt: expanded.prompt });
      expect(expanded.prompt.at(-1).content[0].text).toBe('Exact saved source and latest request.'); observations++;
      return JSON.stringify({ type: 'final', text: 'Controlled frozen request.' });
    };
    const pending = t3LanguageModel(fixture.config, selected, 'controlled-asynchronous-freeze', request.launch).doGenerate(request.call);
    call.prompt[1].content[0].text = 'Changed while native MCP is awaiting'; call.maxOutputTokens = 1;
    call.stopSequences[0] = 'changed'; call.toolChoice.type = 'auto'; call.responseFormat.type = 'json';
    const result = await pending;
    expect(result.content[0]).toEqual({ type: 'text', text: 'Controlled frozen request.' }); expect(observations).toBe(1);
  });
  it('keeps the existing external three-argument T3 wire unchanged', async () => {
    const fixture = await nativeT3Fixture(); cleanup.push(fixture.close);
    const selected = { harness: 't3-code', provider: 'codex-fixture', model: 'fixture-model' } as const;
    await generateText({ model: t3LanguageModel(fixture.config, selected, 'controlled-external-wire'), prompt: 'External T3 input', maxRetries: 0 });
    const launch = fixture.calls.find(entry => entry.name === 't3_thread_launch')!;
    const payload = JSON.parse(launch.arguments.message);
    expect(payload.messages.at(-1).content[0].text).toBe('External T3 input'); expect(payload).toHaveProperty('tools'); expect(payload).toHaveProperty('responseFormat');
    expect(fixture.state.nativeWork).toEqual(['approval-required']); expect(await fixture.cliStarted()).toBe(false);
  });
});
