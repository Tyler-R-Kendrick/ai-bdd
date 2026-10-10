// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { createSettler } from '../../src/evidence/index.ts';
import { fakeClock, obs, scriptedSession } from './helpers.ts';

const OPTS = { quietMs: 300, intervalMs: 100, timeoutMs: 5000 };

describe('settle (R-RN1)', () => {
  it('R-RN1 returns settled once the tree is unchanged for quietMs, polling without pixels on the injected clock', async () => {
    const clock = fakeClock();
    const session = scriptedSession(() => obs('A'));
    const r = await createSettler({ clock }).settle(session, OPTS);
    expect(r.settled).toBe(true);
    expect(r.observation.treeHash).toBe('A');
    // polls at t=0,100,200,300: stable for 300ms at the 4th poll
    expect(r.polls).toBe(4);
    expect(clock.time - 1_000).toBe(300);
    expect(clock.sleeps).toEqual([100, 100, 100]);
    expect(session.calls.every((c) => !c.pixels)).toBe(true);
  });

  it('R-RN1 a tree change restarts the quiet window', async () => {
    const clock = fakeClock();
    // changes on polls 0..2, then constant
    const session = scriptedSession((i) => obs(i < 3 ? `h${i}` : 'final'));
    const r = await createSettler({ clock }).settle(session, OPTS);
    expect(r.settled).toBe(true);
    expect(r.observation.treeHash).toBe('final');
    // 'final' first seen at poll index 3 (t=300); settled when t=600 (poll index 6)
    expect(r.polls).toBe(7);
    expect(clock.time - 1_000).toBe(600);
  });

  it('R-RN1 a busy observation resets stability even when the tree hash is unchanged', async () => {
    const clock = fakeClock();
    const session = scriptedSession((i) => obs('A', { busy: i === 2 }));
    const r = await createSettler({ clock }).settle(session, OPTS);
    expect(r.settled).toBe(true);
    // stable at polls 0,1; busy at 2 (t=200) resets; stable again from poll 3 (t=300) -> settled at t=600
    expect(r.polls).toBe(7);
    expect(clock.time - 1_000).toBe(600);
  });

  it('R-RN1 never reports settled while the screen stays busy; times out with the last observation', async () => {
    const clock = fakeClock();
    const session = scriptedSession(() => obs('A', { busy: true }));
    const r = await createSettler({ clock }).settle(session, { quietMs: 300, intervalMs: 100, timeoutMs: 1000 });
    expect(r.settled).toBe(false);
    expect(r.observation.busy).toBe(true);
    expect(clock.time - 1_000).toBe(1000);
    expect(r.polls).toBe(11);
  });

  it('R-RN1 timeout with an always-changing tree returns settled:false and the last observation', async () => {
    const clock = fakeClock();
    const session = scriptedSession((i) => obs(`h${i}`));
    const r = await createSettler({ clock }).settle(session, { quietMs: 300, intervalMs: 100, timeoutMs: 1000 });
    expect(r.settled).toBe(false);
    expect(r.observation.treeHash).toBe(`h${r.polls - 1}`);
    expect(clock.time - 1_000).toBe(1000);
  });

  it('R-RN1 timeout with pixels requested returns a final observation that carries a screenshot', async () => {
    const clock = fakeClock();
    const session = scriptedSession((i) => obs(`h${i}`));
    const r = await createSettler({ clock }).settle(session, { quietMs: 300, intervalMs: 100, timeoutMs: 500 }, { pixels: true });
    expect(r.settled).toBe(false);
    expect(r.observation.screenshot).toBeDefined();
    expect(session.calls.at(-1)).toEqual({ pixels: true });
    expect(r.polls).toBe(session.calls.length);
  });

  it('R-RN1 pixel re-check: one extra observation with pixels once stable; same hash settles with the screenshot', async () => {
    const clock = fakeClock();
    const session = scriptedSession(() => obs('A'));
    const r = await createSettler({ clock }).settle(session, OPTS, { pixels: true });
    expect(r.settled).toBe(true);
    expect(r.observation.screenshot).toBeDefined();
    expect(r.polls).toBe(5);
    expect(session.calls.filter((c) => c.pixels)).toHaveLength(1);
    expect(session.calls.at(-1)).toEqual({ pixels: true });
  });

  it('R-RN1 pixel re-check: a differing treeHash keeps polling until a pixel observation agrees', async () => {
    const clock = fakeClock();
    // The tree is 'A' on the first stable poll, but the first pixel observation already sees 'B'.
    let pixelCalls = 0;
    const session = scriptedSession((_i, pixels) => {
      if (!pixels) return obs(pixelCalls === 0 ? 'A' : 'B');
      pixelCalls += 1;
      return obs('B');
    });
    const r = await createSettler({ clock }).settle(session, OPTS, { pixels: true });
    expect(r.settled).toBe(true);
    expect(r.observation.treeHash).toBe('B');
    expect(session.calls.filter((c) => c.pixels).length).toBeGreaterThanOrEqual(2);
    // quiet window restarted after the disagreement: strictly more than the minimal 300ms
    expect(clock.time - 1_000).toBeGreaterThan(300);
  });

  it('R-RN1 a pixel observation that is busy does not settle', async () => {
    const clock = fakeClock();
    let first = true;
    const session = scriptedSession((_i, pixels) => {
      if (pixels && first) {
        first = false;
        return obs('A', { busy: true });
      }
      return obs('A');
    });
    const r = await createSettler({ clock }).settle(session, OPTS, { pixels: true });
    expect(r.settled).toBe(true);
    expect(session.calls.filter((c) => c.pixels)).toHaveLength(2);
  });

  it('R-RN1 honors an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const session = scriptedSession(() => obs('A'));
    await expect(createSettler({ clock: fakeClock() }).settle(session, OPTS, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(session.calls).toHaveLength(0);
  });

  it('R-RN1 aborting mid-settle rejects with ABORTED', async () => {
    const ctrl = new AbortController();
    const clock = fakeClock();
    let n = 0;
    const session = scriptedSession(() => {
      n += 1;
      if (n === 2) ctrl.abort();
      return obs(`h${n}`);
    });
    await expect(createSettler({ clock }).settle(session, OPTS, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('R-RN1 quietMs 0 settles on the first non-busy observation', async () => {
    const clock = fakeClock();
    const session = scriptedSession(() => obs('A'));
    const r = await createSettler({ clock }).settle(session, { quietMs: 0, intervalMs: 100, timeoutMs: 1000 });
    expect(r).toMatchObject({ settled: true, polls: 1 });
  });

  it('R-RN1 works with the default (system) clock', async () => {
    const session = scriptedSession(() => obs('A'));
    const r = await createSettler().settle(session, { quietMs: 5, intervalMs: 2, timeoutMs: 500 });
    expect(r.settled).toBe(true);
  });
});
