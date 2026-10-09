import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActRequest, Observation, RecordedAction, StepReproduction } from '@ai-bdd/contracts';
import { createActorRegistry, e2eActor, requireE2eAgent, scriptedActor, withTelemetry } from '../../src/index.js';
import { ReproductionLockStore, reproductionKey } from '../../src/lock.js';
import { replayReproduction } from '../../src/providers/model.js';

function observation(nodes: Array<{ ref: string; role: string; name: string; testId?: string }>, route = '/settings/billing'): Observation {
  return {
    revision: 1,
    nodes: nodes.map((node) => ({ ...node, ...(node.role === 'text' ? { text: node.name } : {}) })),
    treeHash: `hash-${nodes.map((node) => node.name).join('|')}`,
    route,
    tainted: false,
    maskingProven: true,
    settled: true,
    capturedAt: '2026-10-09T00:00:00.000Z',
  };
}

function request(overrides: Partial<ActRequest> = {}): ActRequest {
  return {
    intent: { text: 'Open billing settings', kind: 'action', params: {} },
    session: { sessionId: 's', driverId: 'fake', driverMajor: 1, tainted: false },
    observation: observation([{ ref: 'r1', role: 'button', name: 'Upgrade to Pro' }]),
    budget: { maxActions: 20, maxModelCalls: 15 },
    policy: { allowHosts: ['localhost'], denyVerbs: [] },
    ...overrides,
  };
}

describe('the actor registry is the swap point', () => {
  const upgrade: RecordedAction = { verb: 'tap', selector: { role: 'button', name: 'Upgrade to Pro' } };

  it('resolves an actor by id and reports its capabilities', () => {
    const registry = createActorRegistry();
    registry.register(scriptedActor({ steps: [{ intent: 'Open billing settings', actions: [upgrade] }] }));
    registry.register(e2eActor({ agent: { act: async () => ({}) } }));

    expect(registry.get('scripted')?.id).toBe('scripted');
    expect(registry.get('e2e')?.capabilities.drivesUi).toBe(true);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.list().map((actor) => actor.id).sort()).toEqual(['e2e', 'scripted']);
    expect(registry.default()?.id).toBe('scripted');

    registry.setDefault('e2e');
    expect(registry.default()?.id).toBe('e2e');
    expect(() => registry.setDefault('missing')).toThrow(/unknown actor/u);
  });

  it('runs a scripted actor deterministically, with write-ahead logging', async () => {
    const logged: string[] = [];
    const actor = scriptedActor({
      steps: [{ intent: 'Open billing settings', actions: [upgrade], route: '/settings/billing' }],
    });
    const result = await actor.act(
      request({ onAction: async (action, phase) => void logged.push(`${phase}:${action.verb}`) }),
    );
    expect(result.status).toBe('done');
    expect(result.actions).toEqual([upgrade]);
    expect(result.modelCalls).toBe(0);
    expect(result.determinism).toBe('deterministic');
    expect(logged).toEqual(['will-perform:tap', 'performed:tap']);
  });

  it('hands off when the scripted actor has no entry, instead of guessing', async () => {
    const actor = scriptedActor({ steps: [] });
    const result = await actor.act(request({ intent: { text: 'Something unknown', kind: 'action', params: {} } }));
    expect(result.status).toBe('handoff');
    expect(result.handoff?.reason).toBe('stuck');
    expect(result.handoff?.intent).toBe('Something unknown');
  });

  it('a handoff can be answered by a human and then succeed', async () => {
    const actor = scriptedActor({ steps: [{ intent: 'Open billing settings', actions: [upgrade] }] });
    let asked = 0;
    const result = await actor.act(
      request({
        intent: { text: 'Open billing settings', kind: 'action', params: {} },
        onHandoff: async () => {
          asked += 1;
          return undefined;
        },
      }),
    );
    expect(result.status).toBe('done');
    expect(asked).toBe(0);
  });
});

describe('the e2e actor is a provider, not a code path', () => {
  it('delegates to e2e and reports a self-finalised replay as deterministic', async () => {
    const calls: Array<{ text: string; options?: Record<string, unknown> }> = [];
    const actor = e2eActor({
      agent: {
        act: async (text, options) => {
          calls.push({ text, ...(options !== undefined ? { options } : {}) });
          return { status: 'replayed', actions: [{ verb: 'tap', selector: { role: 'button', name: 'Upgrade to Pro' } }] };
        },
      },
    });
    const result = await actor.act(request({ intent: { text: 'Upgrade the workspace to the Pro plan', kind: 'action', params: { plan: 'Pro' } } }));
    expect(result.status).toBe('done');
    expect(result.determinism).toBe('deterministic');
    expect(result.actions[0]?.verb).toBe('tap');
    expect(calls[0]?.text).toBe('Upgrade the workspace to the Pro plan');
    expect(calls[0]?.options?.params).toEqual({ plan: 'Pro' });
  });

  it('reports an agent-concluded replay as unknown determinism, never a plain pass', async () => {
    const actor = e2eActor({ agent: { act: async () => ({ status: 'agent-concluded', actions: [] }) } });
    const result = await actor.act(request());
    expect(result.determinism).toBe('unknown');
    expect(result.summary).toMatch(/agent/u);
  });

  it('asks a human when e2e cannot finish, and retries with the correction', async () => {
    let attempt = 0;
    const actor = e2eActor({
      agent: {
        act: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('run out of model budget');
          return { status: 'replayed', actions: [] };
        },
      },
    });
    const handoffs: string[] = [];
    const result = await actor.act(
      request({
        onHandoff: async (handoff) => {
          handoffs.push(handoff.reason);
          return { guidance: 'try the confirm button' };
        },
      }),
    );
    expect(result.status).toBe('done');
    expect(handoffs).toEqual(['budget-exhausted']);
    expect(attempt).toBe(2);
  });

  it('refuses to run without the fixture e2e provides', () => {
    expect(() => requireE2eAgent(undefined)).toThrow(/agent fixture/u);
  });

  it('wraps an actor with telemetry', async () => {
    const events: string[] = [];
    const actor = withTelemetry(scriptedActor({ steps: [{ intent: 'Open billing settings', actions: [] }] }), (event) =>
      void events.push(`${event.actorId}:${event.status}`),
    );
    await actor.act(request());
    expect(events).toEqual(['scripted:done']);
  });
});

describe('replay verifies the effect, so a stale reproduction cannot pass', () => {
  function sessionWith(before: Observation, after: Observation): { observe: () => Promise<Observation>; perform: (action: { verb: string; ref?: string }) => Promise<{ ok: boolean; verb: string }> } {
    let phase = 0;
    return {
      observe: async () => (phase === 0 ? before : after),
      perform: async (action) => {
        phase = 1;
        return { ok: true, verb: action.verb };
      },
    };
  }

  const reproduction = {
    start: { route: '/settings/billing', landmarks: [{ role: 'heading', name: 'Billing settings' }] },
    actions: [{ verb: 'tap' as const, selector: { role: 'button', name: 'Upgrade to Pro' } }],
    effect: { elements: [{ selector: { role: 'text', name: 'Plan: Pro plan' }, change: 'appeared' as const }] },
  };

  it('replays and verifies when the effect becomes newly true', async () => {
    const before = observation([{ ref: 'r1', role: 'heading', name: 'Billing settings' }, { ref: 'r2', role: 'button', name: 'Upgrade to Pro' }]);
    const after = observation([{ ref: 'r3', role: 'heading', name: 'Billing settings' }, { ref: 'r4', role: 'text', name: 'Plan: Pro plan' }]);
    const result = await replayReproduction(reproduction, sessionWith(before, after) as never);
    expect(result.status).toBe('replayed');
    expect(result.performed).toBe(1);
  });

  it('refuses to verify when the effect was already present before the replay', async () => {
    // The button is there, so the replay can act; the effect text is already present, so
    // nothing new becomes true and the replay must not be accepted.
    const same = observation([
      { ref: 'r1', role: 'heading', name: 'Billing settings' },
      { ref: 'r2', role: 'button', name: 'Upgrade to Pro' },
      { ref: 'r3', role: 'text', name: 'Plan: Pro plan' },
    ]);
    const result = await replayReproduction(reproduction, sessionWith(same, same) as never);
    expect(result.status).toBe('partial');
    expect(result.reason).toMatch(/not newly true/u);
  });

  it('misses when the start landmark is gone', async () => {
    const before = observation([{ ref: 'r1', role: 'heading', name: 'Something else' }]);
    const result = await replayReproduction(reproduction, sessionWith(before, before) as never);
    expect(result.status).toBe('missed');
    expect(result.reason).toMatch(/landmark/u);
  });

  it('misses when the start route moved', async () => {
    const before = observation([{ ref: 'r1', role: 'heading', name: 'Billing settings' }], '/somewhere/else');
    const result = await replayReproduction(reproduction, sessionWith(before, before) as never);
    expect(result.status).toBe('missed');
    expect(result.reason).toMatch(/route/u);
  });
});

describe('the reproduction lockfile is the intermediate artifact', () => {
  function sample(key: string, overrides: Partial<StepReproduction> = {}): StepReproduction {
    return {
      key,
      intent: { text: 'Open billing settings', kind: 'action', params: {} },
      actorId: 'scripted',
      actorVersion: '0.1.0',
      driverId: 'fake',
      driverMajor: 1,
      start: { route: '/settings/billing', landmarks: [] },
      actions: [{ verb: 'tap', selector: { role: 'button', name: 'Upgrade to Pro' } }],
      effect: { elements: [] },
      determinism: 'deterministic',
      evidence: [],
      modelCalls: 0,
      recordedAt: '2026-10-09T00:00:00.000Z',
      ...overrides,
    };
  }

  it('derives a key from the intent and kind, not the driver', () => {
    const a = reproductionKey({ text: 'Open billing settings.', kind: 'action' }, 'ws:local');
    const b = reproductionKey({ text: 'Open  billing settings', kind: 'action' }, 'ws:local');
    expect(a).toBe(b);
    expect(reproductionKey({ text: 'Open billing settings', kind: 'assertion' }, 'ws:local')).not.toBe(a);
  });

  it('writes a deterministic, sorted file and round-trips it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibdd-lock-'));
    const path = join(dir, 'steps.lock.json');
    const store = ReproductionLockStore.load(path);
    store.upsert(sample('b'));
    store.upsert(sample('a'));
    await store.save();
    const first = readFileSync(path, 'utf8');
    expect(first.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(first) as { steps: StepReproduction[] };
    expect(parsed.steps.map((step) => step.key)).toEqual(['a', 'b']);

    const reloaded = ReproductionLockStore.load(path);
    reloaded.upsert(sample('c'));
    await reloaded.save();
    const second = readFileSync(path, 'utf8');
    const reloadedParsed = JSON.parse(second) as { steps: StepReproduction[] };
    expect(reloadedParsed.steps.map((step) => step.key)).toEqual(['a', 'b', 'c']);
  });

  it('reports what changed, ignoring the fields allowed to move', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibdd-lock-'));
    const path = join(dir, 'steps.lock.json');
    const store = ReproductionLockStore.load(path);
    store.upsert(sample('a'));
    await store.save();

    const reloaded = ReproductionLockStore.load(path);
    reloaded.upsert(sample('a', { modelCalls: 9, recordedAt: '2026-10-10T00:00:00.000Z', evidence: [{ evidenceId: 'e1', kind: 'action-log' }] }));
    expect(reloaded.summary()).toEqual({ added: 0, changed: 0, unchanged: 1, removed: 0 });

    reloaded.upsert(sample('a', { actions: [{ verb: 'tap', selector: { role: 'button', name: 'Downgrade' } }] }));
    expect(reloaded.summary().changed).toBe(1);
  });

  it('reads a lockfile written by another process and keeps its entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibdd-lock-'));
    const path = join(dir, 'steps.lock.json');
    writeFileSync(path, `${JSON.stringify({ version: 1, generator: 'ai-bdd', steps: [sample('existing')] })}\n`);
    const store = ReproductionLockStore.load(path);
    expect(store.size()).toBe(1);
    store.upsert(sample('new'));
    await store.save();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { steps: StepReproduction[] };
    expect(parsed.steps.map((step) => step.key)).toEqual(['existing', 'new']);
  });

  it('is byte-identical across two runs with the same content', async () => {
    const first = mkdtempSync(join(tmpdir(), 'aibdd-lock-a-'));
    const second = mkdtempSync(join(tmpdir(), 'aibdd-lock-b-'));
    for (const dir of [first, second]) {
      const store = ReproductionLockStore.load(join(dir, 'steps.lock.json'));
      store.upsert(sample('b'));
      store.upsert(sample('a'));
      await store.save();
    }
    expect(readFileSync(join(second, 'steps.lock.json'), 'utf8')).toBe(readFileSync(join(first, 'steps.lock.json'), 'utf8'));
  });
});
