import { it } from 'vitest';
import { aiSdkModels } from '../src/index.ts';
import { mockModel, request, textResult } from './helpers.ts';

it('dump', async () => {
  const m = mockModel(textResult('{"a":1}'));
  const set = aiSdkModels({ extract: m, act: m, checkgen: m, judge: m });
  const r = await set.act.generate(request({
    seed: 3, temperature: 0.2, maxOutputTokens: 50, toolChoice: 'auto',
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    output: { name: 'o', schema: { type: 'object', properties: { a: { type: 'number' } } } },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image', png: new Uint8Array([1, 2]), sha256: 'a' }] },
      { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 't', args: { q: 1 } }] },
      { role: 'tool', toolCallId: 'c1', toolName: 't', result: { ok: true } },
    ],
  }));
  (await import('node:fs')).writeFileSync('/tmp/claude-0/-home-user-ai-bdd/0a1cf405-8758-5453-981b-eb6b83c053de/scratchpad/dump.txt', JSON.stringify([JSON.stringify(m.doGenerateCalls[0], (k, v) => (v instanceof Uint8Array ? `U8[${[...v]}]` : v), 1), JSON.stringify(r)]));
});
