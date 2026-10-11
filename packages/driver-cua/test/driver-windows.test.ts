import { describe, expect, it } from 'vitest';
import type { Driver, DriverSession, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { cua } from '../src/index.ts';
import type { CuaOptions } from '../src/index.ts';
import { PAGE, ScriptedClient, failedResult, okResult, snapshot } from './scripted.ts';
import type { Handler } from './scripted.ts';

const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({
  scenarioId: 's', baseURL: 'http://localhost:4000', policy,
  resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : ''), ...over,
});

interface Win { pid?: unknown; window_id?: unknown; title?: unknown; app_name?: unknown; z_index?: unknown; is_on_screen?: unknown }
const win = (over: Win = {}): Win => ({ pid: 600, window_id: 1, title: 'Probe', app_name: 'Chromium', z_index: 0, is_on_screen: true, ...over });

/** The window the driver attached to, read from the `get_window_state` call it made. */
async function attach(windows: unknown[], o: CuaOptions = {}): Promise<{ pid: unknown; window_id: unknown }> {
  const client = new ScriptedClient((tool) => {
    if (tool === 'list_windows') return okResult({ windows });
    if (tool === 'get_window_state') return snapshot(PAGE);
    return undefined;
  });
  const driver = await cua({ window: { title: 'Probe' }, startTimeoutMs: 400, settleMs: 0, connect: async () => client, ...o })
    .create({ projectRoot: '.', policy, artifactsDir: '.', baseURL: 'http://localhost:4000' });
  try {
    const session = await driver.openSession(opts());
    await session.close();
    const call = client.of('get_window_state')[0];
    return { pid: call?.args['pid'], window_id: call?.args['window_id'] };
  } finally {
    await driver.dispose();
  }
}

describe('choosing the window', () => {
  it('prefers a window that is on screen over one that is not, whatever their stacking order', async () => {
    const chosen = await attach([win({ window_id: 1, z_index: 9, is_on_screen: false }), win({ window_id: 2, z_index: 1 }), win({ window_id: 3, z_index: 0, is_on_screen: false })]);
    expect(chosen.window_id).toBe(2);
  });

  it('among on-screen windows takes the one highest in the stacking order', async () => {
    const chosen = await attach([win({ window_id: 1, z_index: 2 }), win({ window_id: 2, z_index: 7 }), win({ window_id: 3, z_index: 5 })]);
    expect(chosen.window_id).toBe(2);
  });

  it('when every match is off screen the topmost of those is used; a window without is_on_screen counts as on screen; a missing z_index ranks lowest', async () => {
    expect((await attach([win({ window_id: 1, z_index: 1, is_on_screen: false }), win({ window_id: 2, z_index: 4, is_on_screen: false })])).window_id).toBe(2);
    expect((await attach([win({ window_id: 1, z_index: 1, is_on_screen: false }), win({ window_id: 2, is_on_screen: undefined, z_index: 0 })])).window_id).toBe(2);
    expect((await attach([win({ window_id: 1, z_index: undefined }), win({ window_id: 2, z_index: 0 })])).window_id).toBe(2);
  });

  it('title and app expressions must both match; either alone selects by that field', async () => {
    const rows = [
      win({ window_id: 1, title: 'Probe', app_name: 'Firefox', z_index: 9 }),
      win({ window_id: 2, title: 'Other', app_name: 'Chromium', z_index: 8 }),
      win({ window_id: 3, title: 'Probe page', app_name: 'Chromium-browser', z_index: 1 }),
    ];
    expect((await attach(rows, { window: { title: '^Probe', app: '^Chromium' } })).window_id).toBe(3);
    expect((await attach(rows, { window: { app: '^Chromium' } })).window_id).toBe(2);
    expect((await attach(rows, { window: { title: 'Probe' } })).window_id).toBe(1);
    expect((await attach(rows, { window: { title: 'Probe$', app: 'Firefox' } })).window_id).toBe(1);
  });

  it('rows that are not windows are ignored, and a missing title or app name reads as empty', async () => {
    const rows = [null, 'x', 7, { pid: 'one', window_id: 1 }, { pid: 5 }, { window_id: 5 }, win({ pid: 77, window_id: 10, title: 5, app_name: undefined, z_index: 'high' })];
    expect(await attach(rows, { window: { title: '^$', app: '^$' } })).toEqual({ pid: 77, window_id: 10 });
    expect(await attach([{ pid: 5, window_id: 6 }], { window: { title: '^$' } })).toEqual({ pid: 5, window_id: 6 });
  });

  it('a list_windows payload without a windows array means no windows', async () => {
    const client = new ScriptedClient((tool) => (tool === 'list_windows' ? okResult({ windows: 'nope' }) : undefined));
    const driver = await cua({ window: { title: 'x' }, startTimeoutMs: 200, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    await expect(driver.openSession(opts())).rejects.toMatchObject({ message: expect.stringContaining('(0 window(s) visible to Cua Driver') });
    await driver.dispose();
  });

  it('a list_windows failure is DRIVER_ERROR with its first line, or "failed" when it says nothing', async () => {
    const run = async (text: string): Promise<unknown> => {
      const client = new ScriptedClient((tool) => (tool === 'list_windows' ? failedResult('boom', text) : undefined));
      const driver = await cua({ window: { title: 'x' }, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
      try {
        return await driver.openSession(opts()).then(() => undefined, (e: unknown) => e);
      } finally {
        await driver.dispose();
      }
    };
    expect(await run('accessibility denied\nsecond line')).toMatchObject({ code: 'DRIVER_ERROR', message: 'list_windows: accessibility denied' });
    expect(await run('')).toMatchObject({ code: 'DRIVER_ERROR', message: 'list_windows: failed' });
  });

  it('keeps polling until the window appears, then attaches to it', async () => {
    let polls = 0;
    const client = new ScriptedClient((tool) => {
      if (tool === 'list_windows') {
        polls += 1;
        return okResult({ windows: polls < 3 ? [win({ title: 'Splash' })] : [win({ window_id: 42 })] });
      }
      return tool === 'get_window_state' ? snapshot(PAGE) : undefined;
    });
    const driver = await cua({ window: { title: 'Probe' }, startTimeoutMs: 5000, settleMs: 0, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    const session = await driver.openSession(opts());
    expect(polls).toBe(3);
    expect(client.of('get_window_state')[0]?.args['window_id']).toBe(42);
    await session.close();
    await driver.dispose();
  });

  it('a running window that never matches names the filter and how many windows were visible', async () => {
    const client = new ScriptedClient((tool) => (tool === 'list_windows' ? okResult({ windows: [win(), win({ window_id: 2 }), win({ window_id: 3 })] }) : undefined));
    const driver = await cua({ window: { title: 'Nope', app: 'Nada' }, startTimeoutMs: 300, connect: async () => client }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    await expect(driver.openSession(opts())).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'no running window matches {"title":"Nope","app":"Nada"} within 300 ms (3 window(s) visible to Cua Driver; is a display, a window manager and the accessibility bus running?)',
    });
    await driver.dispose();
  });

  it('without `launch` windows of any process may match', async () => {
    expect((await attach([win({ pid: 1, window_id: 1 }), win({ pid: 2, window_id: 2, z_index: 3 })])).pid).toBe(2);
  });
});

describe('waiting for content', () => {
  const run = async (handler: Handler, o: CuaOptions): Promise<{ client: ScriptedClient; session: DriverSession; driver: Driver }> => {
    const client = new ScriptedClient(handler);
    const driver = await cua({ settleMs: 0, connect: async () => client, ...o }).create({ projectRoot: '.', policy, artifactsDir: '.' });
    return { client, driver, session: await driver.openSession(opts()) };
  };
  const windows = okResult({ windows: [win()] });

  it('browser content is ready once an element of the web document exists; earlier snapshots and failures are retried', async () => {
    let states = 0;
    const { client, driver, session } = await run((tool) => {
      if (tool === 'list_windows') return windows;
      if (tool === 'get_window_state') {
        states += 1;
        if (states === 1) return failedResult('window_busy', 'try again');
        if (states === 2) return snapshot(PAGE.slice(0, 4)); // chrome only, no web content yet
        return snapshot(PAGE);
      }
      return undefined;
    }, { kind: 'browser', window: { title: 'Probe' }, startTimeoutMs: 5000 });
    expect(client.of('get_window_state')).toHaveLength(3);
    expect(client.of('get_window_state')[0]?.args).toMatchObject({ include_screenshot: false, timeout_ms: 3000 });
    await session.close();
    await driver.dispose();
  });

  it('a native window is ready as soon as it has more than one element', async () => {
    const { client, driver } = await run((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE.slice(0, 2)) : undefined), { kind: 'app', window: { title: 'Probe' } });
    expect(client.of('get_window_state')).toHaveLength(1);
    await driver.dispose();
  });

  it('a window that stays an empty shell does not fail the open: the session starts once the wait is over', async () => {
    const { client, driver, session } = await run(
      (tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? snapshot(PAGE.slice(0, 1)) : undefined),
      { kind: 'app', window: { title: 'Probe' }, startTimeoutMs: 500 },
    );
    expect(client.of('get_window_state').length).toBeGreaterThanOrEqual(2);
    expect((await session.observe()).nodes.map((n) => n.role)).toEqual(['window']);
    await session.close();
    await driver.dispose();
  });

  it('the scope option overrides what the kind implies', async () => {
    const chromeOnly = snapshot(PAGE.slice(0, 4));
    const { client, driver } = await run((tool) => (tool === 'list_windows' ? windows : tool === 'get_window_state' ? chromeOnly : undefined), { kind: 'browser', scope: 'window', window: { title: 'Probe' }, startTimeoutMs: 5000 });
    expect(client.of('get_window_state')).toHaveLength(1); // window scope: four elements are content enough
    await driver.dispose();
  });
});

describe('title suffix', () => {
  it('a browser strips the product name from the title to form the route; an app keeps its title; titleSuffix overrides both', async () => {
    const mk = async (o: CuaOptions, title: string): Promise<DriverSession> => {
      const client = new ScriptedClient((tool) => {
        if (tool === 'list_windows') return okResult({ windows: [win({ title })] });
        if (tool === 'get_window_state') return snapshot(PAGE, { window_title: title });
        return undefined;
      });
      const driver = await cua({ window: { title: '^' }, settleMs: 0, connect: async () => client, ...o }).create({ projectRoot: '.', policy, artifactsDir: '.' });
      return driver.openSession(opts());
    };
    const browser = await (await mk({ kind: 'browser' }, 'Billing - Mozilla Firefox')).observe();
    expect([browser.route, browser.title]).toEqual(['Billing', 'Billing']);
    const app = await (await mk({ kind: 'app' }, 'Billing - Mozilla Firefox')).observe();
    expect([app.route, app.title]).toEqual(['Billing - Mozilla Firefox', 'Billing - Mozilla Firefox']);
    const custom = await (await mk({ kind: 'app', titleSuffix: '\\s+\\|\\s+Acme$' }, 'Invoices | Acme')).observe();
    expect([custom.route, custom.title]).toEqual(['Invoices', 'Invoices']);
    const bare = await (await mk({ kind: 'browser' }, 'Chromium')).observe();
    expect([bare.route, bare.title]).toEqual(['Chromium', 'Chromium']);
    const onlySuffix = await (await mk({ kind: 'browser' }, ' - Google Chrome')).observe();
    expect([onlySuffix.route, onlySuffix.title]).toEqual(['/', undefined]);
    const empty = await (await mk({ kind: 'app' }, '')).observe();
    expect([empty.route, empty.title]).toEqual(['/', undefined]);
  });
});
