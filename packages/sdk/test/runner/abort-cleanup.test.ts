import { describe, expect, it } from 'vitest';
import { createHarness, fixtureStep, when } from './doubles/harness.ts';
import { FakeDriver } from './doubles/world.ts';

/** A fixture whose cleanup deletes what it created through the scenario's own session. */
function seededRun(abortDuringRun: boolean) {
  const log: string[] = [];
  const c = new AbortController();
  const seed = {
    name: 'seed',
    description: 'seed a user',
    params: {},
    run: async (_args: unknown, ctx: { session: { request(r: { method: string; path: string }): Promise<unknown> } }) => async () => {
      try {
        await ctx.session.request({ method: 'DELETE', path: '/user/1' });
        log.push('cleanup request ok');
      } catch (err) {
        log.push(`cleanup request failed: ${(err as { code?: string }).code}`);
      }
    },
  };
  const h = createHarness({ steps: [fixtureStep('Seed', 'seed'), when('go')], fixtures: [seed as never] });
  h.driver.openSession = (async (o: Parameters<FakeDriver['openSession']>[0]) => {
    const s = await FakeDriver.prototype.openSession.call(h.driver, o);
    (s as unknown as { request: () => Promise<unknown> }).request = async () => ({ status: 204, body: '' });
    return s;
  }) as FakeDriver['openSession'];
  h.actor.handler = async (req, session) => {
    if (abortDuringRun) c.abort();
    return h.actor.succeed(req, session);
  };
  return { h, c, log };
}

describe('fixture cleanups use the live session while an aborted run is torn down', () => {
  it('without an abort the cleanup request goes through', async () => {
    const { h, c, log } = seededRun(false);
    await h.run({ signal: c.signal });
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log)).toEqual(new Set(['cleanup request ok']));
  });

  it('after an abort the cleanup request still goes through (the created data is removed)', async () => {
    const { h, c, log } = seededRun(true);
    const r = await h.run({ signal: c.signal });
    expect(r.error?.code).toBe('ABORTED');
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log)).toEqual(new Set(['cleanup request ok']));
    expect(h.driver.sessions[0]?.closed).toBe(true);
  });
});
