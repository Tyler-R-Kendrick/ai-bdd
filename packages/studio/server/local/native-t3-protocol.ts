import type { LanguageModel } from 'ai';
import { createHash } from 'node:crypto';
import type { AgentProfile } from '../../shared/agent-profile.ts';
type NativeModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CpuModel = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type NativeCall = Parameters<NativeModel['doGenerate']>[0];
type CpuCall = Parameters<CpuModel['doGenerate']>[0];
type CpuToolResult = Extract<Extract<CpuCall['prompt'][number], { role: 'tool' }>['content'][number], { type: 'tool-result' }>;
import { cloneNativeJson, prepareNativeFunctionProtocol, projectNativeFunctionResponse } from './function-protocol.ts';

export const NATIVE_T3_FUNCTION_PROTOCOL_REVISION = 'managed-native-t3-functions-v1';
export const NATIVE_T3_TRANSPORT_PROTOCOL_REVISION = 'managed-native-t3-reference-v1';
/** Chat execution changed; encrypted archive encoding and decision/weight identities did not. */
export function managedT3FunctionStateId(input: { t3Commit: string; openCodeVersion: string; artifactId: string; profile: AgentProfile; idempotencyKey: string }) {
  return createHash('sha256').update(JSON.stringify([
    NATIVE_T3_FUNCTION_PROTOCOL_REVISION, NATIVE_T3_TRANSPORT_PROTOCOL_REVISION, input.t3Commit, input.openCodeVersion, input.artifactId, input.profile, input.idempotencyKey,
  ])).digest('hex');
}

/** V3 file data differs from V4. Convert only the text/function subset this CPU engine supports. */
export function nativeT3CpuPrompt(prompt: NativeCall['prompt'] | CpuCall['prompt']): CpuCall['prompt'] {
  return prompt.map(message => {
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user') return { role: 'user', content: message.content.map(part => {
      if (part.type !== 'text') throw new Error('Unsupported local prompt media');
      return { type: 'text', text: part.text };
    }) };
    if (message.role === 'assistant') return { role: 'assistant', content: message.content.map(part => {
      if (part.type === 'text' || part.type === 'reasoning') return { type: part.type, text: part.text };
      if (part.type === 'tool-call' && !part.providerExecuted) return { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
      throw new Error('Unsupported local provider response');
    }) };
    if (message.role !== 'tool') throw new Error('Unsupported local prompt role');
    return { role: 'tool', content: message.content.map(part => {
      if (part.type !== 'tool-result') throw new Error('Unsupported local provider result');
      // Output wrappers remain JSON data; no media fetch or provider execution is introduced.
      const output = cloneNativeJson(part.output) as CpuToolResult['output'];
      return { type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output };
    }) };
  });
}

/** Keep Studio's typed SDK tools and conversation separate from the native text transport. */
export function nativeT3CpuOptions(call: NativeCall, prompt: NativeCall['prompt'] | CpuCall['prompt']): CpuCall {
  const cpuPrompt = nativeT3CpuPrompt(prompt);
  prepareNativeFunctionProtocol({ ...call, prompt: cpuPrompt }, schema => schema);
  return {
    prompt: cpuPrompt,
    tools: call.tools ?? [],
    toolChoice: call.toolChoice ?? { type: 'auto' },
    ...(call.responseFormat ? { responseFormat: call.responseFormat } : {}),
    maxOutputTokens: Math.min(1024, Math.max(1, call.maxOutputTokens ?? 1024)),
    ...(call.stopSequences ? { stopSequences: call.stopSequences } : {}),
  };
}

/** The native harness carries JSON text only; Studio's SDK loop alone executes returned calls. */
export function nativeT3ResultEnvelope(call: any, result: any): string {
  if (!Array.isArray(result.content)) throw new Error('Invalid native provider response');
  let text = '';
  const functionCalls: { functionName: string; params: unknown }[] = [];
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') text += part.text;
    else if (part.type === 'tool-call' && typeof part.toolName === 'string' && typeof part.input === 'string')
      functionCalls.push({ functionName: part.toolName, params: JSON.parse(part.input) });
    else throw new Error('Invalid native provider response');
  }
  const protocol = prepareNativeFunctionProtocol(call, schema => schema);
  const value = projectNativeFunctionResponse(protocol, { text, functionCalls });
  if (value.calls.length) return JSON.stringify({ type: 'tool_calls', calls: value.calls });
  // Structured data may itself look like a tool_calls envelope. Wrap once so
  // the outer native transport never reinterprets final data as tool intent.
  return JSON.stringify({ type: 'final', text: value.text });
}
