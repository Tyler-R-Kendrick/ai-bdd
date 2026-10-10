// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@ai-bdd/sdk';
import { createFakeModels } from '@ai-bdd/testing';
import { req } from './helpers.ts';

describe('fake-model usage accounting', () => {
  const m = createFakeModels({
    rules: [{ rules: [{ id: 'o', purpose: 'extract', respond: { object: { a: 'xyz' } } }, { id: 't', purpose: 'checkgen', respond: { text: 'abcdefghi' } }] }],
  });

  it('inputTokens = ceil(totalChars / 4) over system + message text', async () => {
    // system 3 chars + user text 5 chars = 8 -> 2 tokens
    const r = await m.extract.generate(req('extract', {}, { system: 'abc', messages: [{ role: 'user', content: [{ type: 'text', text: 'defgh' }] }] }));
    expect(r.usage.inputTokens).toBe(2);
    // 9 chars -> 3 tokens (ceil)
    const r2 = await m.extract.generate(req('extract', {}, { system: 'abc', messages: [{ role: 'user', content: [{ type: 'text', text: 'defghi' }] }] }));
    expect(r2.usage.inputTokens).toBe(3);
  });

  it('counts multi-part, assistant, tool-call and tool-result content; images and context do not count', async () => {
    const base = req('extract', { big: 'x'.repeat(4000) }, { system: '', messages: [] });
    expect((await m.extract.generate(base)).usage.inputTokens).toBe(0);
    const withImage = req('extract', {}, {
      system: '',
      messages: [{ role: 'user', content: [{ type: 'image', png: new Uint8Array(4000), sha256: 'a'.repeat(64) }, { type: 'text', text: 'abcd' }] }],
    });
    expect((await m.extract.generate(withImage)).usage.inputTokens).toBe(1);
    const toolResult = { ok: true };
    const rich = req('extract', {}, {
      system: '',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'abcd' }], toolCalls: [{ id: 'c', name: 'click', args: { ref: 'e1' } }] },
        { role: 'tool', toolCallId: 'c', toolName: 'click', result: toolResult },
      ],
    });
    const expected = Math.ceil((4 + canonicalJson([{ id: 'c', name: 'click', args: { ref: 'e1' } }]).length + canonicalJson(toolResult).length) / 4);
    expect((await m.extract.generate(rich)).usage.inputTokens).toBe(expected);
  });

  it('outputTokens = ceil(chars / 4) over the response JSON', async () => {
    const r = await m.extract.generate(req('extract', {}));
    expect(r.usage.outputTokens).toBe(Math.ceil(canonicalJson({ object: { a: 'xyz' }, toolCalls: [] }).length / 4));
    const t = await m.checkgen.generate(req('checkgen', {}));
    expect(t.usage.outputTokens).toBe(Math.ceil(canonicalJson({ text: 'abcdefghi', toolCalls: [] }).length / 4));
  });

  it('tool-call responses count their calls in outputTokens', async () => {
    const a = createFakeModels({ rules: [{ rules: [{ id: 'a', purpose: 'act', respond: { script: [{ tool: 'back' }] } }] }] });
    const r = await a.act.generate(req('act', { turn: 0 }));
    expect(r.usage.outputTokens).toBe(Math.ceil(canonicalJson({ toolCalls: r.toolCalls as never }).length / 4));
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  });
});
