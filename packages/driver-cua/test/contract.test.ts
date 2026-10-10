import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verify } from '@ai-bdd/verify';
import type { Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { cua, desktopEnv, normalizeResult } from '../src/index.ts';
import type { CuaToolResult } from '../src/index.ts';
import { cuaDriverBinary } from './environment.ts';
import { PAGE, ScriptedClient, WINDOW, okResult, snapshot } from './scripted.ts';
import type { Handler } from './scripted.ts';

/**
 * Consumer-driven contract with Cua Driver. Three parts:
 *  1. recorded responses of a real cua-driver 0.34 replayed through the driver (offline),
 *  2. the exact tool calls the driver makes, pinned as a verified snapshot,
 *  3. that snapshot checked against the live tool schemas of the installed cua-driver (needs the executable, no desktop).
 */
const here = dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(readFileSync(join(here, 'fixtures', 'recorded-responses.json'), 'utf8')) as Record<string, unknown>;
const rec = (name: string): CuaToolResult => normalizeResult(recorded[name]);

const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };
const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({
  scenarioId: 's', baseURL: 'http://localhost:4000', policy,
  resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : 'secret' in v ? 'pw-pw-pw' : ''),
  ...over,
});

async function open(handler: Handler) {
  const client = new ScriptedClient(handler);
  const driver = await cua({ kind: 'browser', window: { title: 'Probe' }, startTimeoutMs: 300, settleMs: 0, connect: async () => client })
    .create({ projectRoot: '.', policy, artifactsDir: '.', baseURL: 'http://localhost:4000' });
  return { client, driver, session: await driver.openSession(opts()) };
}

describe('recorded responses of the real cua-driver, replayed', () => {
  const live: Handler = (tool) => {
    if (tool === 'list_windows') return rec('list_windows');
    if (tool === 'get_window_state') return snapshot(PAGE);
    return undefined;
  };

  it('list_windows: the window of a launched browser is found by pid, title and z-order', async () => {
    const { session } = await open((tool) => (tool === 'get_window_state' ? snapshot(PAGE) : tool === 'list_windows' ? rec('list_windows') : undefined));
    expect((await session.observe()).nodes.length).toBeGreaterThan(0);
  });

  it('a stale element token is refused with refusal.code stale_element_token -> STALE_REF', async () => {
    const { session } = await open((tool, args) => (tool === 'click' ? rec('click_stale_token') : live(tool, args, [])));
    const obs = await session.observe();
    const go = obs.nodes.find((n) => n.name === 'Go');
    const r = await session.perform({ verb: 'click', target: { ref: go?.ref ?? '' } });
    expect(r.error?.code).toBe('STALE_REF');
    expect(r.error?.message).toContain('stale');
  });

  it('a window that no longer exists is reported by message only (code tool_invocation_failed) -> DRIVER_UNAVAILABLE', async () => {
    const gone = rec('click_unknown_window');
    expect(gone.code).toBe('tool_invocation_failed');
    const { session } = await open((tool) => (tool === 'list_windows' ? rec('list_windows') : tool === 'get_window_state' ? (gone.failed && calls++ > 0 ? gone : snapshot(PAGE)) : undefined));
    await expect(session.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });
  });

  it('background_unavailable (Chromium renderer) makes the driver retry in the foreground, and stay there', async () => {
    const { client, session } = await open((tool, args) => {
      if (tool === 'click' || tool === 'type_text' || tool === 'press_key') return args['delivery_mode'] === 'background' ? rec('click_background_unavailable') : rec('click_foreground_ok');
      return live(tool, args, []);
    });
    const obs = await session.observe();
    const go = obs.nodes.find((n) => n.name === 'Go')?.ref ?? '';
    expect((await session.perform({ verb: 'click', target: { ref: go } })).ok).toBe(true);
    expect(client.of('click').map((c) => c.args['delivery_mode'])).toEqual(['background', 'foreground']);
  });

  it('foreground_unavailable (no window manager) is a driver error that says so', async () => {
    const { session } = await open((tool, args) => (tool === 'click' ? rec('click_foreground_unavailable') : live(tool, args, [])));
    const obs = await session.observe();
    const r = await session.perform({ verb: 'click', target: { ref: obs.nodes.find((n) => n.name === 'Go')?.ref ?? '' } });
    expect(r.error?.code).toBe('DRIVER_ERROR');
    expect(r.error?.message).toContain('window manager');
  });

  it('successful input results are not failures; health_report passes selfCheck', async () => {
    for (const name of ['click_foreground_ok', 'click_background_accepted', 'press_key_ok', 'type_text_ok', 'scroll_ok']) expect(rec(name).failed, name).toBe(false);
    const { driver } = await open((tool) => (tool === 'health_report' ? rec('health_report') : tool === 'list_windows' ? windowsOf() : tool === 'get_window_state' ? snapshot(PAGE) : undefined));
    expect(await driver.selfCheck()).toEqual({ ok: true, problems: [] });
  });
});

let calls = 0;
const windowsOf = () => okResult({ windows: [WINDOW] });

/** One session through every verb; returns tool -> the argument names and enum-like values the driver sent. */
async function usage(): Promise<Record<string, { arguments: string[]; values: Record<string, string[]> }>> {
  // the first background input is refused, as Chromium does: the driver then uses the foreground
  let refused = false;
  const { client, driver, session } = await open((tool, args) => {
    if (tool === 'list_windows') return windowsOf();
    if (tool === 'get_window_state') return snapshot([...PAGE, { element_index: 8, role: 'check box', label: 'Terms', parent_index: 4, in_web_content: true, selected: false }]);
    if (tool === 'health_report') return rec('health_report');
    if (args['delivery_mode'] === 'background' && !refused) {
      refused = true;
      return rec('click_background_unavailable');
    }
    return okResult();
  });
  let obs = await session.observe({ pixels: true });
  const ref = (name: string) => obs.nodes.find((n) => n.name === name)?.ref ?? '';
  const step = async () => { obs = await session.observe(); };
  await session.perform({ verb: 'click', target: { ref: ref('Go') } });
  await step();
  await session.perform({ verb: 'fill', target: { ref: ref('Name') }, value: { literal: 'x' } });
  await step();
  await session.perform({ verb: 'press', key: 'Control+Shift+K', target: { ref: ref('Name') } });
  await step();
  await session.perform({ verb: 'check', target: { ref: ref('Terms') }, checked: true });
  await session.perform({ verb: 'scroll', direction: 'down' });
  await session.perform({ verb: 'navigate', url: '/x' });
  await session.perform({ verb: 'back' });
  await driver.selfCheck();
  const out: Record<string, { arguments: Set<string>; values: Map<string, Set<string>> }> = {};
  for (const c of client.calls) {
    const e = (out[c.tool] ??= { arguments: new Set(), values: new Map() });
    for (const [k, v] of Object.entries(c.args)) {
      e.arguments.add(k);
      if (k === 'delivery_mode' || k === 'direction' || k === 'key') (e.values.get(k) ?? e.values.set(k, new Set()).get(k))?.add(String(v));
      if (k === 'modifiers' && Array.isArray(v)) for (const m of v) (e.values.get(k) ?? e.values.set(k, new Set()).get(k))?.add(String(m));
    }
  }
  await client.close();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([tool, e]) => [tool, {
    arguments: [...e.arguments].sort(),
    values: Object.fromEntries([...e.values.entries()].filter(([k]) => k !== 'key').map(([k, v]) => [k, [...v].sort()])),
  }]));
}

describe('what the driver sends', () => {
  it('every tool the driver calls, with the argument names and enum values it uses (the consumer side of the contract)', async () => {
    await verify(await usage(), { extension: 'json' });
  });
});

const binary = cuaDriverBinary();
const installed = spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!installed)('against the installed cua-driver (tool schemas)', () => {
  async function schemas(): Promise<Record<string, { properties?: Record<string, { type?: unknown; enum?: unknown[]; items?: { enum?: unknown[] } }>; required?: string[]; additionalProperties?: boolean }>> {
    const client = new Client({ name: 'contract', version: '0' });
    await client.connect(new StdioClientTransport({ command: binary, args: ['mcp'], env: desktopEnv() }));
    try {
      return Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.inputSchema])) as never;
    } finally {
      await client.close();
    }
  }

  it('serves every tool the driver calls, accepts every argument it sends, and allows every enum value it uses', async () => {
    const [sent, served] = [await usage(), await schemas()];
    for (const [tool, u] of Object.entries(sent)) {
      const schema = served[tool];
      expect(schema, `${tool} is not served by this cua-driver`).toBeDefined();
      for (const arg of u.arguments) expect(Object.keys(schema?.properties ?? {}), `${tool}: argument ${arg}`).toContain(arg);
      for (const [arg, values] of Object.entries(u.values)) {
        const prop = schema?.properties?.[arg];
        const allowed = prop?.enum ?? prop?.items?.enum;
        if (allowed !== undefined) for (const v of values) expect(allowed, `${tool}.${arg} = ${v}`).toContain(v);
      }
      const sentEvery = new Set(u.arguments);
      for (const required of schema?.required ?? []) expect(sentEvery.has(required), `${tool} requires ${required}, which the driver does not always send`).toBe(true);
    }
  });

  it('the schemas of the tools the driver uses, pinned: a Cua Driver update that changes them shows up as a reviewable diff', async () => {
    const served = await schemas();
    const slim = Object.fromEntries(Object.keys(await usage()).map((tool) => {
      const s = served[tool];
      return [tool, {
        required: [...(s?.required ?? [])].sort(),
        additionalProperties: s?.additionalProperties,
        properties: Object.fromEntries(Object.entries(s?.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Object.fromEntries(Object.entries({ type: v.type, enum: v.enum ?? v.items?.enum }).filter(([, x]) => x !== undefined))])),
      }];
    }));
    await verify(slim, { extension: 'json', name: 'tool schemas' });
  });
});
