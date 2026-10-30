import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcpClient } from '../server/machine-worker.ts';
import { TerminalPermissionSession } from '../server/machine/terminal-permissions.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function terminal(answers: string[], tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  let text = '',
    prompts = 0;
  output.on('data', (chunk) => {
    text += String(chunk);
    if (String(chunk).includes('[o] allow')) {
      prompts++;
      const answer = answers.shift();
      if (answer !== undefined) setImmediate(() => input.write(answer + '\n'));
    }
  });
  return { input, output, timeoutMs: 40, observed: () => ({ text, prompts }) };
}
const request = (kind = 'execute') => ({
  toolCall: {
    kind,
    title: '\x1b[31mCommand\x1b[0m',
    rawInput: { command: 'echo fixture' },
  },
  options: [
    { kind: 'allow_once', optionId: 'once' },
    { kind: 'allow_always', optionId: 'permanent' },
  ],
});
describe('Session-scoped ACP terminal permissions', () => {
  it('asks once/session explicitly, defaults to denial, sanitizes terminal text and never grants the external permanent option', async () => {
    const io = terminal(['o', 's', '']);
    const session = new TerminalPermissionSession(
      new AbortController().signal,
      io,
    );
    expect(await session.choose(request())).toBe('once');
    expect(await session.choose(request())).toBe('once');
    expect(await session.choose(request())).toBe('once');
    expect(await session.choose(request('delete'))).toBeUndefined();
    expect(io.observed().prompts).toBe(3);
    expect(io.observed().text).not.toContain('\x1b');
    expect(
      await session.choose({
        ...request(),
        options: [{ kind: 'allow_always', optionId: 'permanent' }],
      }),
    ).toBeUndefined();
    session.close();
    expect(await session.choose(request())).toBeUndefined();
    const next = new TerminalPermissionSession(
      new AbortController().signal,
      terminal(['d']),
    );
    expect(await next.choose(request())).toBeUndefined();
    next.close();
  });
  it('denies non-TTY, unknown kinds, timeout and cancellation without remembering an unapproved kind', async () => {
    const io = terminal(['s'], false);
    const session = new TerminalPermissionSession(
      new AbortController().signal,
      io,
    );
    expect(await session.choose(request())).toBeUndefined();
    expect(io.observed().prompts).toBe(0);
    const waiting = new TerminalPermissionSession(
      new AbortController().signal,
      terminal([]),
    );
    expect(await waiting.choose(request())).toBeUndefined();
    const controller = new AbortController();
    const cancelled = new TerminalPermissionSession(
      controller.signal,
      terminal([]),
    );
    const pending = cancelled.choose(request());
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(await waiting.choose(request('unknown'))).toBeUndefined();
    session.close();
    waiting.close();
    cancelled.close();
  });
  it('sends actual ACP selected/cancelled responses, streams updates and keeps question answers separate from permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-acp-permission-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'agent.cjs');
    await writeFile(
      file,
      `
const readline=require('node:readline'); const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n'); let prompt,results=[];
const permission=(id,kind)=>send({id,method:'session/request_permission',params:{sessionId:'s',toolCall:{kind,title:'Fixture command'},options:[{kind:'allow_once',optionId:'o'+id}]}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new')send({id:m.id,result:{sessionId:'s'}});
else if(m.method==='session/prompt'){prompt=m.id;permission(101,'read');}
else if(m.id===101){results.push(m.result.outcome);permission(102,'read');}
else if(m.id===102){results.push(m.result.outcome);permission(103,'execute');}
else if(m.id===103){results.push(m.result.outcome);send({id:104,method:'session/request_input',params:{sessionId:'s',question:'Pick a label'}});}
else if(m.id===104){send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({summary:JSON.stringify({permissions:results,input:m.result})})}}}});send({id:prompt,result:{stopReason:'end_turn'}});}});
`,
    );
    const io = terminal(['s', 'd']);
    const updates: unknown[] = [];
    const client = new AcpClient({
      command: process.execPath,
      args: [file],
      cwd: dir,
      signal: AbortSignal.timeout(5000),
      permissionTerminal: io,
      onSessionUpdate: (value) => updates.push(value),
      requestInput: async (value) => {
        expect(value).toMatchObject({ question: 'Pick a label' });
        return { answer: 'chosen fixture label' };
      },
    });
    try {
      const result = JSON.parse(
        (await client.run({ kind: 'protocol fixture' })).summary,
      );
      expect(result).toEqual({
        permissions: [
          { outcome: 'selected', optionId: 'o101' },
          { outcome: 'selected', optionId: 'o102' },
          { outcome: 'cancelled' },
        ],
        input: { answer: 'chosen fixture label' },
      });
      expect(io.observed().prompts).toBe(2);
      expect(updates).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});
