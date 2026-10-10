// @ts-nocheck
import { describe, expect, it } from 'vitest';
import type { FixtureContext, FixtureDefinition, JsonObject } from '../../src/contracts/index.ts';
import { buildFixtureStub, fixtureNameFor } from '../../src/runner/stub.ts';
import { createHarness, entry, fixtureStep, given, recordingOf, thenStep, when } from './doubles/harness.ts';

function fixture(name: string, run: FixtureDefinition['run']): FixtureDefinition {
  return { name, description: name, params: {}, run };
}

describe('A. fixture steps', () => {
  it('R-FX1: a fixture step runs the registered fixture with its args and a context bound to the session', async () => {
    let seenArgs: JsonObject | undefined;
    let seenCtx: FixtureContext | undefined;
    const seed = fixture('seedAccount', async (args, ctx) => {
      seenArgs = args;
      seenCtx = ctx;
      ctx.log('seeding');
    });
    const h = createHarness({
      steps: [fixtureStep('The account is on the Pro plan with 2 unpaid invoices', 'seedAccount', { plan: 'pro', unpaid: 2 }), thenStep('Billing visible', { nature: 'subjective' })],
      fixtures: [seed],
      config: { characterize: { confirmRuns: 0, probeMs: 500, healThreshold: 2 } },
    });
    const r = await h.run();

    expect(r.steps[0]).toMatchObject({ status: 'passed', path: 'fixture', determinism: 'deterministic', fuzzyReasons: [], usage: { modelCalls: 0 } });
    expect(seenArgs).toEqual({ plan: 'pro', unpaid: 2 });
    expect(seenCtx?.session).toBe(h.driver.sessions[0]);
    expect(seenCtx?.baseURL).toBe('http://localhost:3000');
    expect(seenCtx?.signal.aborted).toBe(false);
    expect(h.events.some((e) => e.type === 'log' && e.message === 'seeding')).toBe(true);
    expect(h.actor.calls).toHaveLength(0);
  });

  it('R-FX1: the fixture ctx.signal is the run signal when one is given', async () => {
    let signal: AbortSignal | undefined;
    const h = createHarness({ steps: [fixtureStep('Seed', 'seedAccount')], fixtures: [fixture('seedAccount', async (_a, ctx) => void (signal = ctx.signal))] });
    const controller = new AbortController();
    await h.run({ signal: controller.signal });
    expect(signal).toBe(controller.signal);
  });

  it('R-FX1: an unknown fixture fails the step with FIXTURE_FAILED and skips the rest', async () => {
    const h = createHarness({ steps: [fixtureStep('Seed', 'missing'), when('go')] });
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(r.steps[0]?.error?.code).toBe('FIXTURE_FAILED');
    expect(r.steps[0]?.path).toBe('fixture');
    expect(r.status).toBe('failed');
  });

  it('R-FX1: a throwing fixture is FIXTURE_FAILED, earlier cleanups still run, later steps are skipped', async () => {
    const log: string[] = [];
    const ok = fixture('ok', async () => async () => void log.push('cleanup ok'));
    const bad = fixture('bad', async () => {
      throw new Error('boom');
    });
    const h = createHarness({ steps: [fixtureStep('First', 'ok'), fixtureStep('Second', 'bad'), when('go')], fixtures: [ok, bad] });
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[1]?.error).toMatchObject({ code: 'FIXTURE_FAILED' });
    expect(r.steps[1]?.error?.message).toContain('boom');
    expect(log).toEqual(['cleanup ok']);
  });

  it('R-FX1: cleanups run in reverse order after the steps, before the session closes, even when a step fails', async () => {
    const log: string[] = [];
    const mk = (name: string) => fixture(name, async () => async () => void log.push(`cleanup ${name}`));
    const h = createHarness({
      steps: [fixtureStep('One', 'a'), fixtureStep('Two', 'b'), fixtureStep('Three', 'c'), when('go')],
      fixtures: [mk('a'), mk('b'), mk('c')],
      driver: { onClose: () => void log.push('close session') },
      config: { characterize: { confirmRuns: 0, probeMs: 0, healThreshold: 2 } },
    });
    h.actor.handler = (req, session) => h.actor.failWith(req, session, 'ACT_BUDGET_EXHAUSTED');
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(log).toEqual(['cleanup c', 'cleanup b', 'cleanup a', 'close session']);
  });

  it('R-FX1: a failing cleanup is logged and does not stop the other cleanups or the close', async () => {
    const log: string[] = [];
    const a = fixture('a', async () => async () => void log.push('cleanup a'));
    const b = fixture('b', async () => async () => {
      throw new Error('cleanup exploded');
    });
    const h = createHarness({
      steps: [fixtureStep('One', 'a'), fixtureStep('Two', 'b')],
      fixtures: [a, b],
      driver: { onClose: () => void log.push('close') },
    });
    const r = await h.run();
    expect(r.status).toBe('passed');
    expect(log[0]).toBe('cleanup a');
    expect(h.events.some((e) => e.type === 'log' && e.level === 'warn' && e.message.includes('cleanup exploded'))).toBe(true);
  });

  it('R-FX1: a given with requiresState AND a fixture runs the fixture instead of blocking', async () => {
    const seed = fixture('seedAccount', async () => undefined);
    const h = createHarness({ steps: [given('Two unpaid invoices exist', { requiresState: true, fixture: { name: 'seedAccount', args: {} } })], fixtures: [seed] });
    const r = await h.run();
    expect(r.steps[0]?.status).toBe('passed');
    expect(r.steps[0]?.path).toBe('fixture');
  });

  it('R-FX1: confirm runs rerun the fixtures in the fresh session and run their cleanups', async () => {
    const calls: string[] = [];
    const seed = fixture('seedAccount', async (_a, ctx) => {
      calls.push(`seed on ${ctx.session.id}`);
      return async () => void calls.push(`cleanup ${ctx.session.id}`);
    });
    const h = createHarness({ steps: [fixtureStep('Seed', 'seedAccount'), when('go'), thenStep('Done')] });
    h.config.fixtures.push(seed);
    h.effectShows('go', 'Done');
    const r = await h.run();
    expect(r.recording).toBe('created');
    expect(calls).toEqual(['seed on fake-1', 'cleanup fake-1', 'seed on fake-2', 'cleanup fake-2']);
  });

  it('R-FX1: fixture steps are recorded with a position in the recording but no act or check', async () => {
    const seed = fixture('seedAccount', async () => undefined);
    const h = createHarness({ steps: [fixtureStep('Seed', 'seedAccount'), when('go'), thenStep('Done')], fixtures: [seed] });
    h.effectShows('go', 'Done');
    await h.run();
    const saved = h.saved;
    expect(saved?.steps).toHaveLength(3);
    expect(saved?.steps[0]).toMatchObject({ determinism: 'deterministic', fuzzyReasons: [] });
    expect(saved?.steps[0]?.act).toBeUndefined();
    expect(saved?.steps[0]?.check).toBeUndefined();
    // and a second run replays the fixture step normally
    const second = await h.run();
    expect(second.mode).toBe('replay');
    expect(second.steps.map((s) => s.path)).toEqual(['fixture', 'replay', 'check']);
  });

  it('R-FX1: the fixture step does not need a recording to run in a replay-mode scenario', async () => {
    const seed = fixture('seedAccount', async () => undefined);
    const h = createHarness({ steps: [fixtureStep('Seed', 'seedAccount'), when('go')], fixtures: [seed] });
    const [f, w] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(f!), entry(w!)]));
    const r = await h.run();
    expect(r.mode).toBe('replay');
    expect(r.steps.map((s) => s.path)).toEqual(['fixture', 'replay']);
  });
});

describe('B. blocked steps (state needed, no fixture)', () => {
  it('R-FX1: a given that requires state without a fixture is blocked with FIXTURE_REQUIRED and a stub', async () => {
    const h = createHarness({
      steps: [
        given('The account has 2 unpaid invoices', { requiresState: true, params: { unpaid: '2' } }),
        when('the user clicks Downgrade to Free'),
        thenStep('An alert warns about unpaid invoices'),
      ],
    });
    const r = await h.run();

    expect(r.status).toBe('blocked');
    expect(r.steps.map((s) => s.status)).toEqual(['blocked', 'skipped', 'skipped']);
    const err = r.steps[0]?.error;
    expect(err?.code).toBe('FIXTURE_REQUIRED');
    const details = err?.details as { stub: string; fixture: string };
    expect(details.fixture).toBe('theAccountHas2UnpaidInvoices');
    expect(details.stub).toContain('export const theAccountHas2UnpaidInvoices: FixtureDefinition = {');
    expect(details.stub).toContain("name: \"theAccountHas2UnpaidInvoices\"");
    expect(details.stub).toContain("unpaid: { type: 'number'");
    expect(r.error?.code).toBe('FIXTURE_REQUIRED');
    expect(r.recording).toBe('none');
    expect(h.actor.calls).toHaveLength(0);
  });

  it('R-FX1: blocked outranks passed and healed but not failed in the scenario status', async () => {
    const h = createHarness({ steps: [when('go'), given('Needs data', { requiresState: true })] });
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'blocked']);
    expect(r.status).toBe('blocked');
  });
});

describe('fixture stub text', () => {
  it('R-FX1: names are camelCased step text of at most 40 characters', () => {
    expect(fixtureNameFor('The account has 2 unpaid invoices')).toBe('theAccountHas2UnpaidInvoices');
    expect(fixtureNameFor('a'.repeat(100)).length).toBe(40);
    expect(fixtureNameFor('Given a very long description of the precondition that is needed here').length).toBeLessThanOrEqual(40);
  });

  it('R-FX1: names are always valid identifiers', () => {
    expect(fixtureNameFor('2 invoices')).toBe('f2Invoices');
    expect(fixtureNameFor('???')).toBe('fixture');
    expect(fixtureNameFor('Überweisung öffnen')).toBe('uberweisungOffnen');
  });

  it('R-FX1: params come from step.params and types are inferred', () => {
    const { stub } = buildFixtureStub({ text: 'x', params: { count: '3', flag: 'true', who: 'bob', 'odd-key': 'v' } });
    expect(stub).toContain("count: { type: 'number'");
    expect(stub).toContain("flag: { type: 'boolean'");
    expect(stub).toContain("who: { type: 'string'");
    expect(stub).toContain('"odd-key": { type: \'string\'');
  });

  it('R-FX1: a stub without params has an empty params object and mentions the step text safely quoted', () => {
    const { stub } = buildFixtureStub({ text: 'He said "hi"', params: {} });
    expect(stub).toContain('params: {},');
    expect(stub).toContain(JSON.stringify('He said "hi"'));
  });
});
