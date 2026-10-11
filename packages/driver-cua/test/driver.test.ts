import { describe, expect, it } from 'vitest';
import type { Driver, DriverSession, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { createDriverFactory, cua } from '../src/index.ts';
import type { CuaOptions } from '../src/index.ts';
import { PAGE, ScriptedClient, WINDOW, failedResult, okResult, snapshot } from './scripted.ts';
import type { Handler } from './scripted.ts';

const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const SECRET = 'hunter22';
const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({
  scenarioId: 's', baseURL: 'http://localhost:4000', policy,
  resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? SECRET : ''),
  ...over,
});

const windows = okResult({ windows: [WINDOW] });

/** Default script: one browser window showing PAGE; every input succeeds. */
const standard: Handler = (tool) => {
  if (tool === 'list_windows') return windows;
  if (tool === 'get_window_state') return snapshot(PAGE);
  return okResult({ delivery: { mode: 'foreground' } }, 'done');
};

async function open(handler: Handler = standard, o: CuaOptions = {}, so: Partial<SessionOptions> = {}): Promise<{ client: ScriptedClient; driver: Driver; session: DriverSession }> {
  const client = new ScriptedClient(handler);
  const driver = await cua({ kind: 'browser', window: { title: 'Probe' }, startTimeoutMs: 300, settleMs: 0, connect: async () => client, ...o })
    .create({ projectRoot: process.cwd(), policy, artifactsDir: process.cwd(), baseURL: 'http://localhost:4000' });
  const session = await driver.openSession(opts(so));
  return { client, driver, session };
}

const refOf = (obs: { nodes: { ref: string; role: string; name: string }[] }, role: string, name: string): string => {
  const n = obs.nodes.find((x) => x.role === role && x.name === name);
  if (n === undefined) throw new Error(`no ${role} ${name}`);
  return n.ref;
};

describe('createDriverFactory', () => {
  const err = (o: Record<string, unknown>) => () => createDriverFactory(o);
  it('builds a factory with the id cua from JSON options', () => {
    const f = createDriverFactory({ kind: 'browser', launch: { command: 'chromium', args: ['{url}'], env: { A: 'b' } }, window: { title: '^Acme' }, delivery: 'foreground', maxSessions: 2, settleMs: 0 });
    expect(f.id).toBe('cua');
  });
  it('rejects unknown keys, bad types and unusable combinations as CONFIG_INVALID', () => {
    for (const bad of [
      {}, { launch: { command: '' } }, { launch: { command: 'x', extra: 1 } }, { launch: { command: 'x', args: [1] } }, { window: {} },
      { window: { title: '(' } }, { window: { title: 'x', nope: 1 } }, { kind: 'phone', window: { title: 'x' } }, { delivery: 'sometimes', window: { title: 'x' } },
      { scope: 'all', window: { title: 'x' } }, { window: { title: 'x' }, wat: 1 }, { window: { title: 'x' }, startTimeoutMs: -1 },
      { window: { title: 'x' }, maxSessions: 0 }, { window: { title: 'x' }, titleSuffix: '[' }, { window: { title: 'x' }, cuaDriver: { command: 3 } },
      { window: { title: 'x' }, cuaDriver: { argz: [] } },
    ]) {
      expect(err(bad as Record<string, unknown>), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });
});

describe('capabilities', () => {
  it('a browser offers navigation, a native app does not; hover and select are never offered', async () => {
    const b = await open(standard, { kind: 'browser' });
    expect(b.driver.capabilities).toEqual({ verbs: ['click', 'fill', 'press', 'check', 'scroll', 'wait', 'navigate', 'back'], pixels: true, maskingProven: false, request: false, maxSessions: 1, exclusiveResource: 'cua-desktop' });
    const a = await open(standard, { kind: 'app' });
    expect(a.driver.capabilities.verbs).toEqual(['click', 'fill', 'press', 'check', 'scroll', 'wait']);
    expect((await a.session.perform({ verb: 'navigate', url: 'http://localhost:4000/' })).error?.code).toBe('VERB_UNSUPPORTED');
    expect((await a.session.perform({ verb: 'back' })).error?.code).toBe('VERB_UNSUPPORTED');
    expect((await b.session.perform({ verb: 'request' as never } as never)).error?.code).toBe('VERB_UNSUPPORTED');
  });
});

describe('opening a session', () => {
  it('attaches to the running window that matches and names it in every tool call', async () => {
    const { client, session } = await open();
    const obs = await session.observe();
    const call = client.of('get_window_state').at(-1);
    expect(call?.args).toMatchObject({ pid: 600, window_id: 4194306, include_screenshot: false });
    expect(obs.nodes.map((n) => n.name)).toEqual(['Hello', 'Name', 'Go']);
    expect(obs.route).toBe('Probe');
    expect(obs.title).toBe('Probe');
  });

  it('is DRIVER_UNAVAILABLE with a useful message when no window matches', async () => {
    await expect(open(standard, { window: { title: 'Nothing like it' } })).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: expect.stringContaining('no running window matches') });
  });

  it('needs `launch` or `window`', async () => {
    const driver = await cua({ connect: async () => new ScriptedClient(standard) }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    await expect(driver.openSession(opts())).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('reports a launch that cannot start, and a launched app that exits before it shows a window', async () => {
    const mk = (launch: NonNullable<CuaOptions['launch']>) => cua({ launch, startTimeoutMs: 1500, connect: async () => new ScriptedClient((t) => (t === 'list_windows' ? okResult({ windows: [] }) : undefined)) })
      .create({ projectRoot: '.', policy, artifactsDir: '.' });
    await expect((await mk({ command: '/definitely/not/an/app' })).openSession(opts())).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: expect.stringContaining('cannot start') });
    await expect((await mk({ command: process.execPath, args: ['-e', 'process.exit(3)'] })).openSession(opts())).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: expect.stringContaining('exited (code 3)') });
  });

  it('refuses a {url} start outside the policy and a {url} without a baseURL', async () => {
    const make = async (baseURL?: string) => (await cua({ launch: { command: process.execPath, args: ['-e', '0', '{url}'] }, connect: async () => new ScriptedClient(standard) })
      .create({ projectRoot: '.', policy, artifactsDir: '.', ...(baseURL === undefined ? {} : { baseURL }) }));
    await expect((await make('https://evil.example/')).openSession({ ...opts(), baseURL: 'https://evil.example/' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const noBase = await make();
    const { baseURL: _drop, ...rest } = opts();
    await expect(noBase.openSession(rest)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('observe', () => {
  it('retries a partial walk once with twice the time budget', async () => {
    let walks = 0;
    const { client, session } = await open((tool) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') {
        walks += 1;
        return walks <= 2 ? snapshot(PAGE) : snapshot(PAGE.slice(0, 5), { truncated: true });
      }
      return undefined;
    }, { treeTimeoutMs: 1000 });
    walks = 2; // the open-time content probe is done; the next walks are partial, then complete
    walks = 3;
    await session.observe();
    const budgets = client.of('get_window_state').map((c) => c.args['timeout_ms']);
    expect(budgets.slice(-2)).toEqual([1000, 2000]);
  });

  it('returns the screenshot only when asked and never marks it masked', async () => {
    const { session } = await open((tool, args) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') return { ...snapshot(PAGE), images: args['include_screenshot'] === true ? [{ data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' }] : [] };
      return undefined;
    });
    expect((await session.observe()).screenshot).toBeUndefined();
    const obs = await session.observe({ pixels: true });
    expect(obs.screenshot?.masked).toBe(false);
    expect(obs.screenshot?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('turns a vanished window into DRIVER_UNAVAILABLE', async () => {
    let gone = false;
    const { session } = await open((tool) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') return gone ? failedResult('window_not_found', 'no such window') : snapshot(PAGE);
      return undefined;
    });
    gone = true;
    await expect(session.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
  });

  it('numbers refs by revision and refuses old ones', async () => {
    const { client, session } = await open();
    const first = await session.observe();
    const old = refOf(first, 'button', 'Go');
    const second = await session.observe();
    expect(second.revision).toBe(first.revision + 1);
    const before = client.calls.length;
    expect((await session.perform({ verb: 'click', target: { ref: old } })).error?.code).toBe('STALE_REF');
    expect((await session.perform({ verb: 'click', target: { ref: `r${second.revision}:e999` } })).error?.code).toBe('TARGET_NOT_FOUND');
    expect(client.calls.length).toBe(before); // nothing reached the driver
  });
});

describe('input delivery', () => {
  const refuseBackground: Handler = (tool, args) => {
    if (tool === 'list_windows') return windows;
    if (tool === 'get_window_state') return snapshot(PAGE);
    return args['delivery_mode'] === 'background' ? failedResult('background_unavailable', 'Chromium does not accept background input') : okResult();
  };

  it('auto: tries the background, falls back to the foreground when the app refuses it, then stays there', async () => {
    const { client, session } = await open(refuseBackground);
    const obs = await session.observe();
    expect((await session.perform({ verb: 'click', target: { ref: refOf(obs, 'button', 'Go') } })).ok).toBe(true);
    expect(client.of('click').map((c) => c.args['delivery_mode'])).toEqual(['background', 'foreground']);
    const obs2 = await session.observe();
    await session.perform({ verb: 'click', target: { ref: refOf(obs2, 'button', 'Go') } });
    expect(client.of('click').map((c) => c.args['delivery_mode'])).toEqual(['background', 'foreground', 'foreground']);
    expect(client.of('click')[0]?.args).toMatchObject({ pid: 600, window_id: 4194306, element_token: 's00000001:7' });
  });

  it('background: the refusal is the answer', async () => {
    const { session } = await open(refuseBackground, { delivery: 'background' });
    const obs = await session.observe();
    const r = await session.perform({ verb: 'click', target: { ref: refOf(obs, 'button', 'Go') } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('DRIVER_ERROR');
    expect(r.error?.message).toContain('background input');
  });

  it('foreground: never tries the background', async () => {
    const { client, session } = await open(refuseBackground, { delivery: 'foreground' });
    const obs = await session.observe();
    await session.perform({ verb: 'click', target: { ref: refOf(obs, 'button', 'Go') } });
    expect(client.of('click').map((c) => c.args['delivery_mode'])).toEqual(['foreground']);
  });

  it('maps the driver\'s refusals: a stale element token is STALE_REF, a missing element TARGET_NOT_FOUND', async () => {
    let code = 'stale_element_token';
    const { session } = await open((tool) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') return snapshot(PAGE);
      return failedResult(code, 'refused');
    });
    const obs = await session.observe();
    const ref = refOf(obs, 'button', 'Go');
    expect((await session.perform({ verb: 'click', target: { ref } })).error?.code).toBe('STALE_REF');
    code = 'element_not_found';
    expect((await session.perform({ verb: 'click', target: { ref } })).error?.code).toBe('TARGET_NOT_FOUND');
  });
});

describe('verbs', () => {
  it('fill: focuses the field, selects its content, types; an empty value clears it', async () => {
    const { client, session } = await open();
    const obs = await session.observe();
    const ref = refOf(obs, 'textbox', 'Name');
    expect((await session.perform({ verb: 'fill', target: { ref }, value: { literal: 'Alice' } })).ok).toBe(true);
    expect(client.calls.slice(-3).map((c) => c.tool)).toEqual(['click', 'press_key', 'type_text']);
    expect(client.of('press_key').at(-1)?.args).toMatchObject({ key: 'A', modifiers: ['ctrl'] });
    expect(client.of('type_text').at(-1)?.args).toMatchObject({ text: 'Alice', pid: 600, window_id: 4194306 });
    const obs2 = await session.observe();
    await session.perform({ verb: 'fill', target: { ref: refOf(obs2, 'textbox', 'Name') }, value: { literal: '' } });
    expect(client.calls.slice(-3).map((c) => c.tool)).toEqual(['click', 'press_key', 'press_key']);
    expect(client.of('press_key').at(-1)?.args).toMatchObject({ key: 'backspace' });
  });

  it('press: focuses the target when given, sends keys with modifiers, rejects unknown keys', async () => {
    const { client, session } = await open();
    const obs = await session.observe();
    await session.perform({ verb: 'press', key: 'Control+Shift+K' });
    expect(client.of('press_key').at(-1)?.args).toMatchObject({ key: 'K', modifiers: ['ctrl', 'shift'] });
    await session.perform({ verb: 'press', key: 'Enter', target: { ref: refOf(obs, 'textbox', 'Name') } });
    expect(client.calls.slice(-2).map((c) => c.tool)).toEqual(['click', 'press_key']);
    const bad = await session.perform({ verb: 'press', key: 'Hyper+Q' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('DRIVER_ERROR');
  });

  it('check: clicks only when the state differs', async () => {
    const rows = [
      ...PAGE.slice(0, 5),
      { element_index: 5, role: 'check box', label: 'Subscribe', parent_index: 4, in_web_content: true, selected: true },
      { element_index: 6, role: 'check box', label: 'Terms', parent_index: 4, in_web_content: true, selected: false },
      { element_index: 7, role: 'heading', label: 'Hello', parent_index: 4, in_web_content: true },
    ];
    const { client, session } = await open((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(rows) : undefined));
    const obs = await session.observe();
    const subscribe = refOf(obs, 'checkbox', 'Subscribe');
    const terms = refOf(obs, 'checkbox', 'Terms');
    await session.perform({ verb: 'check', target: { ref: subscribe }, checked: true });
    expect(client.of('click')).toHaveLength(0);
    await session.perform({ verb: 'check', target: { ref: terms }, checked: true });
    expect(client.of('click')).toHaveLength(1);
    const notCheckable = await session.perform({ verb: 'check', target: { ref: refOf(obs, 'heading', 'Hello') }, checked: true });
    expect(notCheckable.error?.code).toBe('DRIVER_ERROR');
  });

  it('scroll: passes the direction and, with a target, the element', async () => {
    const { client, session } = await open();
    const obs = await session.observe();
    await session.perform({ verb: 'scroll', direction: 'down' });
    expect(client.of('scroll').at(-1)?.args).toMatchObject({ direction: 'down', pid: 600, window_id: 4194306 });
    expect(client.of('scroll').at(-1)?.args['element_token']).toBeUndefined();
    await session.perform({ verb: 'scroll', direction: 'up', target: { ref: refOf(obs, 'button', 'Go') } });
    expect(client.of('scroll').at(-1)?.args).toMatchObject({ direction: 'up', element_token: 's00000001:7' });
  });

  it('wait: sleeps, bounded', async () => {
    const { session } = await open();
    const t0 = Date.now();
    expect((await session.perform({ verb: 'wait', ms: 30 })).ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect((await session.perform({ verb: 'wait', ms: Number.NaN })).ok).toBe(true);
  });

  it('navigate: checks the policy, then uses the address bar; back uses the keyboard', async () => {
    const { client, session } = await open();
    const denied = await session.perform({ verb: 'navigate', url: 'https://evil.example/x' });
    expect(denied.error?.code).toBe('POLICY_DENIED');
    expect((await session.perform({ verb: 'navigate', url: 'file:///etc/passwd' })).error?.code).toBe('POLICY_DENIED');
    expect((await session.perform({ verb: 'navigate', url: 'http://user:pw@localhost:4000/' })).error?.code).toBe('POLICY_DENIED');
    expect(client.of('type_text')).toHaveLength(0);
    const ok = await session.perform({ verb: 'navigate', url: '/billing' });
    expect(ok).toEqual({ ok: true, navigatedTo: 'http://localhost:4000/billing' });
    expect(client.calls.slice(-3).map((c) => `${c.tool}:${String(c.args['key'] ?? c.args['text'])}`)).toEqual(['press_key:L', 'type_text:http://localhost:4000/billing', 'press_key:enter']);
    await session.perform({ verb: 'back' });
    expect(client.of('press_key').at(-1)?.args).toMatchObject({ key: 'left', modifiers: ['alt'] });
  });

  it('denyVerbs wins before anything is sent', async () => {
    const { client, session } = await open(standard, {}, { policy: { allowHosts: ['localhost'], denyVerbs: ['click', 'fill'] } });
    const obs = await session.observe();
    const before = client.calls.length;
    expect((await session.perform({ verb: 'click', target: { ref: refOf(obs, 'button', 'Go') } })).error?.code).toBe('POLICY_DENIED');
    expect((await session.perform({ verb: 'fill', target: { ref: refOf(obs, 'textbox', 'Name') }, value: { literal: 'x' } })).error?.code).toBe('POLICY_DENIED');
    expect(client.calls.length).toBe(before);
  });
});

describe('secrets', () => {
  it('a secret fill taints the session, even when it fails, and the secret never appears in errors or observations', async () => {
    const { session } = await open((tool, args) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') return snapshot([...PAGE.slice(0, 7), { element_index: 7, role: 'password text', label: 'Password', parent_index: 4, in_web_content: true, value: SECRET }]);
      if (tool === 'type_text') return failedResult('typing_failed', `cannot type ${String(args['text'])} here`);
      return undefined;
    });
    const obs = await session.observe();
    expect(obs.tainted).toBe(false);
    const r = await session.perform({ verb: 'fill', target: { ref: refOf(obs, 'textbox', 'Password') }, value: { secret: 'adminPassword' } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const after = await session.observe();
    expect(after.tainted).toBe(true);
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });
});

describe('lifecycle and self check', () => {
  it('closing is idempotent and later calls report DRIVER_UNAVAILABLE', async () => {
    const { session } = await open();
    await session.close();
    await session.close();
    await expect(session.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
    expect((await session.perform({ verb: 'wait', ms: 1 })).error?.code).toBe('DRIVER_UNAVAILABLE');
  });

  it('dispose closes open sessions and the Cua Driver connection', async () => {
    const { client, driver } = await open();
    await driver.dispose();
    expect(client.closed).toBe(true);
    await expect(driver.openSession(opts())).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
  });

  const checkWith = async (handler: Handler, tools?: string[]) => {
    const client = new ScriptedClient(handler, tools);
    const driver = await cua({ window: { title: 'x' }, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    return driver.selfCheck();
  };

  it('selfCheck passes on a healthy driver and names every failed health check', async () => {
    expect(await checkWith((t) => (t === 'health_report' ? okResult({ overall: 'ok', checks: [{ name: 'ax_capability', status: 'pass', message: 'fine' }] }) : undefined))).toEqual({ ok: true, problems: [] });
    const bad = await checkWith((t) => (t === 'health_report'
      ? okResult({ overall: 'degraded', checks: [{ name: 'ax_capability', status: 'fail', message: 'org.a11y.Bus is not on the session bus' }, { name: 'x', status: 'skip', message: 's' }] })
      : undefined));
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual(['ax_capability: org.a11y.Bus is not on the session bus']);
  });

  it('selfCheck names missing tools and reports an unreachable driver with the install hint', async () => {
    const missing = await checkWith(() => undefined, ['list_windows']);
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toContain('get_window_state');
    const driver = await cua({ window: { title: 'x' }, cuaDriver: { command: '/definitely/not/cua-driver' } }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    const down = await driver.selfCheck();
    expect(down.ok).toBe(false);
    expect(down.problems[0]).toContain('cua.ai/docs/cua-driver');
  });
});
