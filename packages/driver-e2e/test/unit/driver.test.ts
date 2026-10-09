import { describe, expect, it } from 'vitest';
import type { DriverSession, Verb } from '@ai-bdd/contracts';
import {
  E2E_CATALOG,
  E2E_ERROR_MAP,
  E2E_VERB_MAP,
  capabilitiesFromCatalog,
  e2e,
  e2eMcpArgs,
  mapE2eError,
  normalizeMaxSessions,
  parseObserveText,
  type McpCaller,
} from '../../src/index.js';
import { ReplayCaller } from '../helpers/replay-caller.js';

async function open(caller: McpCaller = new ReplayCaller()): Promise<{ session: DriverSession; caller: McpCaller }> {
  const factory = e2e({ caller, now: () => new Date('2026-10-09T00:00:00.000Z') });
  const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
  const session = await driver.openSession({
    sessionId: 's',
    scenarioId: 'sc',
    config: {},
    target: { target: 'web' },
  });
  return { session, caller };
}

describe('verb mapping (section 11.2)', () => {
  it('maps every ai-bdd verb except invokeMenu', () => {
    const unmapped = (Object.keys(E2E_VERB_MAP) as Verb[]).filter((verb) => E2E_VERB_MAP[verb] === null);
    expect(unmapped).toEqual(['invokeMenu']);
  });

  it('maps the documented pairs', () => {
    expect(E2E_VERB_MAP.tap).toBe('tap');
    expect(E2E_VERB_MAP.typeSecret).toBe('type_secret');
    expect(E2E_VERB_MAP.scrollTo).toBe('scroll_to');
    expect(E2E_VERB_MAP.secondaryTap).toBe('right_click');
    expect(E2E_VERB_MAP.doubleTap).toBe('double_tap');
    expect(E2E_VERB_MAP.longPress).toBe('long_press');
    expect(E2E_VERB_MAP.tapAt).toBe('tap_at');
    expect(E2E_VERB_MAP.typeAt).toBe('type_at');
    expect(E2E_VERB_MAP.upload).toBe('upload');
  });

  it('derives capabilities from the session catalog, so absent verbs stay absent', () => {
    const full = capabilitiesFromCatalog([...E2E_CATALOG]);
    expect(full.verbs).toContain('typeSecret');
    expect(full.video).toBe(true);

    const minimal = capabilitiesFromCatalog(['observe', 'tap']);
    expect(minimal.verbs).toEqual(['tap']);
    expect(minimal.pixels).toBe(false);
    expect(minimal.maskingProven).toBe(false);
  });
});

describe('error mapping (F-E3)', () => {
  it('maps e2e codes onto ai-bdd codes', () => {
    expect(mapE2eError('SESSION_OPEN')).toBe('SESSION_LIMIT');
    expect(mapE2eError('CONFIG_IN_USE')).toBe('RESOURCE_LOCKED');
    expect(mapE2eError('ENGINE_IN_USE')).toBe('RESOURCE_LOCKED');
    expect(mapE2eError('PIXEL_TAINTED')).toBe('PIXEL_TAINTED');
    expect(mapE2eError('POLICY_DENIED')).toBe('POLICY_DENIED');
    expect(mapE2eError(undefined)).toBeUndefined();
    expect(Object.keys(E2E_ERROR_MAP)).toHaveLength(6);
  });
});

describe('e2e mcp argv and session cap', () => {
  it('builds the verified flag list', () => {
    expect(e2eMcpArgs({ config: './e2e.config.ts', target: 'ios', maxSessions: 4 })).toEqual([
      'mcp',
      '--config',
      './e2e.config.ts',
      '--target',
      'ios',
      '--max-sessions',
      '4',
    ]);
    expect(e2eMcpArgs({})).toEqual(['mcp', '--max-sessions', '4']);
  });

  it('rejects a cap outside 1..16', () => {
    expect(() => normalizeMaxSessions(0)).toThrow(RangeError);
    expect(() => normalizeMaxSessions(17)).toThrow(RangeError);
    expect(normalizeMaxSessions(16)).toBe(16);
  });
});

describe('observe line parser', () => {
  it('parses refs, roles, names, nesting, text and state flags', () => {
    const parsed = parseObserveText(
      ['#s1 dialog "Upgrade to Pro"', '  #s2 text "You are upgrading"', '  #s3 button "Confirm" [focused]', '#s4 button "Cancel"'].join('\n'),
      1,
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0]?.ref).toBe('e2e-s1');
    expect(parsed.nodes[0]?.children?.map((child) => child.ref)).toEqual(['e2e-s2', 'e2e-s3']);
    expect(parsed.nodes[0]?.children?.[0]?.text).toBe('You are upgrading');
    expect(parsed.nodes[0]?.children?.[1]?.state).toEqual({ focused: true });
  });

  it('generates revision-scoped refs when the server sends none', () => {
    const parsed = parseObserveText('button "Upgrade"\ntext "Free plan"', 7);
    expect(parsed.nodes.map((node) => node.ref)).toEqual(['r7-1', 'r7-2']);

  });
  it('collects unparsable lines instead of dropping them', () => {
    const parsed = parseObserveText('!!! not a node\nbutton "Ok"', 1);
    expect(parsed.unparsed).toEqual(['!!! not a node']);
    expect(parsed.nodes).toHaveLength(1);
  });
});

describe('session behaviour over a recorded transcript', () => {
  it('observes, performs and invalidates refs per observation', async () => {
    const { session } = await open();
    const first = await session.observe();
    expect(first.nodes[0]?.name).toBe('Billing settings');
    expect(first.route).toBe('/settings/billing');

    const tap = await session.perform({ verb: 'tap', ref: 'e2e-s3' });
    expect(tap.ok).toBe(true);

    const second = await session.observe();
    expect(second.revision).toBeGreaterThan(first.revision);
    const firstRefs = new Set(flattenRefs(first.nodes));
    expect(flattenRefs(second.nodes).some((ref) => firstRefs.has(ref))).toBe(false);
    expect(second.nodes[0]?.role).toBe('dialog');
  });

  async function driveToLogin(session: DriverSession): Promise<void> {
    await session.observe();
    await session.perform({ verb: 'tap', ref: 'e2e-s3' });
    await session.observe();
    await session.perform({ verb: 'tap', ref: 'e2e-s7' });
    await session.observe();
    await session.perform({ verb: 'navigate', value: '/login' });
    await session.observe();
  }

  it('taints the session after a secret fill and withholds pixels', async () => {
    const caller = new ReplayCaller();
    const { session } = await open(caller);
    await driveToLogin(session);
    const fill = await session.perform({ verb: 'typeSecret', ref: 'e2e-s14', secretName: 'adminPassword' });
    expect(fill.ok).toBe(true);
    expect(fill.tainted).toBe(true);

    const observation = await session.observe({ pixels: true });
    expect(observation.tainted).toBe(true);
    expect(observation.screenshot).toBeUndefined();
    expect(caller.calls.filter((call) => call.tool === 'screenshot')).toHaveLength(0);
  });

  it('surfaces mapped driver errors from the transcript', async () => {
    const { session } = await open();
    await driveToLogin(session);
    await session.perform({ verb: 'typeSecret', ref: 'e2e-s14', secretName: 'adminPassword' });
    const result = await session.perform({ verb: 'drag' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('POLICY_DENIED');
  });

  it('refuses a verb the target does not support', async () => {
    const factory = e2e({ caller: new ReplayCaller() });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    const session = await driver.openSession({ sessionId: 's', scenarioId: 'sc', config: {} });
    const result = await session.perform({ verb: 'invokeMenu' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('DRIVER_INCOMPATIBLE');
  });

  it('closes the session and refuses further work', async () => {
    const { session } = await open();
    await session.observe();
    await session.close();
    await expect(session.observe()).rejects.toThrow(/closed/u);
  });

  it('R-K12b: selfCheck pins the catalog and reports missing tools instead of throwing', async () => {
    const factory = e2e({ caller: new ReplayCaller() });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    const ok = await driver.selfCheck();
    expect(ok.driver).toBe('e2e');
    expect(ok.ok).toBe(true);
    expect(ok.problems).toEqual([]);

    const minimal = new ReplayCaller([
      { tool: 'open_session', result: { session_id: 's-2', tools: ['observe', 'tap'] } },
      { tool: 'close_session', result: { closed: true } },
    ]);
    const sparse = await e2e({ caller: minimal }).create({ sessionId: 's', scenarioId: 'sc', config: {} });
    const problems = await sparse.selfCheck();
    expect(problems.ok).toBe(false);
    expect(problems.problems.join(' ')).toMatch(/missing `screenshot`/u);
  });

  it('declares concurrency from the configured cap', async () => {
    const factory = e2e({ caller: new ReplayCaller(), maxSessions: 6 });
    const driver = await factory.create({ sessionId: 's', scenarioId: 'sc', config: {} });
    expect(driver.concurrency.maxSessions).toBe(6);
    expect(driver.concurrency.exclusiveResource).toBeUndefined();
  });
});

function flattenRefs(nodes: Array<{ ref: string; children?: unknown }>): string[] {
  const out: string[] = [];
  const visit = (list: typeof nodes): void => {
    for (const node of list) {
      out.push(node.ref);
      if (Array.isArray(node.children)) visit(node.children as typeof nodes);
    }
  };
  visit(nodes);
  return out;
}