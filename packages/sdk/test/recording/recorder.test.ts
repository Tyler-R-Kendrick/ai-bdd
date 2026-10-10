import { describe, expect, it } from 'vitest';
import {
  AiBddError,
  type ActProgram,
  type ActionOutcome,
  type DriverAction,
  type DriverCapabilities,
  type ObservedNode,
  type PerformedAction,
  type RecordedAction,
  type ResolvedConfig,
} from '../../src/contracts/index.ts';
import { createRedactor } from '../../src/evidence/index.ts';
import { createRecorder, landmarkHash } from '../../src/recording/index.ts';
import { sha256Hex } from '../../src/util/index.ts';
import { CAPS, FakeSession, POLICY, fromTrees, immediateSettler, node, observation, step, type AppState, type Tree } from './kit.ts';

const config = { settle: { quietMs: 111, intervalMs: 22, timeoutMs: 3333, requireSettled: true } } as unknown as ResolvedConfig;

const FREE: Tree[] = [
  { role: 'banner', name: 'Acme' },
  { role: 'main', name: 'Billing', children: [
    { role: 'heading', name: 'Billing', level: 1 },
    { role: 'region', name: 'Plan', children: [{ role: 'heading', name: 'Plan: Free', level: 2 }, { role: 'button', name: 'Upgrade to Pro' }] },
  ] },
];
const PRO: Tree[] = [
  { role: 'banner', name: 'Acme' },
  { role: 'main', name: 'Billing', children: [
    { role: 'heading', name: 'Billing', level: 1 },
    { role: 'region', name: 'Plan', children: [{ role: 'heading', name: 'Plan: Pro', level: 2 }, { role: 'status', name: 'Upgraded to Pro' }] },
  ] },
];

function freeState(): AppState {
  return { route: '/billing', nodes: fromTrees(FREE) };
}
const upgradeReducer = (action: DriverAction, state: AppState): ActionOutcome | void => {
  if (action.verb === 'click') {
    const n = state.nodes.find((x) => x.ref === action.target.ref);
    if (n === undefined) return { ok: false, error: { code: 'STALE_REF', message: 'stale', retryable: false } };
    if (n.name === 'Upgrade to Pro') state.nodes = fromTrees(PRO);
  }
};

/** Run the "agent" once against a session and return what the recorder needs. */
async function characterize(opts: { reducer?: typeof upgradeReducer; start?: AppState; params?: Record<string, string>; pick?: (obs: ReturnType<typeof observation>) => ObservedNode } = {}) {
  const session = new FakeSession(opts.start ?? freeState(), opts.reducer ?? upgradeReducer);
  const before = await session.observe();
  const target = opts.pick ? opts.pick(before) : (before.nodes.find((n) => n.name === 'Upgrade to Pro') as ObservedNode);
  const action: DriverAction = { verb: 'click', target: { ref: target.ref } };
  const outcome = await session.perform(action);
  const after = await session.observe();
  const probe = await session.observe();
  const performed: PerformedAction[] = [{ action, target, chosenFrom: before, outcome }];
  const recorder = createRecorder({ settler: immediateSettler(), config });
  return { before, after, probe, performed, recorder, session, step: step(opts.params ?? {}) };
}

describe('toRecording', () => {
  it('R-CH7: derives selectors from the observation each action was chosen from, with startRoute and effect', async () => {
    const c = await characterize();
    const { act, fuzzyReasons } = c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step);
    expect(fuzzyReasons).toEqual([]);
    expect(act.startRoute).toBe('/billing');
    expect(act.actions).toEqual([
      { verb: 'click', target: { role: 'button', name: 'Upgrade to Pro', ancestors: [{ role: 'region', name: 'Plan' }, { role: 'main', name: 'Billing' }], index: 0, of: 1 } },
    ]);
    expect(act.effect.appeared).toEqual([{ role: 'heading', name: 'Plan: Pro' }, { role: 'status', name: 'Upgraded to Pro' }]);
    expect(act.effect.disappeared).toEqual([{ role: 'button', name: 'Upgrade to Pro' }, { role: 'heading', name: 'Plan: Free' }]);
    expect(act.effect.routeAfter).toBe('/billing');
    expect(act.startLandmarks).toBe(landmarkHash(c.before));
  });

  it('R-CH7: a selector chosen from an earlier observation is not re-derived from the final one', async () => {
    const c = await characterize();
    // Second action chosen from `after`, where the first button no longer exists.
    const heading = c.after.nodes.find((n) => n.name === 'Plan: Pro') as ObservedNode;
    const hover: PerformedAction = { action: { verb: 'hover', target: { ref: heading.ref } }, target: heading, chosenFrom: c.after, outcome: { ok: true } };
    const { act } = c.recorder.toRecording([...c.performed, hover], c.before, c.after, c.probe, c.step);
    expect(act.actions.map((a) => a.verb)).toEqual(['click', 'hover']);
    expect((act.actions[1] as Extract<RecordedAction, { verb: 'hover' }>).target.name).toBe('Plan: Pro');
  });

  it('R-CH7: param slotting turns a fill text equal to a step param value into {param}', async () => {
    const start: AppState = { route: '/s', nodes: fromTrees([{ role: 'form', name: 'Signup', children: [{ role: 'textbox', name: 'Name' }, { role: 'textbox', name: 'Pass' }, { role: 'textbox', name: 'Note' }, { role: 'combobox', name: 'Plan' }] }]) };
    const session = new FakeSession(start);
    const before = await session.observe();
    const by = (name: string): ObservedNode => before.nodes.find((n) => n.name === name) as ObservedNode;
    const p = (action: DriverAction, target: ObservedNode): PerformedAction => ({ action, target, chosenFrom: before, outcome: { ok: true } });
    const performed = [
      p({ verb: 'fill', target: { ref: by('Name').ref }, value: { literal: 'Alice  Smith' } }, by('Name')),
      p({ verb: 'fill', target: { ref: by('Pass').ref }, value: { secret: 'adminPassword' } }, by('Pass')),
      p({ verb: 'fill', target: { ref: by('Note').ref }, value: { literal: 'hello' } }, by('Note')),
      p({ verb: 'select', target: { ref: by('Plan').ref }, option: { literal: 'Pro' } }, by('Plan')),
    ];
    const recorder = createRecorder({ settler: immediateSettler(), config });
    const after = observation([...before.nodes, node('status', 'Saved')], '/s');
    const { act } = recorder.toRecording(performed, before, after, after, step({ name: 'Alice Smith', tier: 'Pro' }));
    expect(act.actions.map((a) => ('value' in a ? a.value : 'option' in a ? a.option : null))).toEqual([
      { param: 'name' },
      { secret: 'adminPassword' },
      { literal: 'hello' },
      { param: 'tier' },
    ]);
    expect(JSON.stringify(act)).not.toContain('Alice');
  });

  it('R-SE1: with a redactor, a literal equal to a secret becomes {secret}, and effect entries reflecting the secret are dropped', async () => {
    const SECRET = 'Zq7-uniq/Secret+Value!99';
    const redactor = createRedactor({ adminPassword: SECRET });
    const start: AppState = { route: '/s', nodes: fromTrees([{ role: 'form', name: 'Signup', children: [{ role: 'textbox', name: 'Email' }, { role: 'textbox', name: 'Note' }] }]) };
    const session = new FakeSession(start);
    const before = await session.observe();
    const email = before.nodes.find((n) => n.name === 'Email') as ObservedNode;
    const note = before.nodes.find((n) => n.name === 'Note') as ObservedNode;
    const p = (action: DriverAction, target: ObservedNode): PerformedAction => ({ action, target, chosenFrom: before, outcome: { ok: true } });
    const performed = [
      p({ verb: 'fill', target: { ref: email.ref }, value: { literal: SECRET } }, email),
      p({ verb: 'fill', target: { ref: note.ref }, value: { literal: `x ${encodeURIComponent(SECRET)} y` } }, note),
    ];
    const after = observation(
      before.nodes.map((n) => (n.name === 'Email' ? { ...n, value: SECRET } : n)).concat([node('status', `Hello ${SECRET}`)]),
      '/s',
    );
    const recorder = createRecorder({ settler: immediateSettler(), config, redactor, secretValue: (n) => (n === 'adminPassword' ? SECRET : undefined) });
    const { act, fuzzyReasons } = recorder.toRecording(performed, before, after, after, step());
    expect(act.actions[0]).toMatchObject({ verb: 'fill', value: { secret: 'adminPassword' } });
    expect(act.effect.changed).toEqual([]);
    expect(act.effect.appeared).toEqual([]);
    expect(fuzzyReasons).toContain('no-observable-effect');
    // a literal that merely contains an encoded secret cannot be replayed exactly: redacted hint, fuzzy
    expect(fuzzyReasons).toContain('secret-in-recording');
    const text = JSON.stringify(act);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(encodeURIComponent(SECRET));
  });

  it('R-CH7: skips actions whose outcome was not ok, and keeps navigate/back/wait/press/scroll shapes', async () => {
    const c = await characterize();
    const failed: PerformedAction = { action: { verb: 'click', target: { ref: 'nope' } }, chosenFrom: c.before, outcome: { ok: false } };
    const misc: PerformedAction[] = [
      { action: { verb: 'navigate', url: '/billing' }, chosenFrom: c.before, outcome: { ok: true } },
      { action: { verb: 'press', key: 'Enter' }, chosenFrom: c.before, outcome: { ok: true } },
      { action: { verb: 'scroll', direction: 'down' }, chosenFrom: c.before, outcome: { ok: true } },
      { action: { verb: 'back' }, chosenFrom: c.before, outcome: { ok: true } },
      { action: { verb: 'wait', ms: 10 }, chosenFrom: c.before, outcome: { ok: true } },
    ];
    const { act, fuzzyReasons } = c.recorder.toRecording([failed, ...misc, ...c.performed], c.before, c.after, c.probe, c.step);
    expect(act.actions.map((a) => a.verb)).toEqual(['navigate', 'press', 'scroll', 'back', 'wait', 'click']);
    expect(fuzzyReasons).toEqual([]);
  });

  it('R-CH3: coordinate-action when the target has no role or no name', async () => {
    const start: AppState = { route: '/', nodes: [node('generic', ''), node('button', 'Ok')] };
    const c = await characterize({ start, reducer: (a, s) => { if (a.verb === 'click') s.nodes = [...s.nodes, node('status', 'Done')]; }, pick: (o) => o.nodes[0] as ObservedNode });
    const r = c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step);
    expect(r.fuzzyReasons).toContain('coordinate-action');
    expect(r.act.actions).toHaveLength(1);
    // A performed action whose target cannot be resolved at all is a coordinate action too.
    const lost: PerformedAction = { action: { verb: 'click', target: { ref: 'ghost' } }, chosenFrom: c.before, outcome: { ok: true } };
    expect(c.recorder.toRecording([lost], c.before, c.after, c.probe, c.step).fuzzyReasons).toContain('coordinate-action');
  });

  it('R-CH3: no-observable-effect when nothing changed and the route is unchanged', async () => {
    const c = await characterize({ reducer: () => undefined });
    const r = c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step);
    expect(r.fuzzyReasons).toEqual(['no-observable-effect']);
  });

  it('R-CH3: an effect consisting only of volatile changes is no-observable-effect', async () => {
    const start: AppState = { route: '/', nodes: [node('button', 'Tick'), node('status', 'Time 10:00')] };
    const c = await characterize({
      start,
      pick: (o) => o.nodes[0] as ObservedNode,
      reducer: (a, s) => { if (a.verb === 'click') s.nodes = [node('button', 'Tick'), node('status', 'Time 10:01')]; },
    });
    expect(c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step).fuzzyReasons).toEqual(['no-observable-effect']);
  });

  it('R-CH3: a route change alone is an observable effect', async () => {
    const start: AppState = { route: '/a', nodes: [node('link', 'Go')] };
    const c = await characterize({ start, pick: (o) => o.nodes[0] as ObservedNode, reducer: (a, s) => { if (a.verb === 'click') s.route = '/b'; } });
    const r = c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step);
    expect(r.fuzzyReasons).toEqual([]);
    expect(r.act.effect.routeAfter).toBe('/b');
  });

  it('R-CH3: agent-only-driver when the driver lacks select (or other needed verbs) for replay', async () => {
    const start: AppState = { route: '/', nodes: [node('combobox', 'Plan'), node('button', 'Save')] };
    const reducer = (a: DriverAction, s: AppState): void => { if (a.verb === 'select' || a.verb === 'click') s.nodes = [...s.nodes, node('status', 'Changed')]; };
    const noSelect: DriverCapabilities = { ...CAPS, verbs: CAPS.verbs.filter((v) => v !== 'select') };

    const c = await characterize({ start, reducer, pick: (o) => o.nodes[0] as ObservedNode });
    const sel: PerformedAction[] = [{ ...c.performed[0], action: { verb: 'select', target: { ref: (c.performed[0] as PerformedAction).target?.ref ?? '' }, option: { literal: 'Pro' } } } as PerformedAction];
    expect(c.recorder.toRecording(sel, c.before, c.after, c.probe, c.step).fuzzyReasons).toEqual([]);
    expect(c.recorder.toRecording(sel, c.before, c.after, c.probe, c.step, { capabilities: noSelect }).fuzzyReasons).toEqual(['agent-only-driver']);

    const viaDeps = createRecorder({ settler: immediateSettler(), config, capabilities: { ...CAPS, verbs: ['navigate'] } });
    expect(viaDeps.toRecording(c.performed, c.before, c.after, c.probe, c.step).fuzzyReasons).toEqual(['agent-only-driver']);
  });

  it('R-CH7: effect exclusion is applied to the stored effect (volatile and probe-unstable elements are dropped)', async () => {
    const c = await characterize({
      reducer: (a, s) => {
        if (a.verb === 'click') s.nodes = [...fromTrees(PRO), node('status', 'Saved 12:44'), node('status', 'Sparkle')];
      },
    });
    const probe = observation(c.after.nodes.filter((n) => n.name !== 'Sparkle'), c.after.route);
    const { act } = c.recorder.toRecording(c.performed, c.before, c.after, probe, c.step);
    const names = act.effect.appeared.map((k) => k.name);
    expect(names).toContain('Upgraded to Pro');
    expect(names).not.toContain('Saved 12:44');
    expect(names).not.toContain('Sparkle');
  });
});

describe('landmarkHash', () => {
  it('R-CH7: sha256 of sorted unique role|name for landmarks and level-1 headings only', () => {
    const o = observation([
      node('main', 'Billing'),
      node('banner', 'Acme'),
      node('banner', 'Acme'),
      node('heading', 'Title', { level: 1 }),
      node('heading', 'Sub', { level: 2 }),
      node('button', 'Ignored'),
    ]);
    expect(landmarkHash(o)).toBe(sha256Hex(['banner|Acme', 'heading|Title', 'main|Billing'].join('\n')));
    const reordered = observation([node('heading', 'Title', { level: 1 }), node('main', 'Billing'), node('banner', 'Acme')]);
    expect(landmarkHash(reordered)).toBe(landmarkHash(o));
    expect(landmarkHash(observation([node('dialog', 'Confirm'), ...o.nodes]))).not.toBe(landmarkHash(o));
  });
});

describe('replay', () => {
  const ctx = { baseURL: 'http://localhost:3000', policy: POLICY };

  async function recorded(): Promise<{ act: ActProgram; recorder: ReturnType<typeof createRecorder>; settler: ReturnType<typeof immediateSettler> }> {
    const c = await characterize();
    const { act } = c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step);
    const settler = immediateSettler();
    return { act, recorder: createRecorder({ settler, config }), settler };
  }

  it('R-CH7: replays a recording onto a fresh session and verifies the newly-true effect', async () => {
    const { act, recorder, settler } = await recorded();
    const session = new FakeSession(freeState(), upgradeReducer);
    const r = await recorder.replay(act, session, ctx);
    expect(r).toMatchObject({ outcome: 'replayed', completedActions: 1 });
    expect(session.performed).toHaveLength(1);
    expect(session.performed[0]).toMatchObject({ verb: 'click' });
    expect(r.after.nodes.some((n) => n.name === 'Upgraded to Pro')).toBe(true);
    expect(r.before.nodes.some((n) => n.name === 'Upgraded to Pro')).toBe(false);
    // settle: before + once per action; configured options are used.
    expect(settler.calls).toBe(2);
    expect(settler.opts[0]).toEqual({ quietMs: 111, intervalMs: 22, timeoutMs: 3333 });
  });

  it('R-CH7: every action resolves on a freshly settled observation (refs are re-resolved, never reused)', async () => {
    const start: AppState = { route: '/', nodes: [node('button', 'Next')] };
    const reducer = (a: DriverAction, s: AppState): void => {
      if (a.verb === 'click') s.nodes = [node('button', `Step ${s.nodes.length + 1}`, { ref: 'fresh' + Math.random() }), node('button', 'Next', { ref: 'again' + Math.random() })];
    };
    const session = new FakeSession(start, reducer);
    const before = await session.observe();
    const chosen = before.nodes[0] as ObservedNode;
    const p1: PerformedAction = { action: { verb: 'click', target: { ref: chosen.ref } }, target: chosen, chosenFrom: before, outcome: { ok: true } };
    await session.perform(p1.action);
    const mid = await session.observe();
    const next = mid.nodes.find((n) => n.name === 'Next') as ObservedNode;
    const p2: PerformedAction = { action: { verb: 'click', target: { ref: next.ref } }, target: next, chosenFrom: mid, outcome: { ok: true } };
    await session.perform(p2.action);
    const after = await session.observe();
    const rec = createRecorder({ settler: immediateSettler(), config });
    const { act } = rec.toRecording([p1, p2], before, after, after, step());

    const live = new FakeSession({ route: '/', nodes: [node('button', 'Next')] }, reducer);
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, live, ctx);
    expect(r.outcome).toBe('replayed');
    const refs = live.performed.map((a) => (a.verb === 'click' ? a.target.ref : ''));
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[1]).toMatch(/^again/);
  });

  it('R-CH7: an effect that is already present before the replay never verifies', async () => {
    const { act, recorder } = await recorded();
    // The "Pro" badge is already on screen, and the click target still exists, but the click changes nothing.
    const already: AppState = { route: '/billing', nodes: fromTrees(FREE).concat(node('status', 'Upgraded to Pro')) };
    const session = new FakeSession(already, () => undefined);
    const r = await recorder.replay(act, session, ctx);
    expect(r.outcome).toBe('effect-unverified');
    expect(r.completedActions).toBe(1);
  });

  it('R-CH7: still requires one newly-true element even when every recorded element holds afterwards', async () => {
    const { act, recorder } = await recorded();
    // Appeared "Upgraded to Pro" is present before; "Upgrade to Pro" (disappeared) is absent before and after.
    const state: AppState = { route: '/billing', nodes: fromTrees(PRO) };
    const session = new FakeSession(state);
    const r = await recorder.replay({ ...act, startLandmarks: landmarkHash(observation(state.nodes)), actions: [] }, session, ctx);
    expect(r.outcome).toBe('effect-unverified');
    expect(r.detail).toMatch(/newly true/);
  });

  it('R-CH7: an empty recorded effect never verifies', async () => {
    const { act, recorder } = await recorded();
    const empty: ActProgram = { ...act, effect: { ...act.effect, appeared: [], disappeared: [], changed: [] } };
    const r = await recorder.replay(empty, new FakeSession(freeState(), upgradeReducer), ctx);
    expect(r.outcome).toBe('effect-unverified');
  });

  it('R-CH7: effect-unverified when a recorded disappearance did not happen or the route differs', async () => {
    const { act, recorder } = await recorded();
    const stays = new FakeSession(freeState(), (a, s) => { if (a.verb === 'click') s.nodes = [...fromTrees(PRO), node('button', 'Upgrade to Pro')]; });
    const r1 = await recorder.replay(act, stays, ctx);
    expect(r1.outcome).toBe('effect-unverified');
    expect(r1.detail).toMatch(/disappear/);

    const wrongRoute = new FakeSession(freeState(), (a, s) => { upgradeReducer(a, s); s.route = '/elsewhere'; });
    const r2 = await recorder.replay(act, wrongRoute, ctx);
    expect(r2.outcome).toBe('effect-unverified');
    expect(r2.detail).toMatch(/route/);
  });

  it('R-CH7: changed elements must reach their recorded `to` value, and a route-only effect is verified by the route', async () => {
    const start: AppState = { route: '/', nodes: [node('checkbox', 'Agree', { states: { checked: false } })] };
    const toggle = (a: DriverAction, s: AppState): void => {
      if (a.verb === 'click') s.nodes = [node('checkbox', 'Agree', { states: { checked: true } })];
    };
    const c = await characterize({ start, reducer: toggle, pick: (o) => o.nodes[0] as ObservedNode });
    const { act } = c.recorder.toRecording(c.performed, c.before, c.after, c.probe, c.step);
    expect(act.effect.changed).toHaveLength(1);
    const recorder = createRecorder({ settler: immediateSettler(), config });
    expect((await recorder.replay(act, new FakeSession({ route: '/', nodes: [node('checkbox', 'Agree', { states: { checked: false } })] }, toggle), ctx)).outcome).toBe('replayed');
    // Already checked beforehand: holds, but is not newly true.
    expect((await recorder.replay(act, new FakeSession({ route: '/', nodes: [node('checkbox', 'Agree', { states: { checked: true } })] }, toggle), ctx)).outcome).toBe('effect-unverified');
    // Click did nothing.
    expect((await recorder.replay(act, new FakeSession({ route: '/', nodes: [node('checkbox', 'Agree', { states: { checked: false } })] }), ctx)).outcome).toBe('effect-unverified');

    const nav: ActProgram = { startRoute: '/a', startLandmarks: landmarkHash(observation([])), actions: [{ verb: 'back' }], effect: { routeBefore: '/a', routeAfter: '/b', appeared: [], disappeared: [], changed: [] } };
    const go = (a: DriverAction, s: AppState): void => { if (a.verb === 'back') s.route = '/b'; };
    expect((await recorder.replay(nav, new FakeSession({ route: '/a', nodes: [] }, go), ctx)).outcome).toBe('replayed');
    expect((await recorder.replay(nav, new FakeSession({ route: '/a', nodes: [] }), ctx)).outcome).toBe('effect-unverified');
  });

  it('R-CH4: start-mismatch when the route or the landmark structure differs, before any action', async () => {
    const { act, recorder } = await recorded();
    const otherRoute = new FakeSession({ route: '/settings', nodes: fromTrees(FREE) }, upgradeReducer);
    expect(await recorder.replay(act, otherRoute, ctx)).toMatchObject({ outcome: 'start-mismatch', completedActions: 0 });
    expect(otherRoute.performed).toHaveLength(0);

    const withDialog = new FakeSession({ route: '/billing', nodes: fromTrees([...FREE, { role: 'dialog', name: 'Cookies' }]) }, upgradeReducer);
    const r = await recorder.replay(act, withDialog, ctx);
    expect(r.outcome).toBe('start-mismatch');
    expect(withDialog.performed).toHaveLength(0);
  });

  it('R-CH5: target-missing and target-ambiguous stop the replay with the completed prefix', async () => {
    const { act, recorder } = await recorded();
    const gone = new FakeSession({ route: '/billing', nodes: fromTrees(FREE).filter((n) => n.name !== 'Upgrade to Pro') }, upgradeReducer);
    expect(await recorder.replay(act, gone, ctx)).toMatchObject({ outcome: 'target-missing', completedActions: 0 });

    const dup = fromTrees([
      ...FREE.slice(0, 1),
      { role: 'main', name: 'Billing', children: [
        { role: 'heading', name: 'Billing', level: 1 },
        { role: 'region', name: 'Plan', children: [{ role: 'button', name: 'Upgrade to Pro' }, { role: 'button', name: 'Upgrade to Pro' }] },
      ] },
    ]);
    const session = new FakeSession({ route: '/billing', nodes: dup }, upgradeReducer);
    const r = await recorder.replay(act, session, ctx);
    expect(r).toMatchObject({ outcome: 'target-ambiguous', completedActions: 0 });
    expect(session.performed).toHaveLength(0);
  });

  it('R-CH5: action-failed on a not-ok outcome or a driver error, after the actions that did complete', async () => {
    const { act, recorder } = await recorded();
    const notOk = new FakeSession(freeState(), () => ({ ok: false, error: { code: 'DRIVER_ERROR', message: 'boom', retryable: true } }));
    expect(await recorder.replay(act, notOk, ctx)).toMatchObject({ outcome: 'action-failed', completedActions: 0, detail: 'boom' });

    const throws = new FakeSession(freeState(), () => { throw new AiBddError('STALE_REF', 'stale ref e1'); });
    expect(await recorder.replay(act, throws, ctx)).toMatchObject({ outcome: 'action-failed', detail: 'stale ref e1' });
  });

  it('R-AG3: off-policy navigate is policy-denied and never performed; denied verbs too', async () => {
    const recorder = createRecorder({ settler: immediateSettler(), config });
    const empty = observation([]);
    const base = { startRoute: '/', startLandmarks: landmarkHash(empty), effect: { routeBefore: '/', routeAfter: '/x', appeared: [], disappeared: [], changed: [] } };
    for (const url of ['https://evil.example/steal', 'javascript:alert(1)', 'http://user:pw@localhost/', 'file:///etc/passwd']) {
      const session = new FakeSession({ route: '/', nodes: [] });
      const r = await recorder.replay({ ...base, actions: [{ verb: 'navigate', url }] }, session, ctx);
      expect(r.outcome).toBe('policy-denied');
      expect(session.performed).toHaveLength(0);
    }
    const ok = new FakeSession({ route: '/', nodes: [] }, (a, s) => { if (a.verb === 'navigate') s.route = '/x'; });
    expect((await recorder.replay({ ...base, actions: [{ verb: 'navigate', url: '/x' }] }, ok, ctx)).outcome).toBe('replayed');

    const denied = new FakeSession({ route: '/', nodes: [] });
    const r = await recorder.replay({ ...base, actions: [{ verb: 'back' }] }, denied, { ...ctx, policy: { ...POLICY, denyVerbs: ['back'] } });
    expect(r.outcome).toBe('policy-denied');
    expect(denied.performed).toHaveLength(0);
  });

  it('R-CH7: fill values are passed through as value sources for the session to resolve', async () => {
    const start: AppState = { route: '/', nodes: [node('textbox', 'Name')] };
    const act: ActProgram = {
      startRoute: '/',
      startLandmarks: landmarkHash(observation([])),
      actions: [{ verb: 'fill', target: { role: 'textbox', name: 'Name', ancestors: [], index: 0, of: 1 }, value: { param: 'name' } }],
      effect: { routeBefore: '/', routeAfter: '/', appeared: [], disappeared: [], changed: [{ key: { role: 'textbox', name: 'Name' }, state: 'value', from: '', to: 'Alice' }] },
    };
    const session = new FakeSession(start, (a, s) => { if (a.verb === 'fill') s.nodes = [node('textbox', 'Name', { value: 'Alice' })]; });
    const r = await createRecorder({ settler: immediateSettler(), config }).replay(act, session, ctx);
    expect(r.outcome).toBe('replayed');
    expect(session.performed[0]).toMatchObject({ verb: 'fill', value: { param: 'name' } });
  });

  it('R-RN1: an aborted signal stops the replay with ABORTED', async () => {
    const { act, recorder } = await recorded();
    const ac = new AbortController();
    ac.abort();
    await expect(recorder.replay(act, new FakeSession(freeState(), upgradeReducer), { ...ctx, signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
