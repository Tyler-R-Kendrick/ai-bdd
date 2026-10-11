import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Driver, DriverAction, DriverSession, Observation, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { CuaSession, capabilitiesFor, cua } from '../src/index.ts';
import type { CuaOptions, CuaToolResult, SessionConfig } from '../src/index.ts';
import { PAGE, ScriptedClient, WINDOW, failedResult, okResult, snapshot } from './scripted.ts';
import type { Handler } from './scripted.ts';

const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const SECRET = 'hunter22';
const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({
  scenarioId: 's', baseURL: 'http://localhost:4000', policy,
  resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? SECRET : ''), ...over,
});
const windows = okResult({ windows: [WINDOW] });
const standard: Handler = (tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE) : okResult({}, 'done'));
const bareFailure = (text = '', code?: string): CuaToolResult => ({ failed: true, text, structured: {}, images: [], ...(code === undefined ? {} : { code }) });

const drivers: Driver[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const d of drivers.splice(0)) await d.dispose();
});

async function open(handler: Handler = standard, o: CuaOptions = {}, so: Partial<SessionOptions> = {}): Promise<{ client: ScriptedClient; session: DriverSession; obs: Observation; ref: (role: string, name: string) => string }> {
  const client = new ScriptedClient(handler);
  const driver = await cua({ kind: 'browser', window: { title: 'Probe' }, startTimeoutMs: 300, settleMs: 0, connect: async () => client, ...o })
    .create({ projectRoot: '.', policy, artifactsDir: '.', baseURL: 'http://localhost:4000' });
  drivers.push(driver);
  const session = await driver.openSession(opts(so));
  const obs = await session.observe();
  const ref = (role: string, name: string): string => {
    const n = obs.nodes.find((x) => x.role === role && x.name === name);
    if (n === undefined) throw new Error(`no ${role} ${name}`);
    return n.ref;
  };
  return { client, session, obs, ref };
}

describe('how Cua Driver refusals are reported', () => {
  const cases: [string, CuaToolResult, string, string][] = [
    ['a stale token with text', failedResult('stale_element_token', 'old handle'), 'STALE_REF', 'click: old handle'],
    ['a stale token without text', failedResult('stale_element_token', ''), 'STALE_REF', 'click: the element handle is stale'],
    ['element_not_found', failedResult('element_not_found', ''), 'TARGET_NOT_FOUND', 'click: element_not_found'],
    ['no_such_element with text', failedResult('no_such_element', 'gone'), 'TARGET_NOT_FOUND', 'click: gone'],
    ['missing_element', failedResult('missing_element', ''), 'TARGET_NOT_FOUND', 'click: missing_element'],
    ['window_gone', failedResult('window_gone', ''), 'TARGET_NOT_FOUND', 'click: window_gone'],
    ['no_window', failedResult('no_window', ''), 'TARGET_NOT_FOUND', 'click: no_window'],
    ['any other code with text', failedResult('typing_failed', 'cannot type'), 'DRIVER_ERROR', 'click: cannot type'],
    ['any other code without text', failedResult('typing_failed', ''), 'DRIVER_ERROR', 'click: typing_failed'],
    ['no code and no text', bareFailure(), 'DRIVER_ERROR', 'click: cua-driver reported an error'],
    ['a multi-line text keeps its first line, trimmed', failedResult('x', '  first line  \nsecond line'), 'DRIVER_ERROR', 'click: first line'],
  ];
  it.each(cases)('%s', async (_label, result, code, message) => {
    const { session, ref } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE) : result));
    const r = await session.perform({ verb: 'click', target: { ref: ref('button', 'Go') } });
    expect(r).toMatchObject({ ok: false, error: { code, message } });
  });

  it('long messages are cut at 300 characters', async () => {
    const { session, ref } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE) : failedResult('x', 'y'.repeat(500))));
    const r = await session.perform({ verb: 'click', target: { ref: ref('button', 'Go') } });
    expect(r.error?.message).toBe(`click: ${'y'.repeat(300)}...`);
  });

  it('a get_window_state failure is DRIVER_UNAVAILABLE when the window is gone and DRIVER_ERROR otherwise, with the best available text', async () => {
    let result: CuaToolResult = bareFailure();
    let broken = false;
    const { session } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? (broken ? result : snapshot(PAGE)) : undefined));
    broken = true;
    const probe = async (r: CuaToolResult): Promise<unknown> => {
      result = r;
      return session.observe().then(() => undefined, (e: unknown) => e);
    };
    expect(await probe(failedResult('window_not_found', 'no such window\nmore'))).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'get_window_state: no such window' });
    expect(await probe(failedResult('element_not_found', ''))).toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'get_window_state: element_not_found' });
    expect(await probe(failedResult('target_gone', 'x'))).toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    expect(await probe(failedResult('permission_denied', 'accessibility is off'))).toMatchObject({ code: 'DRIVER_ERROR', message: 'get_window_state: accessibility is off' });
    expect(await probe(failedResult('permission_denied', ''))).toMatchObject({ code: 'DRIVER_ERROR', message: 'get_window_state: permission_denied' });
    expect(await probe(bareFailure())).toMatchObject({ code: 'DRIVER_ERROR', message: 'get_window_state: failed' });
  });
});

describe('observing', () => {
  const partial = (): Handler => (tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE, { truncated: true }) : undefined);

  it('a walk that is still partial after the retry is returned as it is', async () => {
    const { client, session } = await open(partial(), { treeTimeoutMs: 1000 });
    const before = client.of('get_window_state').length;
    const obs = await session.observe();
    const budgets = client.of('get_window_state').slice(before).map((c) => c.args['timeout_ms']);
    expect(budgets).toEqual([1000, 2000]);
    expect(obs.nodes.length).toBeGreaterThan(0);
  });

  it('the doubled budget is capped at two minutes and a budget already at the cap is not retried', async () => {
    const big = await open(partial(), { treeTimeoutMs: 100_000 });
    const before = big.client.of('get_window_state').length;
    await big.session.observe();
    expect(big.client.of('get_window_state').slice(before).map((c) => c.args['timeout_ms'])).toEqual([100_000, 120_000]);
    const max = await open(partial(), { treeTimeoutMs: 120_000 });
    const beforeMax = max.client.of('get_window_state').length;
    await max.session.observe();
    expect(max.client.of('get_window_state').slice(beforeMax).map((c) => c.args['timeout_ms'])).toEqual([120_000]);
  });

  it('the call itself gets 15 seconds more than the walk budget', async () => {
    const calls: unknown[] = [];
    const client = new ScriptedClient(standard);
    const original = client.callTool.bind(client);
    client.callTool = ((tool: string, args: Record<string, unknown>, o?: { timeoutMs?: number }) => {
      calls.push([tool, o]);
      return original(tool, args);
    }) as typeof client.callTool;
    const driver = await cua({ kind: 'browser', window: { title: 'Probe' }, treeTimeoutMs: 1234, settleMs: 0, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    drivers.push(driver);
    const session = await driver.openSession(opts());
    await session.observe();
    expect(calls.filter((c) => (c as [string, unknown])[0] === 'get_window_state').map((c) => (c as [string, { timeoutMs: number }])[1].timeoutMs)).toEqual([16_234, 16_234]);
  });

  it('pixels:true without an image in the result yields no screenshot', async () => {
    const { session } = await open(standard);
    const obs = await session.observe({ pixels: true });
    expect(obs.screenshot).toBeUndefined();
  });

  it('a window title that is not text reads as empty', async () => {
    const { session } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE, { window_title: 5 }) : undefined));
    const obs = await session.observe();
    expect(obs.route).toBe('/');
    expect(obs.title).toBeUndefined();
  });

  it('secrets are scrubbed from the window title as well', async () => {
    let title = 'Probe';
    const { session, ref } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE, { window_title: title }) : okResult()));
    const first = await session.observe();
    await session.perform({ verb: 'fill', target: { ref: first.nodes.find((n) => n.name === 'Name')?.ref ?? ref('textbox', 'Name') }, value: { secret: 's' } });
    title = `Account ${SECRET}`;
    expect((await session.observe()).title).toBe('Account ***');
  });
});

describe('actions that fail part way', () => {
  const failing = (match: (tool: string, args: Record<string, unknown>) => boolean, text = 'refused'): Handler =>
    (tool, args) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE) : match(tool, args) ? failedResult('x', text) : okResult());

  it('fill stops at the first step that fails and reports which one', async () => {
    const run = async (match: (tool: string, args: Record<string, unknown>) => boolean) => {
      const { client, session, ref } = await open(failing(match));
      const r = await session.perform({ verb: 'fill', target: { ref: ref('textbox', 'Name') }, value: { literal: 'Alice' } });
      return { r, tools: client.calls.slice(client.calls.findIndex((c) => c.tool === 'click')).map((c) => c.tool) };
    };
    const focus = await run((tool) => tool === 'click');
    expect(focus.r.error?.message).toBe('click: refused');
    expect(focus.tools).toEqual(['click']);
    const selectAll = await run((tool, args) => tool === 'press_key' && args['key'] === 'A');
    expect(selectAll.r.error?.message).toBe('press Control+A: refused');
    expect(selectAll.tools).toEqual(['click', 'press_key']);
    const typed = await run((tool) => tool === 'type_text');
    expect(typed.r.error?.message).toBe('type: refused');
    expect(typed.tools).toEqual(['click', 'press_key', 'type_text']);
  });

  it('clearing a field reports a failing Backspace', async () => {
    const { session, ref } = await open(failing((tool, args) => tool === 'press_key' && args['key'] === 'backspace'));
    const r = await session.perform({ verb: 'fill', target: { ref: ref('textbox', 'Name') }, value: { literal: '' } });
    expect(r.error?.message).toBe('press Backspace: refused');
  });

  it('a secret that is only two characters is still redacted from messages; an empty one only taints', async () => {
    const short = await open(failing((tool) => tool === 'type_text', 'cannot type ab here'), {}, { resolveValue: (v) => ('secret' in v ? 'ab' : '') });
    const r = await short.session.perform({ verb: 'fill', target: { ref: short.ref('textbox', 'Name') }, value: { secret: 'x' } });
    expect(r.error?.message).toBe('type: cannot type *** here');
    expect((await short.session.observe()).tainted).toBe(true);

    const empty = await open(standard, {}, { resolveValue: () => '' });
    const cleared = await empty.session.perform({ verb: 'fill', target: { ref: empty.ref('textbox', 'Name') }, value: { secret: 'x' } });
    expect(cleared).toEqual({ ok: true });
    expect(empty.client.of('type_text')).toHaveLength(0); // an empty value clears the field instead of typing
    expect((await empty.session.observe()).tainted).toBe(true);
  });

  it('press: a failing focus click stops before the key; a failing key is reported with its spec', async () => {
    const focus = await open(failing((tool) => tool === 'click'));
    const a = await focus.session.perform({ verb: 'press', key: 'Enter', target: { ref: focus.ref('textbox', 'Name') } });
    expect(a.error?.message).toBe('click: refused');
    expect(focus.client.of('press_key')).toHaveLength(0);
    const key = await open(failing((tool) => tool === 'press_key'));
    const b = await key.session.perform({ verb: 'press', key: 'Control+Shift+K' });
    expect(b.error?.message).toBe('press Control+Shift+K: refused');
    expect(b.ok).toBe(false);
  });

  it('check: a failing click is reported; an already matching state needs none', async () => {
    const rows = [...PAGE.slice(0, 5), { element_index: 5, role: 'check box', label: 'Terms', parent_index: 4, in_web_content: true, checked: false }, { element_index: 6, role: 'heading', label: 'H', parent_index: 4, in_web_content: true }];
    const { session, ref, client } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(rows) : failedResult('x', 'refused')));
    expect((await session.perform({ verb: 'check', target: { ref: ref('checkbox', 'Terms') }, checked: false })).ok).toBe(true);
    expect(client.of('click')).toHaveLength(0);
    expect((await session.perform({ verb: 'check', target: { ref: ref('checkbox', 'Terms') }, checked: true })).error?.message).toBe('click: refused');
  });

  it('scroll, navigate and back report the step that failed', async () => {
    const scroll = await open(failing((tool) => tool === 'scroll'));
    expect((await scroll.session.perform({ verb: 'scroll', direction: 'down' })).error?.message).toBe('scroll: refused');

    const stepFails = async (match: (tool: string, args: Record<string, unknown>) => boolean) => {
      const { session, client } = await open(failing(match));
      const before = client.calls.length;
      const r = await session.perform({ verb: 'navigate', url: '/next' });
      return { r, tools: client.calls.slice(before).map((c) => `${c.tool}:${String(c.args['key'] ?? c.args['text'])}`) };
    };
    const l = await stepFails((tool, args) => tool === 'press_key' && args['key'] === 'L');
    expect(l.r.error?.message).toBe('press Control+L: refused');
    expect(l.tools).toEqual(['press_key:L']);
    const typed = await stepFails((tool) => tool === 'type_text');
    expect(typed.r.error?.message).toBe('type: refused');
    expect(typed.tools).toEqual(['press_key:L', 'type_text:http://localhost:4000/next']);
    const enter = await stepFails((tool, args) => tool === 'press_key' && args['key'] === 'enter');
    expect(enter.r.error?.message).toBe('press Enter: refused');
    expect(enter.r.navigatedTo).toBeUndefined();

    const back = await open(failing((tool) => tool === 'press_key'));
    expect((await back.session.perform({ verb: 'back' })).error?.message).toBe('press Alt+Left: refused');
  });

  it('a relative navigate resolves against the session baseURL, which wins over the driver\'s', async () => {
    const { session } = await open(standard, {}, { baseURL: 'http://localhost:5000' });
    expect(await session.perform({ verb: 'navigate', url: '/x' })).toEqual({ ok: true, navigatedTo: 'http://localhost:5000/x' });
  });
});

describe('errors thrown by the connection', () => {
  const throwing = async (error: unknown) => {
    let armed = false;
    const { session, ref } = await open((tool) => {
      if (armed && tool === 'click') throw error;
      return tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE) : okResult();
    });
    armed = true;
    return session.perform({ verb: 'click', target: { ref: ref('button', 'Go') } });
  };

  it('an AiBddError keeps its code and message', async () => {
    expect(await throwing(new AiBddError('DRIVER_UNAVAILABLE', 'cua-driver has exited'))).toEqual({ ok: false, error: { code: 'DRIVER_UNAVAILABLE', message: 'cua-driver has exited', retryable: true } });
  });

  it('any other error becomes DRIVER_ERROR with its first line; non-errors are stringified', async () => {
    expect(await throwing(new Error('socket closed\nstack-ish second line'))).toMatchObject({ ok: false, error: { code: 'DRIVER_ERROR', message: 'socket closed' } });
    expect(await throwing('plain string')).toMatchObject({ ok: false, error: { code: 'DRIVER_ERROR', message: 'plain string' } });
  });
});

describe('delivery', () => {
  it('auto only falls back on background_unavailable: any other failure is the answer after one attempt', async () => {
    const { session, client, ref } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE) : failedResult('typing_failed', 'nope')));
    const r = await session.perform({ verb: 'click', target: { ref: ref('button', 'Go') } });
    expect(r.error?.message).toBe('click: nope');
    expect(client.of('click').map((c) => c.args['delivery_mode'])).toEqual(['background']);
  });

  it('once the foreground was needed every tool goes there, and each input carries pid, window and the action timeout', async () => {
    const { session, client, ref } = await open((tool, args) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') return snapshot(PAGE);
      return args['delivery_mode'] === 'background' ? failedResult('background_unavailable', 'no') : okResult();
    });
    await session.perform({ verb: 'press', key: 'Enter' });
    await session.perform({ verb: 'scroll', direction: 'down' });
    expect(client.of('press_key').map((c) => c.args['delivery_mode'])).toEqual(['background', 'foreground']);
    expect(client.of('scroll').map((c) => c.args['delivery_mode'])).toEqual(['foreground']);
    expect(client.of('scroll')[0]?.args).toMatchObject({ pid: 600, window_id: 4194306, direction: 'down', amount: 5 });
    expect(ref('button', 'Go')).toMatch(/^r\d+:e7$/);
  });
});

describe('verbs and refs', () => {
  it('names the verbs a driver kind does not offer; a native app is pointed at kind "browser"', async () => {
    const app = await open(standard, { kind: 'app' });
    expect((await app.session.perform({ verb: 'navigate', url: '/x' })).error?.message).toBe('verb navigate is not supported by the cua driver for a native app (use kind "browser" for browser windows)');
    expect((await app.session.perform({ verb: 'back' })).error?.message).toBe('verb back is not supported by the cua driver for a native app (use kind "browser" for browser windows)');
    expect((await app.session.perform({ verb: 'hover', target: { ref: 'r1:e1' } })).error?.message).toBe('verb hover is not supported by the cua driver');
    const browser = await open(standard, { kind: 'browser' });
    expect(await browser.session.perform({ verb: 'select', target: { ref: 'r1:e1' }, option: { literal: 'x' } })).toMatchObject({ ok: false, error: { code: 'VERB_UNSUPPORTED', message: 'verb select is not supported by the cua driver', retryable: false } });
  });

  it('refs must look like r<revision>:e<index>', async () => {
    const { session } = await open();
    for (const ref of ['e7', 'r1:n5', 'r1:e', 'x', '']) {
      const r = await session.perform({ verb: 'click', target: { ref } });
      expect(r).toEqual({ ok: false, error: { code: 'STALE_REF', message: `ref ${JSON.stringify(ref)} is not of the form r<revision>:e<index>; use a ref from the latest observation`, retryable: false } });
    }
  });

  it('wait is capped at five seconds, and negative or infinite requests wait for nothing', async () => {
    const { session } = await open();
    vi.useFakeTimers();
    let done = false;
    const long = session.perform({ verb: 'wait', ms: 60_000 }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await long).toEqual({ ok: true });
    for (const ms of [-50, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      const quick = session.perform({ verb: 'wait', ms });
      await vi.advanceTimersByTimeAsync(0);
      expect(await quick).toEqual({ ok: true });
    }
  });

  it('settleMs pauses after an input action but not after wait or a failure', async () => {
    const { session, ref } = await open(standard, { settleMs: 500 });
    vi.useFakeTimers();
    let done = false;
    const click = session.perform({ verb: 'click', target: { ref: ref('button', 'Go') } }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await click).toEqual({ ok: true });
  });
});

describe('CuaSession used directly', () => {
  const cfg: SessionConfig = { kind: 'browser', scope: 'content', delivery: 'auto', treeTimeoutMs: 1000, actionTimeoutMs: 1000, settleMs: 0, titleSuffix: undefined };
  const make = (onClose?: () => Promise<void>, verbs: DriverAction['verb'][] = ['click']): CuaSession =>
    new CuaSession(new ScriptedClient(standard), { pid: 1, windowId: 2 }, opts(), { policy }, cfg, { ...capabilitiesFor('browser', 1), verbs }, onClose);

  it('close() runs the close hook once and swallows its failure', async () => {
    const hook = vi.fn(async () => {
      throw new Error('app already gone');
    });
    const session = make(hook);
    await expect(session.close()).resolves.toBeUndefined();
    await session.close();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await session.perform({ verb: 'wait', ms: 0 })).toMatchObject({ ok: false, error: { code: 'DRIVER_UNAVAILABLE', message: 'session is closed' } });
  });

  it('a verb advertised by the capabilities but not implemented is VERB_UNSUPPORTED', async () => {
    const session = make(undefined, ['hover']);
    await session.observe();
    // a ref that resolves to nothing is reported first; a resolvable one reaches the verb switch
    expect(await session.perform({ verb: 'hover', target: { ref: 'r1:e1' } })).toMatchObject({ ok: false, error: { code: 'TARGET_NOT_FOUND' } });
    const bare = make(undefined, ['hover']);
    expect(await bare.perform({ verb: 'hover' } as unknown as DriverAction)).toEqual({ ok: false, error: { code: 'VERB_UNSUPPORTED', message: 'verb hover is not supported', retryable: false } });
  });

  it('the session baseURL falls back to the options when the context has none', async () => {
    const session = new CuaSession(new ScriptedClient(standard), { pid: 1, windowId: 2 }, opts({ baseURL: 'http://localhost:9' }), { policy }, cfg, capabilitiesFor('browser', 1));
    expect(await session.perform({ verb: 'navigate', url: '/y' })).toEqual({ ok: true, navigatedTo: 'http://localhost:9/y' });
  });
});
