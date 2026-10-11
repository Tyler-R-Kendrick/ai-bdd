import { describe, expect, it } from 'vitest';
import { createHarness, thenStep, when } from './doubles/harness.ts';
import { FakeDriver, type FakeSession } from './doubles/world.ts';

const ACT = 'the user clicks Upgrade to Pro';
const CHECK = 'Plan: Pro';
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** Every session this harness' driver opens is handed to `tweak` before the runner sees it. */
function tweakSessions(h: ReturnType<typeof createHarness>, tweak: (s: FakeSession) => void): void {
  h.driver.openSession = (async (o: Parameters<FakeDriver['openSession']>[0]) => {
    const s = await FakeDriver.prototype.openSession.call(h.driver, o);
    tweak(s);
    return s;
  }) as FakeDriver['openSession'];
}

describe('a driver call that never returns cannot hold an aborted run hostage', () => {
  it('a hung start navigation: the abort ends the scenario with ABORTED and the session is still closed', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    tweakSessions(h, (s) => {
      s.perform = () => never();
    });
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    const r = await h.run({ signal: c.signal });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ABORTED');
    expect(r.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
    expect(h.driver.sessions[0]?.closed).toBe(true);
  });

  it('a hung observe while settling: same', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    tweakSessions(h, (s) => {
      s.observe = () => never();
    });
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    const r = await h.run({ signal: c.signal });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ABORTED');
    expect(h.driver.sessions[0]?.closed).toBe(true);
  });

  it('a hung perform inside a step (the actor drives the session): the step ends in error with ABORTED, the rest is skipped', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    let hung = false;
    tweakSessions(h, (s) => {
      const perform = s.perform.bind(s);
      s.perform = (action) => {
        if (action.verb === 'click') {
          hung = true;
          return never();
        }
        return perform(action);
      };
    });
    h.actor.handler = async (_req, session) => {
      await session.perform({ verb: 'click', target: { ref: 'e0' } });
      throw new Error('unreachable: the click never returns');
    };
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    const r = await h.run({ signal: c.signal });
    expect(hung).toBe(true);
    expect(r.steps[0]).toMatchObject({ status: 'error', error: { code: 'ABORTED' } });
    expect(r.steps[1]?.status).toBe('skipped');
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ABORTED');
    expect(h.driver.sessions[0]?.closed).toBe(true);
    expect(r.recording).toBe('discarded');
  });

  it('after the abort the driver is not touched any more (no further observe or perform reaches it)', async () => {
    const h = createHarness({ steps: [when('first'), when('second')] });
    const c = new AbortController();
    h.actor.handler = async (req, session) => {
      c.abort();
      const before = (session as FakeSession).performed.length;
      await expect(session.perform({ verb: 'wait', ms: 1 })).rejects.toMatchObject({ code: 'ABORTED' });
      await expect(session.observe()).rejects.toMatchObject({ code: 'ABORTED' });
      expect((session as FakeSession).performed.length).toBe(before);
      return h.actor.succeed(req, session);
    };
    await h.run({ signal: c.signal });
  });

  it('without a signal sessions are handed to collaborators as they are', async () => {
    const h = createHarness({ steps: [when(ACT)] });
    let seen: unknown;
    h.actor.handler = async (req, session) => {
      seen = session;
      return h.actor.succeed(req, session);
    };
    await h.run();
    expect(seen).toBe(h.driver.sessions[0]);
  });
});
