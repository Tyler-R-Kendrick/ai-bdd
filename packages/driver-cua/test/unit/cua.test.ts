import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@ai-bdd/contracts';
import {
  CUA_ERROR_MAP,
  CUA_VERB_MAP,
  REQUIRED_TOOLS,
  capabilitiesFromTools,
  cua,
  isElementToken,
  mapCuaError,
  mapVerifyState,
  type McpCaller,
} from '../../src/index.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/tools-list.json', import.meta.url)), 'utf8'),
) as { tools: Array<{ name: string }>; calls: Record<string, JsonValue> };

/** Replays the synthetic contract snapshot, so CI needs no Cua installation. */
class ReplayCaller implements McpCaller {
  readonly calls: Array<{ tool: string; args: JsonValue }> = [];
  failNext: string | undefined;

  async listTools(): Promise<string[]> {
    return fixture.tools.map((tool) => tool.name);
  }

  async call(tool: string, args: JsonValue): Promise<JsonValue> {
    this.calls.push({ tool, args });
    if (this.failNext === tool) {
      this.failNext = undefined;
      throw new Error('POLICY_DENIED: the target is outside the allowlist');
    }
    const response = fixture.calls[tool];
    if (response === undefined) throw new Error(`APP_NOT_ALLOWED: no scripted response for ${tool}`);
    return response;
  }

  async close(): Promise<void> {}
}

async function open(caller: McpCaller, options: Partial<Parameters<typeof cua>[0]> = {}) {
  const factory = cua({
    app: 'TextEdit',
    allowApps: ['com.apple.TextEdit'],
    caller,
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    ...options,
  });
  const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
  const session = await driver.openSession({ sessionId: 's', scenarioId: 'sc', config: {} });
  return { driver, session };
}

describe('Cua contract (V3, synthetic fixtures)', () => {
  it('requires the typed contract tools and reports the missing ones', async () => {
    const partial: McpCaller = {
      async listTools() {
        return ['list_apps'];
      },
      async call() {
        return {};
      },
      async close() {},
    };
    const factory = cua({ app: 'TextEdit', allowApps: ['com.apple.TextEdit'], caller: partial });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    const check = await driver.selfCheck();
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('missing `start_session`');
    for (const tool of REQUIRED_TOOLS) expect(tool.length).toBeGreaterThan(0);
  });

  it('self-checks green against the full snapshot', async () => {
    const factory = cua({ app: 'TextEdit', allowApps: ['com.apple.TextEdit'], caller: new ReplayCaller() });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    expect(await driver.selfCheck()).toMatchObject({ ok: true, driver: 'cua' });
  });

  it('maps verbs onto the typed contract tools', () => {
    expect(CUA_VERB_MAP.tap.tool).toBe('click');
    expect(CUA_VERB_MAP.type.tool).toBe('type_text');
    expect(CUA_VERB_MAP.press.tool).toBe('press_key');
    expect(CUA_VERB_MAP.scroll.tool).toBe('scroll');
    expect(CUA_VERB_MAP.drag.tool).toBe('drag');
    // A native desktop has no URL bar, so navigate is absent instead of failing late.
    expect(CUA_VERB_MAP.navigate.tool).toBeNull();
  });

  it('derives capabilities from the tool list and the background-only mode', () => {
    const catalog = fixture.tools.map((tool) => tool.name);
    const foreground = capabilitiesFromTools(catalog, false);
    expect(foreground.verbs).toContain('type');
    expect(foreground.nativePredicates).toBe(true);
    expect(foreground.deliveryModes).toEqual(['background', 'foreground']);

    const background = capabilitiesFromTools(catalog, true);
    expect(background.verbs).not.toContain('type');
    expect(background.verbs).not.toContain('press');
    expect(background.verbs).toContain('tap');
    expect(background.deliveryModes).toEqual(['background']);
  });

  it('recognises snapshot-bound element tokens', () => {
    expect(isElementToken('s1a2b3c4d:12')).toBe(true);
    expect(isElementToken('element-12')).toBe(false);
    expect(isElementToken('s1a2b3c4d')).toBe(false);
  });

  it('treats an unknown verify_state result as unknown, never as success', () => {
    expect(mapVerifyState(['satisfied', 'unknown', 'unsatisfied'])).toEqual(['satisfied', 'unknown', 'unsatisfied']);
    expect(mapVerifyState(['weird'])).toEqual(['unknown']);
  });

  it('maps Cua error codes', () => {
    expect(mapCuaError('APP_NOT_ALLOWED')).toBe('POLICY_DENIED');
    expect(mapCuaError('SNAPSHOT_STALE')).toBe('DRIVER_INCOMPATIBLE');
    expect(mapCuaError('SESSION_NOT_FOUND')).toBe('NO_SESSION');
    expect(Object.keys(CUA_ERROR_MAP).length).toBeGreaterThan(3);
  });
});

describe('Cua session behaviour', () => {
  it('declares an exclusive resource for the desktop', async () => {
    const factory = cua({ app: 'TextEdit', allowApps: ['com.apple.TextEdit'], caller: new ReplayCaller() });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    expect(driver.concurrency).toEqual({ maxSessions: 1, exclusiveResource: 'desktop:main' });

    const background = cua({ app: 'TextEdit', allowApps: ['com.apple.TextEdit'], backgroundOnly: true, caller: new ReplayCaller() });
    const backgroundDriver = await background.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    expect(backgroundDriver.concurrency.exclusiveResource).toBeUndefined();
    expect(backgroundDriver.concurrency.maxSessions).toBeGreaterThan(1);
  });

  it('refuses an application outside policy.cua.allowApps', async () => {
    const { session } = await open(new ReplayCaller(), { allowApps: ['com.example.Other'] });
    await expect(session.observe()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('refuses every application when the allowlist is empty', async () => {
    const { session } = await open(new ReplayCaller(), { allowApps: [] });
    await expect(session.observe()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('observes the window with element tokens as refs', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller);
    const observation = await session.observe();
    expect(observation.nodes[0]?.role).toBe('window');
    const textbox = observation.nodes[0]?.children?.find((node) => node.role === 'textbox');
    expect(textbox?.testId).toBe('s1a2b3c4d:13');
    expect(observation.screenshot?.sha256).toHaveLength(64);
    expect(caller.calls.map((call) => call.tool)).toEqual(['start_session', 'list_apps', 'list_windows', 'get_window_state']);
  });

  it('clicks a token target in the configured delivery mode', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller);
    const observation = await session.observe();
    const token = observation.nodes[0]?.children?.[1]?.testId ?? '';
    const result = await session.perform({ verb: 'tap', ref: observation.nodes[0]?.children?.[1]?.ref ?? token });
    expect(result.ok).toBe(true);
    const click = caller.calls.find((call) => call.tool === 'click');
    expect(click?.args).toMatchObject({ element_token: token, delivery_mode: 'foreground' });
  });

  it('refuses foreground verbs in background-only mode', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller, { backgroundOnly: true });
    const typed = await session.perform({ verb: 'type', ref: 's1a2b3c4d:13', value: 'hello' });
    expect(typed.ok).toBe(false);
    expect(typed.code).toBe('POLICY_DENIED');
    const pressed = await session.perform({ verb: 'press', value: 'Return' });
    expect(pressed.code).toBe('POLICY_DENIED');
    expect(caller.calls.every((call) => call.tool !== 'type_text' && call.tool !== 'press_key')).toBe(true);
  });

  it('uses background delivery in background-only mode', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller, { backgroundOnly: true });
    const observation = await session.observe();
    const result = await session.perform({ verb: 'tap', ref: observation.nodes[0]?.children?.[1]?.ref ?? '' });
    expect(result.ok).toBe(true);
    expect(caller.calls.find((call) => call.tool === 'click')?.args).toMatchObject({ delivery_mode: 'background' });
  });

  it('fails a native predicate that the tool cannot confirm', async () => {
    const { session } = await open(new ReplayCaller());
    const results = await session.verifyNative!({ kind: 'text_contains' } as JsonValue);
    expect(results).toEqual(['satisfied', 'unknown']);
    // `unknown` is not success: the assertion layer treats it as a failure.
    expect(results.some((result) => result !== 'satisfied')).toBe(true);
  });

  it('maps a tool failure onto a policy error', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller);
    caller.failNext = 'click';
    const observation = await session.observe();
    const result = await session.perform({ verb: 'tap', ref: observation.nodes[0]?.children?.[1]?.ref ?? '' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('POLICY_DENIED');
  });

  it('closes the driver session through end_session', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller);
    await session.close();
    expect(caller.calls.some((call) => call.tool === 'end_session')).toBe(true);
    await expect(session.observe()).rejects.toMatchObject({ code: 'NO_SESSION' });
  });
});
