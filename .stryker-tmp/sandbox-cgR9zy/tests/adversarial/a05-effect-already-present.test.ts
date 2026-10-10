// @ts-nocheck
// Attack 5: get a replay to pass when the effect was already present before the replay (R-CH7).
// The replay must observe an effect that is NEWLY true; a no-op action in a page that already shows the outcome must not verify.
import { describe, expect, it } from 'vitest';
import { createRecorder } from '@ai-bdd/sdk';
import type { ActProgram, Observation, ObservedNode, PerformedAction, Step } from '@ai-bdd/sdk/contracts';
import { instantSettler, observation, StubSession } from './helpers/kit.ts';

type N = Omit<ObservedNode, 'ref'>;
const n = (role: string, name: string, depth: number, extra: Partial<N> = {}): N => ({ role, name, depth, states: {}, ...extra });

const FREE: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan', 0), n('status', 'Plan: Free', 1), n('button', 'Upgrade', 1)];
const PRO: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan', 0), n('status', 'Plan: Pro', 1), n('button', 'Downgrade', 1)];

const STEP = { key: 'when:abc', kind: 'when', text: 'the customer upgrades', grounding: 'inferred', sources: [], params: {} } as Step;
const policy = { allowHosts: ['localhost'], denyVerbs: [] };
const recorder = createRecorder({ settler: instantSettler, config: {} });

function recordUpgrade(): ActProgram {
  const before: Observation = observation(FREE, { revision: 1 });
  const after: Observation = observation(PRO, { revision: 2 });
  const upgrade = before.nodes.find((x) => x.name === 'Upgrade') as ObservedNode;
  const performed: PerformedAction[] = [{ action: { verb: 'click', target: { ref: upgrade.ref } }, target: upgrade, chosenFrom: before, outcome: { ok: true } }];
  const rec = recorder.toRecording(performed, before, after, after, STEP);
  expect(rec.fuzzyReasons).toEqual([]);
  return rec.act;
}

/** A session whose click either flips the page to PRO or does nothing. */
function session(start: N[], opts: { clickFlips: boolean }): StubSession {
  let current = start;
  return new StubSession(
    () => ({ nodes: current }),
    (a) => {
      if (a.verb === 'click' && opts.clickFlips) current = PRO;
      return { ok: true };
    },
  );
}

describe('A5 R-CH7 replay requires a newly true effect', () => {
  it('A5 R-CH7: control: the recorded upgrade replays on a free page whose click really flips it', async () => {
    const act = recordUpgrade();
    expect(act.effect.appeared.map((k) => k.name).sort()).toEqual(['Downgrade', 'Plan: Pro']);
    const res = await recorder.replay(act, session(FREE, { clickFlips: true }), { policy });
    expect(res.outcome).toBe('replayed');
    expect(res.completedActions).toBe(1);
  });

  it('A5 R-CH7: a no-op click on the free page does not verify (the effect never appears)', async () => {
    const res = await recorder.replay(recordUpgrade(), session(FREE, { clickFlips: false }), { policy });
    expect(res.outcome).toBe('effect-unverified');
  });

  it('A5 R-CH7: the page ALREADY shows the outcome and the target still exists, the click is a no-op: nothing is newly true, so the replay fails', async () => {
    const alreadyPro: N[] = [...PRO, n('button', 'Upgrade', 1)]; // stray Upgrade button keeps the selector resolvable
    const res = await recorder.replay(recordUpgrade(), session(alreadyPro, { clickFlips: false }), { policy });
    expect(res.outcome).not.toBe('replayed');
  });

  it('A5 R-CH7: an effect made ONLY of elements that already held before the action never verifies (hand-trimmed recording)', async () => {
    const act = recordUpgrade();
    const trimmed: ActProgram = { ...act, effect: { ...act.effect, disappeared: [], appeared: [{ role: 'status', name: 'Plan: Pro' }, { role: 'button', name: 'Downgrade' }] } };
    const alreadyPro: N[] = [...PRO, n('button', 'Upgrade', 1)];
    const res = await recorder.replay(trimmed, session(alreadyPro, { clickFlips: false }), { policy });
    expect(res.outcome).toBe('effect-unverified');
    expect(res.detail ?? '').toContain('newly true');
  });

  it('A5 R-CH7: disappeared elements that were already absent before the action are not "newly true" either', async () => {
    const act = recordUpgrade();
    const onlyGone: ActProgram = { ...act, effect: { ...act.effect, appeared: [], disappeared: [{ role: 'status', name: 'Plan: Free' }] } };
    const noFreeStatus: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan', 0), n('button', 'Upgrade', 1)];
    const res = await recorder.replay(onlyGone, session(noFreeStatus, { clickFlips: false }), { policy });
    expect(res.outcome).toBe('effect-unverified');
  });

  it('A5 R-CH7: a state change that already holds (checkbox already checked) is not newly true', async () => {
    const unchecked: N[] = [n('heading', 'Settings', 0, { level: 1 }), n('checkbox', 'Newsletter', 0, { states: { checked: false } })];
    const checked: N[] = [n('heading', 'Settings', 0, { level: 1 }), n('checkbox', 'Newsletter', 0, { states: { checked: true } })];
    const before = observation(unchecked, { revision: 1 });
    const after = observation(checked, { revision: 2 });
    const box = before.nodes[1] as ObservedNode;
    const rec = recorder.toRecording([{ action: { verb: 'check', target: { ref: box.ref }, checked: true }, target: box, chosenFrom: before, outcome: { ok: true } }], before, after, after, STEP);
    expect(rec.act.effect.changed).toHaveLength(1);
    const replayOnChecked = new StubSession(() => ({ nodes: checked }), () => ({ ok: true }));
    expect((await recorder.replay(rec.act, replayOnChecked, { policy })).outcome).toBe('effect-unverified');
    let current = unchecked;
    const replayOnUnchecked = new StubSession(() => ({ nodes: current }), (a) => { if (a.verb === 'check') current = checked; return { ok: true }; });
    expect((await recorder.replay(rec.act, replayOnUnchecked, { policy })).outcome).toBe('replayed');
  });

  it('A5 R-CH7: a recorded route change does not verify when the page was already on the destination (start route mismatch is caught first)', async () => {
    const a: Observation = observation([n('heading', 'A', 0, { level: 1 })], { revision: 1, route: '/a' });
    const b: Observation = observation([n('heading', 'B', 0, { level: 1 })], { revision: 2, route: '/b' });
    const link: PerformedAction = { action: { verb: 'navigate', url: 'http://localhost/b' }, chosenFrom: a, outcome: { ok: true } };
    const rec = recorder.toRecording([link], a, b, b, STEP);
    expect(rec.act.effect.routeAfter).toBe('/b');
    const onB = new StubSession(() => ({ nodes: [n('heading', 'B', 0, { level: 1 })], route: '/b' }));
    expect((await recorder.replay(rec.act, onB, { policy })).outcome).toBe('start-mismatch');
  });

  it('A5 R-CH7: one already-true element plus one genuinely new element verifies (at least one newly true), but a missing recorded element fails', async () => {
    const act = recordUpgrade();
    const presentAlready: N[] = [n('heading', 'Billing', 0, { level: 1 }), n('region', 'Plan', 0), n('status', 'Plan: Free', 1), n('button', 'Downgrade', 1), n('button', 'Upgrade', 1)];
    let cur = presentAlready;
    const flips = new StubSession(() => ({ nodes: cur }), (a) => { if (a.verb === 'click') cur = PRO; return { ok: true }; });
    expect((await recorder.replay(act, flips, { policy })).outcome).toBe('replayed');
    const missing = new StubSession(() => ({ nodes: presentAlready }), () => ({ ok: true }));
    expect((await recorder.replay(act, missing, { policy })).outcome).toBe('effect-unverified');
  });

  it('A5 R-CH7: an action whose only visible consequence is volatile content records no effect, so it can never be a deterministic replay', () => {
    const t1 = [n('heading', 'Todos', 0, { level: 1 }), n('status', 'Synced at 09:00:01.100', 0), n('button', 'Refresh', 0)];
    const t2 = [n('heading', 'Todos', 0, { level: 1 }), n('status', 'Synced at 09:00:02.200', 0), n('button', 'Refresh', 0)];
    const before = observation(t1, { revision: 1 });
    const after = observation(t2, { revision: 2 });
    const btn = before.nodes[2] as ObservedNode;
    const rec = recorder.toRecording([{ action: { verb: 'click', target: { ref: btn.ref } }, target: btn, chosenFrom: before, outcome: { ok: true } }], before, after, after, STEP);
    expect(rec.fuzzyReasons).toContain('no-observable-effect');
    expect(rec.act.effect.appeared).toEqual([]);
    expect(rec.act.effect.changed).toEqual([]);
  });

  it('A5 R-CH7: an effect that does not hold on the later probe of the same page is not recorded (probe-unstable elements are excluded)', () => {
    const before = observation(FREE, { revision: 1 });
    const after = observation([...PRO, n('status', 'Saved', 1)], { revision: 2 });
    const probe = observation(PRO, { revision: 3 }); // "Saved" vanished again
    const up = before.nodes[3] as ObservedNode;
    const rec = recorder.toRecording([{ action: { verb: 'click', target: { ref: up.ref } }, target: up, chosenFrom: before, outcome: { ok: true } }], before, after, probe, STEP);
    expect(rec.act.effect.appeared.map((k) => k.name)).not.toContain('Saved');
  });
});
