import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@ai-bdd/sdk';
import { createFakeModels, type FakeCall } from '@ai-bdd/testing';
import { req } from './helpers.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-model-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rules = [
  {
    rules: [
      { id: 'j', purpose: 'judge' as const, respond: { samples: [{ probability: 1, verdict: 'holds', explanation: 'e', observed: 'o' }] } },
      { id: 'x', purpose: 'extract' as const, respond: { object: { features: [] } } },
    ],
  },
];
const messagesOf = (c: FakeCall | undefined): { content: unknown[] }[] => (c ? (c.request['messages'] as { content: unknown[] }[]) : []);
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const shot = sha256Hex(png);

describe('fake-model call log', () => {
  it('pushes every request and response to calls, in order, across purposes', async () => {
    const m = createFakeModels({ rules });
    await m.extract.generate(req('extract', { a: 1 }));
    await m.judge.generate(req('judge', { sample: 0 }));
    expect(m.calls.map((c) => c.purpose)).toEqual(['extract', 'judge']);
    const [c0] = m.calls as [FakeCall];
    expect(c0.request).toEqual({ purpose: 'extract', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], context: { a: 1 } });
    expect(c0.response).toMatchObject({ object: { features: [] }, toolCalls: [], finishReason: 'stop', modelId: 'fake:extract' });
    expect(c0.response['usage']).toEqual({ inputTokens: 2, outputTokens: expect.any(Number) });
  });

  it('image hashing: images are replaced by {image: sha256} and bytes never reach the log', async () => {
    const m = createFakeModels({ rules, logPath: join(dir, 'log.jsonl') });
    await m.judge.generate(req('judge', { sample: 0 }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', png, sha256: shot }] }] }));
    const content = messagesOf(m.calls[0])[0];
    expect(content?.content).toEqual([{ type: 'text', text: 'see' }, { image: shot }]);
    const raw = readFileSync(join(dir, 'log.jsonl'), 'utf8');
    expect(raw).toContain(`"image":"${shot}"`);
    expect(raw).not.toContain('"png"');
    expect(raw).not.toContain('137,80');
  });

  it('image hash is computed from the bytes when the part carries an empty sha256', async () => {
    const m = createFakeModels({ rules });
    await m.judge.generate(req('judge', { sample: 0 }, { messages: [{ role: 'user', content: [{ type: 'image', png, sha256: '' }] }] }));
    const msg = messagesOf(m.calls[0])[0];
    expect(msg?.content).toEqual([{ image: shot }]);
  });

  it('logPath: appends one JSONL line per call, parseable as FakeCall', async () => {
    const logPath = join(dir, 'nested', 'fake.jsonl');
    const m = createFakeModels({ rules, logPath });
    await m.extract.generate(req('extract', {}));
    await m.judge.generate(req('judge', { sample: 0 }));
    const lines = readFileSync(logPath, 'utf8').split('\n');
    expect(lines.at(-1)).toBe('');
    const parsed = lines.slice(0, -1).map((l) => JSON.parse(l) as FakeCall);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(m.calls)));
  });

  it('appends to an existing log across instances', async () => {
    const logPath = join(dir, 'fake.jsonl');
    await createFakeModels({ rules, logPath }).extract.generate(req('extract', {}));
    await createFakeModels({ rules, logPath }).extract.generate(req('extract', {}));
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('no log file is written without logPath, and no environment variable turns logging on', async () => {
    const before = { ...process.env };
    await createFakeModels({ rules }).extract.generate(req('extract', {}));
    expect(existsSync(join(dir, 'log.jsonl'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
  });

  it('R-JU1: the call log makes the canary assertion possible (no judge request contains a string, act may)', async () => {
    const m = createFakeModels({
      rules: [
        {
          rules: [
            { id: 'a', purpose: 'act', respond: { script: [{ tool: 'complete_step', args: { status: 'done', summary: 'saw CANARY-7f3a' } }] } },
            { id: 'j', purpose: 'judge', respond: { samples: [{ probability: 1, verdict: 'holds', explanation: 'e', observed: 'o' }] } },
          ],
        },
      ],
    });
    const act = await m.act.generate(req('act', { turn: 0 }));
    expect(JSON.stringify(act)).toContain('CANARY-7f3a');
    await m.judge.generate(req('judge', { sample: 0, criterion: 'plan is Pro' }));
    const judgeRequests = m.calls.filter((c) => c.purpose === 'judge').map((c) => JSON.stringify(c.request));
    expect(judgeRequests).toHaveLength(1);
    expect(judgeRequests.some((r) => r.includes('CANARY-7f3a'))).toBe(false);
    // and the same check detects a leak
    await m.judge.generate(req('judge', { sample: 0, leaked: 'CANARY-7f3a' }));
    expect(m.calls.filter((c) => c.purpose === 'judge').some((c) => JSON.stringify(c.request).includes('CANARY-7f3a'))).toBe(true);
  });

  it('the logged request context is a snapshot of what was sent, including tool messages and assistant tool calls', async () => {
    const m = createFakeModels({ rules });
    await m.extract.generate(
      req('extract', { a: 1 }, {
        messages: [
          { role: 'assistant', content: [], toolCalls: [{ id: 't1', name: 'click', args: { ref: 'e1' } }] },
          { role: 'tool', toolCallId: 't1', toolName: 'click', result: { ok: true } },
        ],
      }),
    );
    expect(m.calls[0]?.request['messages']).toEqual([
      { role: 'assistant', content: [], toolCalls: [{ id: 't1', name: 'click', args: { ref: 'e1' } }] },
      { role: 'tool', toolCallId: 't1', toolName: 'click', result: { ok: true } },
    ]);
  });
});
