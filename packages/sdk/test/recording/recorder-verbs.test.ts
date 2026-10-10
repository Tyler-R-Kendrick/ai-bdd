import { describe, expect, it } from 'vitest';
import {
  AiBddError,
  type ActProgram,
  type DriverAction,
  type DriverCapabilities,
  type DriverSession,
  type ObservedNode,
  type PerformedAction,
  type RecordedAction,
  type ResolvedConfig,
  type SettleOptions,
  type SettleResult,
  type Settler,
} from '../../src/contracts/index.ts';
import { createRecorder, landmarkHash } from '../../src/recording/index.ts';
import { CAPS, FakeSession, POLICY, fromTrees, immediateSettler, observation, step, type AppState } from './kit.ts';

const config = { settle: { quietMs: 111, intervalMs: 22, timeoutMs: 3333, requireSettled: true } } as unknown as ResolvedConfig;
const ctx = { baseURL: 'http://localhost:3000', policy: POLICY };

const FORM = [
  { role: 'form', name: 'Settings', children: [
    { role: 'textbox', name: 'Name' },
    { role: 'combobox', name: 'Plan' },
    { role: 'checkbox', name: 'Terms' },
    { role: 'button', name: 'Go' },
    { role: 'list', name: 'Items' },
    { role: 'link', name: 'Docs' },
  ] },
];

async function formObservation(): Promise<{ before: Awaited<ReturnType<FakeSession['observe']>>; by: (name: string) => ObservedNode }> {
  const session = new FakeSession({ route: '/settings', nodes: fromTrees(FORM) });
  const before = await session.observe();
  return { before, by: (name) => before.nodes.find((n) => n.name === name) as ObservedNode };
}

const FORM_ANCESTORS = [{ role: 'form', name: 'Settings' }];
const selector = (role: string, name: string) => ({ role, name, ancestors: FORM_ANCESTORS, index: 0, of: 1 });

describe('toRecording: every verb', () => {
  it('R-CH7: records check, press, scroll and hover with their selectors and verb arguments', async () => {
    const { before, by } = await formObservation();
    const p = (action: DriverAction, target?: ObservedNode): PerformedAction =>
      target === undefined ? { action, chosenFrom: before, outcome: { ok: true } } : { action, target, chosenFrom: before, outcome: { ok: true } };
    const performed = [
      p({ verb: 'check', target: { ref: by('Terms').ref }, checked: true }, by('Terms')),
      p({ verb: 'check', target: { ref: by('Terms').ref }, checked: false }, by('Terms')),
      p({ verb: 'press', key: 'Enter', target: { ref: by('Name').ref } }, by('Name')),
      p({ verb: 'press', key: 'Escape' }),
      p({ verb: 'scroll', direction: 'down', target: { ref: by('Items').ref } }, by('Items')),
      p({ verb: 'scroll', direction: 'up' }),
      p({ verb: 'hover', target: { ref: by('Docs').ref } }, by('Docs')),
      p({ verb: 'wait', ms: 40 }),
      p({ verb: 'back' }),
      p({ verb: 'navigate', url: '/elsewhere' }),
    ];
    const after = observation([...before.nodes, by('Go')], '/settings');
    const { act, fuzzyReasons } = createRecorder({ settler: immediateSettler(), config }).toRecording(performed, before, after, after, step());
    const expected: RecordedAction[] = [
      { verb: 'check', target: selector('checkbox', 'Terms'), checked: true },
      { verb: 'check', target: selector('checkbox', 'Terms'), checked: false },
      { verb: 'press', key: 'Enter', target: selector('textbox', 'Name') },
      { verb: 'press', key: 'Escape' },
      { verb: 'scroll', direction: 'down', target: selector('list', 'Items') },
      { verb: 'scroll', direction: 'up' },
      { verb: 'hover', target: selector('link', 'Docs') },
      { verb: 'wait', ms: 40 },
      { verb: 'back' },
      { verb: 'navigate', url: '/elsewhere' },
    ];
    expect(act.actions).toEqual(expected);
    expect('target' in (act.actions[3] as object)).toBe(false);
    expect('target' in (act.actions[5] as object)).toBe(false);
    expect(fuzzyReasons).toEqual(['no-observable-effect']);
  });

  it('R-CH7: a target given only by ref is looked up in the observation the action was chosen from', async () => {
    const { before, by } = await formObservation();
    const performed: PerformedAction[] = [{ action: { verb: 'click', target: { ref: by('Go').ref } }, chosenFrom: before, outcome: { ok: true } }];
    const { act, fuzzyReasons } = createRecorder({ settler: immediateSettler(), config }).toRecording(performed, before, before, before, step());
    expect(act.actions).toEqual([{ verb: 'click', target: selector('button', 'Go') }]);
    expect(fuzzyReasons).toEqual(['no-observable-effect']);
  });

  it('R-CH3: a target whose ref is unknown is recorded with an empty selector and the step becomes coordinate-action', async () => {
    const { before } = await formObservation();
    const performed: PerformedAction[] = [{ action: { verb: 'click', target: { ref: 'ghost' } }, chosenFrom: before, outcome: { ok: true } }];
    const after = observation([...before.nodes, { ref: 'n', role: 'status', name: 'x', states: {}, depth: 0 }], '/settings');
    const { act, fuzzyReasons } = createRecorder({ settler: immediateSettler(), config }).toRecording(performed, before, after, after, step());
    expect(act.actions).toEqual([{ verb: 'click', target: { role: '', name: '', ancestors: [], index: 0, of: 1 } }]);
    expect(fuzzyReasons).toEqual(['coordinate-action']);
  });

  it('R-CH3: a press or scroll aimed at an unnamed element is coordinate-action as well', async () => {
    const session = new FakeSession({ route: '/', nodes: fromTrees([{ role: 'generic', name: '' }, { role: 'list', name: 'Items' }]) });
    const before = await session.observe();
    const unnamed = before.nodes[0] as ObservedNode;
    const after = observation([...before.nodes, { ref: 'n', role: 'status', name: 'x', states: {}, depth: 0 }], '/');
    const recorder = createRecorder({ settler: immediateSettler(), config });
    for (const action of [
      { verb: 'press', key: 'Enter', target: { ref: unnamed.ref } },
      { verb: 'scroll', direction: 'down', target: { ref: unnamed.ref } },
    ] satisfies DriverAction[]) {
      const r = recorder.toRecording([{ action, target: unnamed, chosenFrom: before, outcome: { ok: true } }], before, after, after, step());
      expect(r.fuzzyReasons).toEqual(['coordinate-action']);
    }
  });

  it('R-CH7: param slotting also applies to a select option, comparing normalized text', async () => {
    const { before, by } = await formObservation();
    const performed: PerformedAction[] = [
      { action: { verb: 'select', target: { ref: by('Plan').ref }, option: { literal: ' Pro   plan ' } }, target: by('Plan'), chosenFrom: before, outcome: { ok: true } },
    ];
    const after = observation([...before.nodes, by('Go')], '/settings');
    const { act } = createRecorder({ settler: immediateSettler(), config }).toRecording(performed, before, after, after, step({ b: 'Pro plan', a: 'other', tier: 'Pro plan' }));
    // the alphabetically first matching param name wins, deterministically
    expect((act.actions[0] as { option: unknown }).option).toEqual({ param: 'b' });
  });
});

describe('toRecording: agent-only-driver detection', () => {
  const noHover: DriverCapabilities = { ...CAPS, verbs: CAPS.verbs.filter((v) => v !== 'hover') };
  const noSelect: DriverCapabilities = { ...CAPS, verbs: CAPS.verbs.filter((v) => v !== 'select') };

  async function recordClick(name: string, capabilities: DriverCapabilities | undefined, via: 'deps' | 'opts'): Promise<string[]> {
    const { before, by } = await formObservation();
    const target = by(name);
    const performed: PerformedAction[] = [{ action: { verb: 'click', target: { ref: target.ref } }, target, chosenFrom: before, outcome: { ok: true } }];
    const after = observation([...before.nodes, { ref: 'n', role: 'status', name: 'x', states: {}, depth: 0 }], '/settings');
    const recorder = createRecorder(via === 'deps' ? { settler: immediateSettler(), config, ...(capabilities ? { capabilities } : {}) } : { settler: immediateSettler(), config });
    return recorder.toRecording(performed, before, after, after, step(), via === 'opts' && capabilities ? { capabilities } : undefined).fuzzyReasons;
  }

  it('is not reported when no capabilities are known', async () => {
    expect(await recordClick('Go', undefined, 'deps')).toEqual([]);
  });

  it('R-CH3: is reported when a recorded verb is missing from the driver capabilities', async () => {
    const { before, by } = await formObservation();
    const performed: PerformedAction[] = [{ action: { verb: 'hover', target: { ref: by('Docs').ref } }, target: by('Docs'), chosenFrom: before, outcome: { ok: true } }];
    const after = observation([...before.nodes, { ref: 'n', role: 'status', name: 'x', states: {}, depth: 0 }], '/settings');
    const recorder = createRecorder({ settler: immediateSettler(), config });
    expect(recorder.toRecording(performed, before, after, after, step(), { capabilities: noHover }).fuzzyReasons).toEqual(['agent-only-driver']);
    expect(recorder.toRecording(performed, before, after, after, step(), { capabilities: CAPS }).fuzzyReasons).toEqual([]);
  });

  it('R-CH3: a combobox clicked with a driver that has no select verb cannot be replayed by it', async () => {
    expect(await recordClick('Plan', noSelect, 'deps')).toEqual(['agent-only-driver']);
    expect(await recordClick('Plan', noSelect, 'opts')).toEqual(['agent-only-driver']);
  });

  it('a non-select element clicked with a driver that has no select verb is fine', async () => {
    expect(await recordClick('Go', noSelect, 'deps')).toEqual([]);
  });

  it('the capabilities passed to toRecording take precedence over the ones given at creation', async () => {
    const { before, by } = await formObservation();
    const performed: PerformedAction[] = [{ action: { verb: 'hover', target: { ref: by('Docs').ref } }, target: by('Docs'), chosenFrom: before, outcome: { ok: true } }];
    const after = observation([...before.nodes, { ref: 'n', role: 'status', name: 'x', states: {}, depth: 0 }], '/settings');
    const recorder = createRecorder({ settler: immediateSettler(), config, capabilities: noHover });
    expect(recorder.toRecording(performed, before, after, after, step()).fuzzyReasons).toEqual(['agent-only-driver']);
    expect(recorder.toRecording(performed, before, after, after, step(), { capabilities: CAPS }).fuzzyReasons).toEqual([]);
  });
});

describe('toRecording: fuzzy reasons are unique', () => {
  it('R-SE1: a reason found by both the recorder and the secret scrub is reported once', async () => {
    const { createRedactor } = await import('../../src/evidence/index.ts');
    const SECRET = 'Zq7-uniq/Secret+Value!99';
    const { before, by } = await formObservation();
    const target = by('Name');
    const performed: PerformedAction[] = [{ action: { verb: 'fill', target: { ref: target.ref }, value: { literal: SECRET } }, target, chosenFrom: before, outcome: { ok: true } }];
    const same = observation(before.nodes, '/settings');
    const recorder = createRecorder({ settler: immediateSettler(), config, redactor: createRedactor({ pw: SECRET }), secretValue: (n) => (n === 'pw' ? SECRET : undefined) });
    const { act, fuzzyReasons } = recorder.toRecording(performed, before, same, same, step());
    expect((act.actions[0] as { value: unknown }).value).toEqual({ secret: 'pw' });
    expect(fuzzyReasons).toEqual(['no-observable-effect']);
  });
});

describe('replay: every verb', () => {
  it('R-CH7: re-resolves each target by selector and issues the matching driver action for every verb', async () => {
    const nodes = fromTrees(FORM);
    const ref = (name: string): string => (nodes.find((n) => n.name === name) as ObservedNode).ref;
    const start: AppState = { route: '/settings', nodes };
    const before = observation(nodes, '/settings');
    const act: ActProgram = {
      startRoute: '/settings',
      startLandmarks: landmarkHash(before),
      actions: [
        { verb: 'hover', target: selector('link', 'Docs') },
        { verb: 'select', target: selector('combobox', 'Plan'), option: { param: 'plan' } },
        { verb: 'check', target: selector('checkbox', 'Terms'), checked: false },
        { verb: 'press', key: 'Enter', target: selector('textbox', 'Name') },
        { verb: 'press', key: 'Tab' },
        { verb: 'scroll', direction: 'down', target: selector('list', 'Items') },
        { verb: 'scroll', direction: 'up' },
        { verb: 'click', target: selector('button', 'Go') },
        { verb: 'wait', ms: 5 },
        { verb: 'back' },
        { verb: 'navigate', url: '/done' },
      ],
      effect: { routeBefore: '/settings', routeAfter: '/done', appeared: [], disappeared: [], changed: [] },
    };
    const session = new FakeSession(start, (a, s) => {
      if (a.verb === 'navigate') s.route = '/done';
    });
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx);
    expect(r).toMatchObject({ outcome: 'replayed', completedActions: 11 });
    expect('detail' in r).toBe(false);
    expect(session.performed).toEqual([
      { verb: 'hover', target: { ref: ref('Docs') } },
      { verb: 'select', target: { ref: ref('Plan') }, option: { param: 'plan' } },
      { verb: 'check', target: { ref: ref('Terms') }, checked: false },
      { verb: 'press', key: 'Enter', target: { ref: ref('Name') } },
      { verb: 'press', key: 'Tab' },
      { verb: 'scroll', direction: 'down', target: { ref: ref('Items') } },
      { verb: 'scroll', direction: 'up' },
      { verb: 'click', target: { ref: ref('Go') } },
      { verb: 'wait', ms: 5 },
      { verb: 'back' },
      { verb: 'navigate', url: '/done' },
    ]);
    expect('target' in (session.performed[4] as object)).toBe(false);
    expect('target' in (session.performed[6] as object)).toBe(false);
  });
});

describe('replay: failure mapping and settling', () => {
  const clickGo = async (): Promise<{ act: ActProgram; start: () => AppState }> => {
    const nodes = fromTrees(FORM);
    return {
      act: {
        startRoute: '/settings',
        startLandmarks: landmarkHash(observation(nodes, '/settings')),
        actions: [{ verb: 'click', target: selector('button', 'Go') }],
        effect: { routeBefore: '/settings', routeAfter: '/settings', appeared: [{ role: 'status', name: 'Done' }], disappeared: [], changed: [] },
      },
      start: () => ({ route: '/settings', nodes: fromTrees(FORM) }),
    };
  };

  it('a driver outcome without an error object is action-failed with a generic detail', async () => {
    const { act, start } = await clickGo();
    const session = new FakeSession(start(), () => ({ ok: false }));
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx);
    expect(r).toMatchObject({ outcome: 'action-failed', completedActions: 0, detail: 'driver reported failure' });
  });

  it('a driver that throws something other than an Error is action-failed with its string form', async () => {
    const { act, start } = await clickGo();
    const session = new FakeSession(start(), () => {
      throw 'driver exploded'; // eslint-disable-line no-throw-literal
    });
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx);
    expect(r).toMatchObject({ outcome: 'action-failed', completedActions: 0, detail: 'driver exploded' });
  });

  it('R-RN1: an ABORTED error from the driver propagates instead of becoming action-failed', async () => {
    const { act, start } = await clickGo();
    const session = new FakeSession(start(), () => {
      throw new AiBddError('ABORTED', 'driver aborted');
    });
    await expect(createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx)).rejects.toMatchObject({ code: 'ABORTED', message: 'driver aborted' });
  });

  it('R-RN1: other AiBddErrors from the driver are action-failed with their message', async () => {
    const { act, start } = await clickGo();
    const session = new FakeSession(start(), () => {
      throw new AiBddError('STALE_REF', 'stale ref');
    });
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx);
    expect(r).toMatchObject({ outcome: 'action-failed', detail: 'stale ref' });
  });

  it('R-RN1: an abort that happens while an action runs stops the replay before the next action', async () => {
    const nodes = fromTrees(FORM);
    const act: ActProgram = {
      startRoute: '/settings',
      startLandmarks: landmarkHash(observation(nodes, '/settings')),
      actions: [
        { verb: 'click', target: selector('button', 'Go') },
        { verb: 'click', target: selector('link', 'Docs') },
      ],
      effect: { routeBefore: '/settings', routeAfter: '/x', appeared: [], disappeared: [], changed: [] },
    };
    const ac = new AbortController();
    const session = new FakeSession({ route: '/settings', nodes }, () => {
      ac.abort();
    });
    await expect(createRecorder({ settler: immediateSettler(), config }).replay(act, session, { ...ctx, signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED', message: 'replay aborted' });
    expect(session.performed).toHaveLength(1);
  });

  it('reports whether the starting screen settled, and passes the abort signal to the settler', async () => {
    const { act, start } = await clickGo();
    const seen: { opts: SettleOptions; extra: { pixels?: boolean; signal?: AbortSignal } | undefined }[] = [];
    let settledResult = false;
    const settler: Settler = {
      async settle(session: DriverSession, opts, extra): Promise<SettleResult> {
        seen.push({ opts, extra });
        return { settled: settledResult, observation: await session.observe(), polls: 1 };
      },
    };
    const recorder = createRecorder({ settler, config });
    const ac = new AbortController();
    const unsettled = await recorder.replay(act, new FakeSession(start(), (a, s) => { if (a.verb === 'click') s.nodes = [...s.nodes, ...fromTrees([{ role: 'status', name: 'Done' }])]; }), { ...ctx, signal: ac.signal });
    expect(unsettled.outcome).toBe('replayed');
    expect(unsettled.beforeSettled).toBe(false);
    expect(seen.map((s) => s.extra)).toEqual([{ signal: ac.signal }, { signal: ac.signal }]);

    settledResult = true;
    seen.length = 0;
    const settled = await recorder.replay(act, new FakeSession(start(), (a, s) => { if (a.verb === 'click') s.nodes = [...s.nodes, ...fromTrees([{ role: 'status', name: 'Done' }])]; }), ctx);
    expect(settled.beforeSettled).toBe(true);
    expect(seen.map((s) => s.extra)).toEqual([undefined, undefined]);
  });

  it('settle options default to 300/100/5000 and each field can be overridden on its own', async () => {
    const optsOf = async (settle: Partial<SettleOptions> | undefined): Promise<SettleOptions> => {
      const settler = immediateSettler();
      const recorder = createRecorder({ settler, config: { settle } });
      const { act, start } = await clickGo();
      await recorder.replay(act, new FakeSession({ ...start(), route: '/elsewhere' }), ctx);
      return settler.opts[0] as SettleOptions;
    };
    expect(await optsOf(undefined)).toEqual({ quietMs: 300, intervalMs: 100, timeoutMs: 5000 });
    expect(await optsOf({})).toEqual({ quietMs: 300, intervalMs: 100, timeoutMs: 5000 });
    expect(await optsOf({ quietMs: 7 })).toEqual({ quietMs: 7, intervalMs: 100, timeoutMs: 5000 });
    expect(await optsOf({ intervalMs: 8 })).toEqual({ quietMs: 300, intervalMs: 8, timeoutMs: 5000 });
    expect(await optsOf({ timeoutMs: 9 })).toEqual({ quietMs: 300, intervalMs: 100, timeoutMs: 9 });
  });

  it('start-mismatch carries the observed and the recorded route in its detail', async () => {
    const { act, start } = await clickGo();
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, new FakeSession({ ...start(), route: '/other' }), ctx);
    expect(r).toMatchObject({ outcome: 'start-mismatch', completedActions: 0, detail: 'route /other !== /settings' });
  });

  it('target-missing and target-ambiguous details name the selector and the expected count', async () => {
    const { act, start } = await clickGo();
    const recorder = createRecorder({ settler: immediateSettler(), config });
    // the landmark structure (the form) stays identical, so the start check passes
    const missingNodes = start().nodes.filter((n) => n.name !== 'Go');
    const missing = await recorder.replay(act, new FakeSession({ route: '/settings', nodes: missingNodes }), ctx);
    expect(missing).toMatchObject({ outcome: 'target-missing', completedActions: 0, detail: 'button "Go" not found' });

    const twoGo = fromTrees([{ role: 'form', name: 'Settings', children: [{ role: 'button', name: 'Go' }, { role: 'button', name: 'Go' }] }]);
    const ambiguous = await recorder.replay(act, new FakeSession({ route: '/settings', nodes: twoGo }), ctx);
    expect(ambiguous).toMatchObject({ outcome: 'target-ambiguous', completedActions: 0, detail: 'button "Go": 2 candidates, expected 1' });
  });

  it('a denied verb is refused with its name before the driver is asked', async () => {
    const { act, start } = await clickGo();
    const session = new FakeSession(start());
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, { ...ctx, policy: { ...POLICY, denyVerbs: ['click'] } });
    expect(r).toMatchObject({ outcome: 'policy-denied', completedActions: 0, detail: 'verb click is denied by policy' });
    expect(session.performed).toEqual([]);
  });

  it('effect-unverified keeps the completed action count and the verifier detail', async () => {
    const { act, start } = await clickGo();
    const session = new FakeSession(start());
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx);
    expect(r.outcome).toBe('effect-unverified');
    expect(r.completedActions).toBe(1);
    expect(typeof r.detail).toBe('string');
    expect((r.detail ?? '').length).toBeGreaterThan(0);
  });
});
