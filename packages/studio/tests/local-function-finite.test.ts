import { describe, expect, it } from 'vitest';
import { FINAL_RESPONSE_FUNCTION, prepareNativeFunctionProtocol, projectNativeFunctionResponse } from '../server/local/function-protocol.ts';

const options = (schema: unknown = true) => ({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Controlled finite JSON boundary.' }] }],
  tools: [{ type: 'function', name: 'inspect_value', inputSchema: schema }],
});
const protocol = (schema: unknown = true) => prepareNativeFunctionProtocol(options(schema), value => value);
const response = (params: unknown, functionName = 'inspect_value') => ({ text: '', functionCalls: [{ functionName, params }] });

describe('native function JSON numeric values', () => {
  it.each([NaN, Infinity, -Infinity, JSON.parse('1e999'), JSON.parse('-1e999')])('rejects non-finite arguments without normalization (%s)', value => {
    for (const params of [value, { nested: [value] }])
      expect(() => projectNativeFunctionResponse(protocol(), response(params))).toThrow();
    expect(() => projectNativeFunctionResponse(protocol({ type: 'number' }), response(value))).toThrow();
  });

  it('rejects non-finite structured finals, including overflow parsed from valid JSON syntax', () => {
    const value = prepareNativeFunctionProtocol({ ...options(), responseFormat: { type: 'json', schema: true } }, schema => schema);
    for (const params of [NaN, Infinity, -Infinity, { nested: [JSON.parse('1e999')] }])
      expect(() => projectNativeFunctionResponse(value, response(params, FINAL_RESPONSE_FUNCTION))).toThrow();
    for (const text of ['1e999', '-1e999', '{"nested":[1e999]}'])
      expect(() => projectNativeFunctionResponse(value, { text })).toThrow();
  });

  it('refuses invalid historical arguments and results before serializing them as null', () => {
    for (const inResult of [false, true]) {
      const value = options();
      const prompt: any[] = [
        ...value.prompt,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'owned-read', toolName: 'inspect_value', input: inResult ? 4 : { nested: Infinity } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'owned-read', toolName: 'inspect_value', output: { type: 'json', value: inResult ? { nested: NaN } : 4 } }] },
      ];
      expect(() => prepareNativeFunctionProtocol({ ...value, prompt }, schema => schema)).toThrow();
    }
  });

  it('preserves finite numeric values, including the largest finite IEEE number', () => {
    for (const params of [Number.MAX_VALUE, -Number.MAX_VALUE, 0, 42.25, { nested: [Number.MAX_VALUE, 42.25] }]) {
      const result = projectNativeFunctionResponse(protocol(), response(params));
      expect(result.calls[0]!.input).toEqual(params);
      expect(JSON.parse(JSON.stringify(result.calls[0]!.input))).toEqual(params);
    }
    const value = prepareNativeFunctionProtocol({ ...options(), responseFormat: { type: 'json', schema: { type: 'number' } } }, schema => schema);
    expect(projectNativeFunctionResponse(value, { text: '1.7976931348623157e308' })).toEqual({ calls: [], text: '1.7976931348623157e308' });
    expect(projectNativeFunctionResponse(value, response(Number.MAX_VALUE, FINAL_RESPONSE_FUNCTION))).toEqual({ calls: [], text: JSON.stringify(Number.MAX_VALUE) });
  });
});
