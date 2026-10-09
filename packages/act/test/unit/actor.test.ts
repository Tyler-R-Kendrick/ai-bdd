import { describe, expect, it } from 'vitest';
import type { ActProgram, ChatModel, DriverSession, GenerateResult, JsonValue, Observation, ToolCall } from '@ai-bdd/contracts';
import { createActor, computeEffect, deriveSelector, effectSatisfied, findBySelector } from '../../src/index.js';

function node(ref: string, role: string, name: string) {
  return { ref, role, name, ...(role === 'text' ? { text: name } : {}) };
}

function observation(revision: number, nodes: ReturnType<typeof node>[], route = '/settings/billing'): Observation {
  return {
    revision,
    nodes,
    treeHash: `hash-${revision}-${nodes.map((n) => n.ref).join(',')}`,
    route,
    tainted: false,
    maskingProven: true,
    settled: true,
    capturedAt: '2026-10-09T00:00:00.000Z',
  };
}

/** A tiny stateful screen: upgrading adds the Pro badge and the dialog. */
function fakeSession(): { session: DriverSession; performed: string[] } {
  const performed: string[] = [];
  let plan = 'free';
  let dialog = false;
  let revision = 0;
  let lastNodes: Array<{ ref: string; name: string }> = [];
  const session: DriverSession = {
    id: 's',
    driverId: 'fake',
    driverMajor: 1,
    async observe(): Promise<Observation> {
      revision += 1;
      const nodes = [node('r-head', 'heading', 'Billing settings'), node('r-plan', 'text', `Plan: ${plan === 'pro' ? 'Pro plan' : 'Free plan'}`)];
      if (!dialog) nodes.push(node('r-upgrade', 'button', 'Upgrade to Pro'));
      else {
        nodes.push(node('r-dialog', 'dialog', 'Upgrade to Pro'));
        nodes.push(node('r-confirm', 'button', 'Confirm upgrade'));
      }
      if (plan === 'pro') nodes.push(node('r-prorated', 'text', 'Prorated amount: 12.00'));
      lastNodes = nodes.map((candidate) => ({ ref: candidate.ref, name: candidate.name }));
      return observation(revision, nodes);
    },
    async perform(action) {
      performed.push(`${action.verb}:${action.selector?.name ?? action.ref ?? action.value ?? ''}`);
      if (action.verb === 'tap') {
        const target = action.selector?.name ?? lastNodes.find((candidate) => candidate.ref === action.ref)?.name;
        if (target === 'Upgrade to Pro') dialog = true;
        if (target === 'Confirm upgrade') {
          plan = 'pro';
          dialog = false;
        }
      }
      return { ok: true, verb: action.verb };
    },
    async close() {},
  };
  return { session, performed };
}

function scriptedModel(calls: ToolCall[]): ChatModel {
  let index = 0;
  return {
    id: 'test:act',
    async generate(): Promise<GenerateResult> {
      const next = calls[Math.min(index, calls.length - 1)]!;
      index += 1;
      return { toolCalls: [next], usage: { inputTokens: 1, outputTokens: 1 }, modelId: 'test:act' };
    },
  };
}

const config = { maxActions: 20, maxModelCalls: 15, grounding: { threshold: 0.6, margin: 0.1 }, policy: { allowHosts: ['localhost'], denyVerbs: [], cua: { allowApps: [] } } };

function cacheHolding(program: ActProgram | null, saved: ActProgram[] = []) {
  return {
    saved,
    async getAct() {
      return program ? { program, invalidation: [{ strategy: 'effect-verify', result: 'valid' }] } : null;
    },
    async putAct(next: ActProgram) {
      saved.push(next);
    },
  };
}

describe('selector derivation (R-K8, section 8.2)', () => {
  it('round-trips deriveSelector and findBySelector', () => {
    const obs = observation(1, [node('r1', 'button', 'Upgrade to Pro'), node('r2', 'text', 'Free plan')]);
    for (const observed of obs.nodes) {
      const selector = deriveSelector(observed, obs);
      const found = findBySelector(selector, obs);
      expect(found).not.toBe('missing');
      expect((found as { name: string }).name).toBe(observed.name);
    }
  });

  it('reports missing and ambiguous', () => {
    const obs = observation(1, [node('r1', 'button', 'Submit'), node('r2', 'button', 'Submit')]);
    expect(findBySelector({ role: 'button', name: 'Submit' }, obs)).toBe('ambiguous');
    expect(findBySelector({ role: 'button', name: 'Nope' }, obs)).toBe('missing');
  });

  it('computes appeared, disappeared and route effects', () => {
    const before = observation(1, [node('a', 'text', 'Free plan')], '/settings/billing');
    const after = observation(2, [node('b', 'text', 'Pro plan')], '/settings/billing?plan=pro');
    const effect = computeEffect(before, after);
    expect(effect.elements.map((element) => element.change)).toContain('appeared');
    expect(effect.route?.after).toBe('/settings/billing?plan=pro');
    expect(effectSatisfied(effect, before, after)).toBe(true);
  });
});

describe('act loop (R-K16, R-K22, R-K23)', () => {
  const step = { id: 's1', text: 'Upgrade the workspace to the Pro plan', options: {} };

  it('records a program and passes on the first run', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const cache = cacheHolding(null);
    const actor = createActor({ model: scriptedModel([
      { name: 'tap', args: { role: 'button', name: 'Upgrade to Pro' } },
      { name: 'tap', args: { role: 'button', name: 'Confirm upgrade' } },
      { name: 'complete_step', args: { status: 'done', summary: 'upgraded' } },
    ]), cache: cache as never, config });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k1', driver: 'fake', driverMajor: 1, cacheMode: 'read-write' });
    expect(outcome.status).toBe('passed');
    expect(outcome.cache.mode).toBe('missed');
    expect(outcome.actions).toHaveLength(2);
    await outcome.pending?.();
    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0]?.pending).toBe(false);
  });

  it('replays a cached program with zero model calls', async () => {
    const { session, performed } = fakeSession();
    const before = await session.observe();
    const program: ActProgram = {
      version: 1,
      key: 'k1',
      text: step.text,
      driver: 'fake',
      driverMajor: 1,
      params: [],
      start: { route: '/settings/billing', landmarks: [{ role: 'heading', name: 'Billing settings' }] },
      actions: [
        { verb: 'tap', selector: { role: 'button', name: 'Upgrade to Pro' } },
        { verb: 'tap', selector: { role: 'button', name: 'Confirm upgrade' } },
      ],
      effect: { elements: [{ selector: { role: 'text', name: 'Prorated amount: 12.00' }, change: 'appeared' }] },
      recordedAt: '2026-10-09T00:00:00.000Z',
    };
    const cache = cacheHolding(program);
    const actor = createActor({ model: scriptedModel([{ name: 'complete_step', args: { status: 'done' } }]), cache: cache as never, config });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k1', driver: 'fake', driverMajor: 1, cacheMode: 'read-write' });
    expect(outcome.status).toBe('passed');
    expect(outcome.cache.mode).toBe('replayed');
    expect(outcome.modelCalls).toBe(0);
    expect(performed).toEqual(['tap:r-upgrade', 'tap:r-confirm']);
  });

  it('heals when a cached selector disappears, and reports healed', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const program: ActProgram = {
      version: 1,
      key: 'k1',
      text: step.text,
      driver: 'fake',
      driverMajor: 1,
      params: [],
      start: { route: '/settings/billing', landmarks: [{ role: 'heading', name: 'Billing settings' }] },
      actions: [
        { verb: 'tap', selector: { role: 'button', name: 'Upgrade to Pro' } },
        { verb: 'tap', selector: { role: 'button', name: 'Rename Me' } },
      ],
      effect: { elements: [{ selector: { role: 'text', name: 'Prorated amount: 12.00' }, change: 'appeared' }] },
      recordedAt: '2026-10-09T00:00:00.000Z',
    };
    const cache = cacheHolding(program);
    const actor = createActor({ model: scriptedModel([
      { name: 'tap', args: { role: 'button', name: 'Confirm upgrade' } },
      { name: 'complete_step', args: { status: 'done' } },
    ]), cache: cache as never, config });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k1', driver: 'fake', driverMajor: 1, cacheMode: 'read-write' });
    expect(outcome.status).toBe('passed');
    expect(outcome.cache.mode).toBe('healed');
    expect(outcome.replayedActions).toBe(1);
  });

  it('misses when the start fingerprint changed', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const program: ActProgram = {
      version: 1,
      key: 'k1',
      text: step.text,
      driver: 'fake',
      driverMajor: 1,
      params: [],
      start: { route: '/somewhere-else', landmarks: [] },
      actions: [{ verb: 'tap', selector: { role: 'button', name: 'Upgrade to Pro' } }],
      effect: { elements: [] },
      recordedAt: '2026-10-09T00:00:00.000Z',
    };
    const actor = createActor({ model: scriptedModel([{ name: 'complete_step', args: { status: 'done' } }]), cache: cacheHolding(program) as never, config });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k1', driver: 'fake', driverMajor: 1, cacheMode: 'read-write' });
    expect(outcome.cache.mode).toBe('missed');
  });

  it('fails with ACT_TARGET_AMBIGUOUS when two targets match', async () => {
    const obs = observation(1, [node('r1', 'button', 'Submit'), node('r2', 'button', 'Submit')]);
    const session: DriverSession = {
      id: 's',
      driverId: 'fake',
      driverMajor: 1,
      async observe() {
        return obs;
      },
      async perform() {
        return { ok: true, verb: 'tap' };
      },
      async close() {},
    };
    const actor = createActor({ model: scriptedModel([{ name: 'tap', args: { role: 'button', name: 'Submit' } }]), cache: cacheHolding(null) as never, config });
    const outcome = await actor.act({ id: 's', text: 'Submit the form', options: {} }, session, { params: {}, before: obs, key: 'k', driver: 'fake', driverMajor: 1, cacheMode: 'off' });
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('ACT_TARGET_AMBIGUOUS');
  });

  it('enforces the action budget', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const actor = createActor({
      model: scriptedModel([{ name: 'tap', args: { role: 'button', name: 'Upgrade to Pro' } }]),
      cache: cacheHolding(null) as never,
      config: { ...config, maxActions: 2, maxModelCalls: 10 },
    });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k', driver: 'fake', driverMajor: 1, cacheMode: 'off' });
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('ACT_BUDGET_EXHAUSTED');
  });

  it('enforces the model-call budget', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const actor = createActor({
      model: scriptedModel([{ name: 'hover', args: { role: 'heading', name: 'Billing settings' } }]),
      cache: cacheHolding(null) as never,
      config: { ...config, maxActions: 50, maxModelCalls: 2 },
    });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k', driver: 'fake', driverMajor: 1, cacheMode: 'off' });
    expect(outcome.error?.code).toBe('ACT_BUDGET_EXHAUSTED');
  });

  it('refuses a denied verb with POLICY_DENIED', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const actor = createActor({
      model: scriptedModel([{ name: 'tap', args: { role: 'button', name: 'Upgrade to Pro' } }]),
      cache: cacheHolding(null) as never,
      config: { ...config, policy: { ...config.policy, denyVerbs: ['tap'] } },
    });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k', driver: 'fake', driverMajor: 1, cacheMode: 'off' });
    expect(outcome.error?.code).toBe('POLICY_DENIED');
  });

  it('does not write a program in read-only cache mode', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const cache = cacheHolding(null);
    const actor = createActor({ model: scriptedModel([{ name: 'complete_step', args: { status: 'done' } }]), cache: cache as never, config });
    const outcome = await actor.act(step, session, { params: {}, before, key: 'k', driver: 'fake', driverMajor: 1, cacheMode: 'read-only' });
    await outcome.pending?.();
    expect(cache.saved).toHaveLength(0);
  });

  it('records a step parameter as a param slot', async () => {
    const { session } = fakeSession();
    const before = await session.observe();
    const cache = cacheHolding(null);
    const actor = createActor({ model: scriptedModel([
      { name: 'tap', args: { role: 'button', name: 'Upgrade to Pro' } },
      { name: 'complete_step', args: { status: 'done' } },
    ]), cache: cache as never, config });
    const outcome = await actor.act({ id: 's', text: 'Upgrade the <plan> plan', options: {} }, session, {
      params: { plan: 'Pro' },
      before,
      key: 'k',
      driver: 'fake',
      driverMajor: 1,
      cacheMode: 'read-write',
    });
    await outcome.pending?.();
    expect(cache.saved[0]?.params).toEqual(['plan']);
    expect(outcome.status).toBe('passed');
  });
});
