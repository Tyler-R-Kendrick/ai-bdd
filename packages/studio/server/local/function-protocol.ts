import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export const FINAL_RESPONSE_FUNCTION = '__studio_final_response';
type Schema = Record<string, any> | boolean;
export type NativeFunctionDefinition = { description?: string; params: Schema };
export type NativeFunctionCall = { functionName: string; params: unknown };
export type NativeHistoryItem =
  | { type: 'system' | 'user'; text: string }
  | { type: 'model'; response: (string | { type: 'functionCall'; name: string; params: unknown; result: unknown })[] };
export type NativeFunctionProtocol = {
  functions: Record<string, NativeFunctionDefinition>;
  history: NativeHistoryItem[];
  originalSchemas: Record<string, Schema>;
  requireCall: boolean;
  finalSchema?: Schema;
};
const ajv = new Ajv({ strict: false, strictSchema: true, strictNumbers: true, allErrors: false, validateFormats: true });
addFormats(ajv);
const invalid = () => new Error('Invalid native function protocol');
function validate(schema: Schema, value?: unknown, check = false) {
  if (check) cloneNativeJson(value);
  try {
    const validator = ajv.compile(schema);
    if ('$async' in validator && validator.$async === true) throw invalid();
    if (check && !validator(value)) throw invalid();
  } finally { if (typeof schema === 'object') ajv.removeSchema(schema); }
}
/** Clone JSON data only after rejecting non-finite numbers before serialization. */
export function cloneNativeJson(value: unknown): unknown {
  // JSON.stringify silently turns non-finite numbers into null. Refuse that
  // change before serializing tool arguments, results, schemas or final data.
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw invalid();
    return item;
  });
  if (encoded === undefined || Buffer.byteLength(encoded) > 120000) throw invalid();
  return JSON.parse(encoded);
}
/** Convert paired SDK tool calls/results into the model's trained function-call history. */
export function nativeFunctionHistory(prompt: readonly any[]): NativeHistoryItem[] {
  const history: NativeHistoryItem[] = [];
  const calls = new Map<string, { name: string; call: { type: 'functionCall'; name: string; params: unknown; result: unknown }; complete: boolean }>();
  const pending = new Set<string>();
  for (const message of prompt) {
    if (message.role !== 'tool' && pending.size) throw invalid();
    if (message.role === 'system') {
      if (typeof message.content !== 'string') throw invalid();
      history.push({ type: 'system', text: message.content }); continue;
    }
    if (!Array.isArray(message.content)) throw invalid();
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') throw invalid();
        const entry = calls.get(part.toolCallId);
        if (!entry || entry.complete || part.toolName !== entry.name || !pending.has(part.toolCallId)) throw invalid();
        entry.call.result = cloneNativeJson(part.output);
        entry.complete = true; pending.delete(part.toolCallId);
      }
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) throw invalid();
    const response: Extract<NativeHistoryItem, { type: 'model' }>['response'] = [];
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') response.push(part.text);
      else if (part.type === 'reasoning' && message.role === 'assistant') continue;
      else if (part.type === 'tool-call' && message.role === 'assistant') {
        if (typeof part.toolCallId !== 'string' || !part.toolCallId || part.toolCallId.length > 200 || calls.has(part.toolCallId) ||
          typeof part.toolName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(part.toolName) || part.toolName === FINAL_RESPONSE_FUNCTION) throw invalid();
        const call = { type: 'functionCall' as const, name: part.toolName, params: cloneNativeJson(part.input), result: undefined as unknown };
        calls.set(part.toolCallId, { name: part.toolName, call, complete: false }); pending.add(part.toolCallId); response.push(call);
      } else throw invalid();
    }
    if (message.role === 'user') history.push({ type: 'user', text: response.join('\n') });
    else history.push({ type: 'model', response });
  }
  if (pending.size || history.length > 100 || Buffer.byteLength(JSON.stringify(history)) > 120000) throw invalid();
  return history;
}
/** All definitions are data only. The isolated CPU worker receives no function handlers. */
export function prepareNativeFunctionProtocol(options: any, transform: (schema: Schema) => Schema): NativeFunctionProtocol {
  if (options.tools?.some((tool: any) => tool.type !== 'function')) throw invalid();
  const advertised = options.tools ?? [];
  if (!Array.isArray(advertised) || advertised.length > 64) throw invalid();
  const originalSchemas: Record<string, Schema> = Object.create(null);
  const functions: Record<string, NativeFunctionDefinition> = Object.create(null);
  for (const tool of advertised) {
    if (typeof tool.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(tool.name) ||
      ['__proto__', 'constructor', 'prototype', FINAL_RESPONSE_FUNCTION].includes(tool.name) || Object.hasOwn(originalSchemas, tool.name) ||
      (tool.description !== undefined && typeof tool.description !== 'string')) throw invalid();
    const originalSchema = cloneNativeJson(tool.inputSchema) as Schema;
    validate(originalSchema);
    originalSchemas[tool.name] = originalSchema;
    if (options.toolChoice?.type !== 'none' && (options.toolChoice?.type !== 'tool' || options.toolChoice.toolName === tool.name))
      functions[tool.name] = { ...(tool.description === undefined ? {} : { description: tool.description }), params: transform(originalSchema) };
  }
  const requireCall = ['required', 'tool'].includes(options.toolChoice?.type ?? 'auto');
  if (requireCall && !Object.keys(functions).length) throw invalid();
  const finalSchema = options.responseFormat?.type === 'json' ? cloneNativeJson(options.responseFormat.schema ?? true) as Schema : undefined;
  if (finalSchema !== undefined) {
    validate(finalSchema);
    if (!requireCall && Object.keys(functions).length)
      functions[FINAL_RESPONSE_FUNCTION] = { description: 'Return the final response matching the requested JSON schema. This is output only and is never executed.', params: transform(finalSchema) };
  }
  if (Buffer.byteLength(JSON.stringify(functions)) > 48000 ||
    Buffer.byteLength(JSON.stringify({ originalSchemas, finalSchema })) > 48000) throw invalid();
  if (options.toolChoice && !['auto', 'none', 'required', 'tool'].includes(options.toolChoice.type)) throw invalid();
  const history = nativeFunctionHistory(options.prompt);
  for (const item of history) if (item.type === 'model') for (const part of item.response)
    if (typeof part !== 'string') {
      if (!Object.hasOwn(originalSchemas, part.name)) throw invalid();
      validate(originalSchemas[part.name]!, part.params, true);
    }
  return { functions, originalSchemas, history, requireCall, ...(finalSchema === undefined ? {} : { finalSchema }) };
}
/** Validate native parser output against the exact advertised names and ORIGINAL schemas. */
export function projectNativeFunctionResponse(protocol: NativeFunctionProtocol, result: { text: string; functionCalls?: NativeFunctionCall[] }) {
  if (typeof result.text !== 'string' || result.text.length > 50000) throw invalid();
  const calls = result.functionCalls ?? [];
  if (!Array.isArray(calls) || calls.length > 4) throw invalid();
  if (calls.length) {
    for (const call of calls) {
      if (!call || typeof call.functionName !== 'string' || !Object.hasOwn(protocol.functions, call.functionName)) throw invalid();
      const schema = call.functionName === FINAL_RESPONSE_FUNCTION ? protocol.finalSchema : protocol.originalSchemas[call.functionName];
      if (schema === undefined) throw invalid();
      validate(schema, call.params, true); cloneNativeJson(call.params);
    }
    if (calls.some(call => call.functionName === FINAL_RESPONSE_FUNCTION)) {
      if (calls.length !== 1 || protocol.requireCall) throw invalid();
      return { calls: [], text: JSON.stringify(calls[0]!.params) };
    }
    return { calls: calls.map(call => ({ name: call.functionName, input: call.params })), text: result.text };
  }
  if (protocol.requireCall) throw invalid();
  if (protocol.finalSchema !== undefined) {
    let value: unknown; try { value = JSON.parse(result.text); } catch { throw invalid(); }
    validate(protocol.finalSchema, value, true);
  }
  return { calls: [], text: result.text };
}
