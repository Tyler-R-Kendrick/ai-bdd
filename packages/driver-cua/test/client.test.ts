import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Policy, ValueSource } from '@ai-bdd/sdk/contracts';
import { McpStdioCuaClient, cua, normalizeResult } from '../src/index.ts';
import type { CuaLaunch } from '../src/index.ts';

const FAKE = fileURLToPath(new URL('./fake-cua-driver.mjs', import.meta.url));
const launch = (mode: string, env: Record<string, string> = {}): CuaLaunch => ({ command: process.execPath, args: [FAKE, mode], env });
const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ai-bdd-cua-client-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('McpStdioCuaClient against a stand-in cua-driver', () => {
  it('connects, lists the tools it serves and passes only a desktop environment plus the configured extras', async () => {
    const report = join(scratch, 'report.json');
    const client = await McpStdioCuaClient.connect(launch('ok', { FAKE_CUA_REPORT: report, EXTRA_FLAG: 'on' }), {
      PATH: process.env['PATH'], LC_ALL: 'C.UTF-8', XDG_RUNTIME_DIR: '/run/user/1', DISPLAY: ':99', OPENAI_API_KEY: 'sk-must-not-leak', UNRELATED: 'x', GONE: undefined,
    });
    try {
      expect([...client.tools].sort()).toEqual(['die', 'echo', 'fail', 'many_lines', 'refuse', 'rpc_error', 'slow', 'structured']);
      const seen = JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv).toEqual(['ok']);
      expect(seen.env).toMatchObject({ LC_ALL: 'C.UTF-8', XDG_RUNTIME_DIR: '/run/user/1', DISPLAY: ':99', EXTRA_FLAG: 'on' });
      expect(seen.env['OPENAI_API_KEY']).toBeUndefined();
      expect(seen.env['UNRELATED']).toBeUndefined();
      expect(seen.env['GONE']).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('callTool normalizes results: text and images, structured content, tool errors and driver refusals', async () => {
    const client = await McpStdioCuaClient.connect(launch('ok'));
    try {
      const echo = await client.callTool('echo', { a: 1 });
      expect(echo.failed).toBe(false);
      expect(echo.text).toBe('echo {"a":1}');
      expect(echo.images).toEqual([{ data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' }]);

      const structured = await client.callTool('structured', { q: 'z' });
      expect(structured).toMatchObject({ failed: false, text: 'has structure', structured: { windows: [{ pid: 1 }], args: { q: 'z' } } });

      expect(await client.callTool('fail', {})).toMatchObject({ failed: true, code: 'broken', text: 'it broke\nwith detail' });
      expect(await client.callTool('refuse', {})).toMatchObject({ failed: true, code: 'stale_element_token', text: 'token is stale' });
    } finally {
      await client.close();
    }
  });

  it('a tool the driver does not serve is DRIVER_UNAVAILABLE naming the tool, without asking the process', async () => {
    const client = await McpStdioCuaClient.connect(launch('no-tools'));
    try {
      expect(client.tools.size).toBe(0);
      const err = await errorOf(client.callTool('click', {}));
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'cua-driver does not serve the tool "click" (version mismatch? update Cua Driver)' });
    } finally {
      await client.close();
    }
  });

  it('a JSON-RPC error from a tool is DRIVER_ERROR with the first line of the message and the cause', async () => {
    const client = await McpStdioCuaClient.connect(launch('ok'));
    try {
      const err = await errorOf(client.callTool('rpc_error', {}));
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({ code: 'DRIVER_ERROR', message: 'cua-driver rpc_error failed: MCP error -32603: internal failure' });
      expect((err as AiBddError).cause).toBeInstanceOf(Error);
    } finally {
      await client.close();
    }
  });

  it('a call that outlives its timeout fails with DRIVER_ERROR and leaves the connection usable', async () => {
    const client = await McpStdioCuaClient.connect(launch('ok'));
    try {
      const err = await errorOf(client.callTool('slow', {}, { timeoutMs: 300 }));
      expect(err).toMatchObject({ code: 'DRIVER_ERROR' });
      expect((err as Error).message).toMatch(/^cua-driver slow failed: MCP error -32001: Request timed out/);
      expect((await client.callTool('echo', { again: true })).text).toBe('echo {"again":true}');
    } finally {
      await client.close();
    }
  });

  it('when the process exits during a call, that call and every later one are DRIVER_UNAVAILABLE "cua-driver has exited"', async () => {
    const client = await McpStdioCuaClient.connect(launch('ok'));
    const during = await errorOf(client.callTool('die', {}));
    expect(during).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'cua-driver has exited' });
    expect((during as AiBddError).cause).toBeInstanceOf(Error);
    const after = await errorOf(client.callTool('echo', {}));
    expect(after).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'cua-driver has exited' });
    expect((after as AiBddError).cause).toBeUndefined(); // refused up front, no round trip attempted
    await client.close();
  });

  it('close() is idempotent and later calls report that the driver has exited', async () => {
    const client = await McpStdioCuaClient.connect(launch('ok'));
    await client.close();
    await client.close();
    expect(await errorOf(client.callTool('echo', {}))).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'cua-driver has exited' });
  });

  it('keeps only the last 20 chunks of the driver\'s stderr', async () => {
    const client = await McpStdioCuaClient.connect(launch('ok'));
    try {
      await client.callTool('many_lines', {});
      await new Promise((r) => setTimeout(r, 200));
      const tail = (client as unknown as { stderrTail: string[] }).stderrTail;
      expect(tail.length).toBeGreaterThan(0);
      expect(tail.length).toBeLessThanOrEqual(20);
      expect(tail.join('')).toContain('noise 29');
    } finally {
      await client.close();
    }
  });

  describe('connection failures are DRIVER_UNAVAILABLE with an actionable message', () => {
    it('a missing executable says so and how to install Cua Driver', async () => {
      const err = await errorOf(McpStdioCuaClient.connect({ command: '/no/such/dir/cua-driver', args: ['mcp'], env: {} }));
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        message: 'cannot start "/no/such/dir/cua-driver": not found. install Cua Driver (https://cua.ai/docs/cua-driver/quickstart) or set the "cuaDriver.command" option.',
      });
      expect((err as AiBddError).cause).toBeInstanceOf(Error);
    });

    it('the default launch is `cua-driver mcp`', async () => {
      const installed = spawnSync('cua-driver', ['--version']).error === undefined;
      if (installed) return; // a real Cua Driver is present; it would connect (covered by real.test.ts)
      await expect(McpStdioCuaClient.connect()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: expect.stringContaining('cannot start "cua-driver": not found.') });
    });

    it('a process that exits before the handshake reports the command and the last three lines it wrote to stderr', async () => {
      const err = await errorOf(McpStdioCuaClient.connect(launch('exit-now')));
      expect(err).toBeInstanceOf(AiBddError);
      const message = (err as AiBddError).message;
      expect((err as AiBddError).code).toBe('DRIVER_UNAVAILABLE');
      expect(message.startsWith(`cannot connect to "${process.execPath} ${FAKE} exit-now": `)).toBe(true);
      expect(message).toContain('Connection closed');
      expect(message.endsWith(' (second line | third line | fourth line)')).toBe(true);
      expect(message).not.toContain('no display available');
    });

    it('a failing tools/list is reported with the first line of the error and no stderr tail when there is none', async () => {
      const err = await errorOf(McpStdioCuaClient.connect(launch('list-error')));
      expect(err).toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
      const message = (err as AiBddError).message;
      expect(message).toBe(`cannot connect to "${process.execPath} ${FAKE} list-error": MCP error -32603: tool registry exploded`);
    });
  });
});

describe('the driver over the real MCP client', () => {
  const resolveValue = (v: ValueSource): string => ('literal' in v ? v.literal : '');

  it('opens a session on the stand-in\'s window, observes it and delivers input in the background', async () => {
    const log = join(scratch, 'calls.jsonl');
    const driver = await cua({
      kind: 'browser', window: { title: '^Fake' }, settleMs: 0, startTimeoutMs: 5000,
      cuaDriver: { command: process.execPath, args: [FAKE, 'desktop'], env: { FAKE_CUA_LOG: log } },
    }).create({ projectRoot: '.', policy, artifactsDir: scratch, baseURL: 'http://localhost:4000' });
    try {
      expect(await driver.selfCheck()).toEqual({ ok: true, problems: [] });
      const session = await driver.openSession({ scenarioId: 's', baseURL: 'http://localhost:4000', policy, resolveValue });
      const obs = await session.observe();
      expect(obs.route).toBe('Fake');
      expect(obs.nodes.map((n) => [n.role, n.name])).toEqual([['document', 'Fake'], ['button', 'Go']]);
      const go = obs.nodes.find((n) => n.name === 'Go');
      expect(await session.perform({ verb: 'click', target: { ref: (go as { ref: string }).ref } })).toEqual({ ok: true });
      await session.close();
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> });
      const click = calls.find((c) => c.name === 'click');
      expect(click?.args).toEqual({ pid: 4242, window_id: 9, element_token: 't:2', delivery_mode: 'background' });
      expect(calls.filter((c) => c.name === 'list_windows').length).toBeGreaterThan(0);
    } finally {
      await driver.dispose();
    }
  });
});

describe('normalizeResult edge cases', () => {
  it('anything that is not an object result is an empty, successful result', () => {
    for (const raw of [undefined, null, 'text', 42, ['x']]) {
      expect(normalizeResult(raw)).toEqual({ failed: false, text: '', structured: {}, images: [] });
    }
  });

  it('skips malformed content blocks, joins text blocks with newlines and defaults the image type', () => {
    const res = normalizeResult({
      content: [
        null, 'x', { type: 'text', text: 7 }, { type: 'text', text: 'one' }, { type: 'image', data: 5 },
        { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64') }, { type: 'image', data: Buffer.from([4]).toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: 'two' }, { type: 'resource' },
      ],
    });
    expect(res.text).toBe('one\ntwo');
    expect(res.images).toEqual([{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }, { data: new Uint8Array([4]), mimeType: 'image/jpeg' }]);
    expect(res.failed).toBe(false);
  });

  it('a refusal or error takes its code and message from the refusal, then from the structured content', () => {
    expect(normalizeResult({ structuredContent: { status: 'refused', refusal: { code: 'a', message: 'refusal message' }, code: 'b', detail: 'detail text' } }))
      .toMatchObject({ failed: true, code: 'a', text: 'refusal message' });
    expect(normalizeResult({ isError: true, structuredContent: { code: 'b', detail: 'detail text' } })).toMatchObject({ failed: true, code: 'b', text: 'detail text' });
    expect(normalizeResult({ isError: true, structuredContent: { refusal: { message: 6 }, code: 'c' } })).toMatchObject({ failed: true, code: 'c', text: '' });
    expect(normalizeResult({ isError: true })).toEqual({ failed: true, text: '', structured: {}, images: [] });
  });

  it('text from the content wins over a refusal message, and a successful result carries no code', () => {
    expect(normalizeResult({ isError: true, content: [{ type: 'text', text: 'actual text' }], structuredContent: { refusal: { message: 'ignored' } } }).text).toBe('actual text');
    const ok = normalizeResult({ structuredContent: { code: 'looks_like_a_code', refusal: { code: 'x' } } });
    expect(ok.failed).toBe(false);
    expect('code' in ok).toBe(false);
  });
});
