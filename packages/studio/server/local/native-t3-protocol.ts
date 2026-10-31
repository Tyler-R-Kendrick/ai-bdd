import type { LanguageModel } from 'ai';
type NativeModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CpuModel = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type NativeCall = Parameters<NativeModel['doGenerate']>[0];
type CpuCall = Parameters<CpuModel['doGenerate']>[0];
import { prepareNativeFunctionProtocol, projectNativeFunctionResponse } from './function-protocol.ts';

/** Keep Studio's typed SDK tools and conversation separate from the native text transport. */
export function nativeT3CpuOptions(call: NativeCall, prompt: CpuCall['prompt']): CpuCall {
  prepareNativeFunctionProtocol({ ...call, prompt }, schema => schema);
  return {
    prompt,
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
  return call.responseFormat?.type === 'json' ? value.text : JSON.stringify({ type: 'final', text: value.text });
}
