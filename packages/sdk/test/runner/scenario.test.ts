import { describe, expect, it } from 'vitest';
import { AiBddError, type RunEvent } from '../../src/contracts/index.ts';
import { createRunner } from '../../src/runner/index.ts';
import { aggregateStatus } from '../../src/runner/support.ts';
import { createHarness, entry, mkTarget, recordingOf, thenStep, when } from './doubles/harness.ts';
import { FakeDriver, type FakeSession } from './doubles/world.ts';

const GO = 'the user clicks Upgrade to Pro';
const SEES = 'Plan: Pro';

describe('status precedence', () => {
  it('R-CH5: error > failed > inconclusive > blocked > healed > passed > skipped', () => {
    const order = ['error', 'failed', 'inconclusive', 'blocked', 'healed', 'passed', 'skipped'] as const;
    for (let i = 0; i < order.length; i++) {
      for (let j = i; j < order.length; j++) {
        const hi = order[i]!;
        const lo = order[j]!;
        expect(aggregateStatus([lo, hi, lo])).toBe(hi);
        expect(aggregateStatus([hi, lo])).toBe(hi);
      }
    }
  });

  it('R-CH5: all-skipped and empty scenarios are skipped', () => {
    expect(aggregateStatus(['skipped', 'skipped'])).toBe('skipped');
    expect(aggregateStatus([])).toBe('skipped');
  });

  it('R-CH5: an inconclusive step outranks a later healed one in the scenario status', async () => {
    const h = createHarness({ steps: [thenStep('Fuzzy fact', { nature: 'subjective' }), when(GO)] });
    h.judge.verdictFor = () => 'inconclusive';
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['inconclusive', 'passed']);
    expect(r.status).toBe('inconclusive');
  });
});

describe('skipped after failure, events and bookkeeping', () => {
  it('R-CH1: after a failed step every remaining step is skipped with path none and no model calls', async () => {
    const h = createHarness({ steps: [when('first'), when('second'), thenStep('third')] });
    h.actor.handler = (req, session, n) => (n === 1 ? h.actor.succeed(req, session) : h.actor.failWith(req, session, 'ACT_TARGET_AMBIGUOUS'));
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[2]).toMatchObject({ path: 'none', determinism: 'n/a', actions: 0, usage: { modelCalls: 0 } });
    expect(r.status).toBe('failed');
    expect(h.judge.requests).toHaveLength(0);
  });

  it('R-CH1: emits scenario-start, then step-start/step-end per step in order, then scenario-end', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    const r = await h.run();
    const seq = h.events.filter((e) => e.type !== 'log').map((e) => (e.type === 'step-start' || e.type === 'step-end' ? `${e.type}:${e.type === 'step-end' ? e.result.stepKey : e.stepKey}` : e.type));
    const keys = h.target.scenario.steps.map((s) => s.key);
    expect(seq).toEqual(['scenario-start', `step-start:${keys[0]}`, `step-end:${keys[0]}`, `step-start:${keys[1]}`, `step-end:${keys[1]}`, 'scenario-end']);
    const start = h.events[0] as Extract<RunEvent, { type: 'scenario-start' }>;
    expect(start).toMatchObject({ scenarioId: h.target.scenario.id, driver: 'fake', mode: 'characterize' });
    const end = h.events.at(-1) as Extract<RunEvent, { type: 'scenario-end' }>;
    expect(end.result).toBe(r);
    const stepEnd = h.events.find((e) => e.type === 'step-end') as Extract<RunEvent, { type: 'step-end' }>;
    expect(stepEnd.result).toBe(r.steps[0]);
  });

  it('R-CH1: skipped steps also get step events, and confirm-run steps get none', async () => {
    const h = createHarness({ steps: [when('first'), when('second')] });
    h.actor.handler = (req, session) => h.actor.failWith(req, session, 'ACT_BUDGET_EXHAUSTED');
    await h.run();
    expect(h.events.filter((e) => e.type === 'step-end')).toHaveLength(2);

    const ok = createHarness({ steps: [when(GO), thenStep(SEES)] });
    ok.effectShows(GO, SEES);
    await ok.run();
    expect(ok.events.filter((e) => e.type === 'step-end')).toHaveLength(2); // despite the confirm run
  });

  it('R-CH1: a throwing event listener never breaks the run', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    h.deps.emit = () => {
      throw new Error('listener bug');
    };
    const r = await createRunner(h.deps).runScenario(h.target, { updateRecordings: false, strict: false, noAgent: false, audit: false });
    expect(r.status).toBe('passed');
  });

  it('R-CH1: StepResult.sources is the step sources and the result carries plan identity', async () => {
    const h = createHarness({ steps: [when(GO)] });
    const r = await h.run();
    expect(r.steps[0]?.sources).toBe(h.target.scenario.steps[0]?.sources);
    expect(r).toMatchObject({ scenarioId: h.target.scenario.id, featureId: h.target.feature.id, docUri: 'billing.md', title: 'Upgrade to Pro', review: 'accepted', driver: 'fake' });
  });

  it('R-RN1: durationMs comes from the injected clock', async () => {
    const h = createHarness({ steps: [when(GO)], config: { characterize: { confirmRuns: 0, probeMs: 500, healThreshold: 2 } } });
    const r = await h.run();
    expect(r.steps[0]?.durationMs).toBe(500); // the probe wait is the only time that passes
    expect(r.durationMs).toBe(500);
  });

  it('R-CH1: usage aggregates step usage (actor, judge, checkgen) into the scenario', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)], config: { characterize: { confirmRuns: 0, probeMs: 0, healThreshold: 2 } } });
    h.effectShows(GO, SEES);
    const r = await h.run();
    expect(r.usage).toEqual({ modelCalls: 5, inputTokens: 10 + 30 + 5, outputTokens: 5 + 15 + 5 });
  });

  it('R-RN1: settled observations are reused instead of re-observing needlessly', async () => {
    const h = createHarness({ steps: [when(GO), thenStep('One'), thenStep('Two'), thenStep('Three')] });
    h.effect(GO, (w) => ['One', 'Two', 'Three'].forEach((n) => w.add({ role: 'status', name: n })));
    const steps = h.target.scenario.steps;
    h.seed(recordingOf(h.target, steps.map((s) => entry(s))));
    const r = await h.run();
    expect(r.status).toBe('passed');
    // initial observation + one settle for the first then step; the next two reuse it
    expect(h.settler.calls).toHaveLength(2);
  });
});

describe('session setup (§9.2)', () => {
  it('R-AG3: an unknown driver is CONFIG_INVALID, no session opens, steps are skipped', async () => {
    const h = createHarness({ steps: [when(GO)], scenario: { driver: 'nope' } });
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('CONFIG_INVALID');
    expect(r.steps.map((s) => s.status)).toEqual(['skipped']);
    expect(h.driver.sessions).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual(['scenario-start', 'step-start', 'step-end', 'scenario-end']);
  });

  it('R-AG3: the driver is scenario.driver, then the CLI driver option, then config.defaultDriver', async () => {
    const h = createHarness({ steps: [when(GO)], config: { defaultDriver: 'fake' }, scenario: { driver: 'second' } });
    const second = new FakeDriver({ id: 'second' });
    const third = new FakeDriver({ id: 'third' });
    (h.deps.drivers as Map<string, FakeDriver>).set('second', second);
    (h.deps.drivers as Map<string, FakeDriver>).set('third', third);
    const r1 = await h.run({ driver: 'third' });
    expect(r1.driver).toBe('second'); // scenario.driver wins over the CLI option
    expect(second.sessions.length).toBeGreaterThanOrEqual(1);
    expect(third.sessions).toHaveLength(0);

    const h2 = createHarness({ steps: [when(GO)] });
    (h2.deps.drivers as Map<string, FakeDriver>).set('third', third);
    const r2 = await h2.run({ driver: 'third' });
    expect(r2.driver).toBe('third');
    expect(h2.driver.sessions).toHaveLength(0);
    const r3 = await h2.run();
    expect(r3.driver).toBe('fake');
  });

  it('R-AG3: no driver selected and no default is CONFIG_INVALID', async () => {
    const h = createHarness({ steps: [when(GO)], config: { defaultDriver: undefined as unknown as string } });
    const r = await h.run();
    expect(r.error?.code).toBe('CONFIG_INVALID');
  });

  it('R-AG3: the session is opened with scenarioId, baseURL, policy and a resolveValue', async () => {
    const h = createHarness({ steps: [when(GO)], config: { baseURL: 'http://localhost:4173' } });
    await h.run();
    const opts = h.driver.sessions[0]!.options;
    expect(opts.scenarioId).toBe(h.target.scenario.id);
    expect(opts.baseURL).toBe('http://localhost:4173');
    expect(opts.policy).toBe(h.config.policy);
    expect(opts.resolveValue({ literal: 'x' })).toBe('x');
  });

  it('R-AG3: navigates to baseURL at the start, through the policy check, then takes the first observation', async () => {
    const h = createHarness({ steps: [when(GO)], config: { baseURL: 'http://localhost:4173' } });
    await h.run();
    expect(h.driver.sessions[0]!.performed[0]).toEqual({ verb: 'navigate', url: 'http://localhost:4173/' });
  });

  it('R-AG3: scenario.startUrl is resolved against baseURL', async () => {
    const h = createHarness({ steps: [when(GO)], scenario: { startUrl: '/settings/billing' } });
    await h.run();
    expect(h.driver.sessions[0]!.performed[0]).toEqual({ verb: 'navigate', url: 'http://localhost:3000/settings/billing' });
    expect(h.driver.sessions[0]!.world.route).toBe('/settings/billing');
  });

  it('R-AG3: a start URL outside allowHosts is POLICY_DENIED; the session closes and nothing runs', async () => {
    const h = createHarness({ steps: [when(GO)], scenario: { startUrl: 'http://evil.example/steal' } });
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('POLICY_DENIED');
    expect(h.driver.sessions[0]?.closed).toBe(true);
    expect(h.actor.calls).toHaveLength(0);
    expect(r.steps.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('R-AG3: javascript:, data: and credential URLs as start URLs are denied', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'http://user:pw@localhost/']) {
      const h = createHarness({ steps: [when(GO)], scenario: { startUrl: url } });
      const r = await h.run();
      expect(r.error?.code).toBe('POLICY_DENIED');
    }
  });

  it('R-AG3: no navigation when neither startUrl nor baseURL is set, or the driver lacks navigate', async () => {
    const none = createHarness({ steps: [when(GO)], config: { baseURL: undefined as unknown as string } });
    await none.run();
    expect(none.driver.sessions[0]!.performed).toEqual([]);

    const noNav = createHarness({ steps: [when(GO)], driver: { verbs: ['click'] } });
    await noNav.run();
    expect(noNav.driver.sessions[0]!.performed).toEqual([]);
  });

  it('R-AG3: a failed start navigation is an error with the driver error code', async () => {
    const h = createHarness({ steps: [when(GO)] });
    h.driver.openSession = (async (o: Parameters<FakeDriver['openSession']>[0]) => {
      const s = await FakeDriver.prototype.openSession.call(h.driver, o);
      s.performHook = () => ({ ok: false, error: { code: 'DRIVER_UNAVAILABLE', message: 'page crashed', retryable: true } });
      return s;
    }) as FakeDriver['openSession'];
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('DRIVER_UNAVAILABLE');
    expect(r.error?.retryable).toBe(true);
  });

  it('R-AG3: an openSession failure becomes an error result without throwing', async () => {
    const h = createHarness({ steps: [when(GO)] });
    h.driver.openSession = () => Promise.reject(new AiBddError('SESSION_LIMIT', 'too many sessions'));
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SESSION_LIMIT');
  });

  it('R-SDK3: sessionFactory replaces driver.openSession, receives the engine-built SessionOptions, and the session is closed', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)], scenario: { driver: 'unregistered' } });
    h.effectShows(GO, SEES);
    const external = new FakeDriver({ id: 'pw', version: '3.1.0' });
    const opened: FakeSession[] = [];
    const sessionFactory = async (o: Parameters<FakeDriver['openSession']>[0]) => {
      const s = await external.openSession(o);
      s.world.specs = [{ role: 'heading', name: 'Billing', level: 1 }];
      s.world.on(GO, (w) => w.add({ role: 'status', name: SEES }));
      opened.push(s);
      return s;
    };
    const r = await h.run({ sessionFactory });
    expect(r.status).toBe('passed');
    expect(r.driver).toBe('pw');
    expect(h.driver.sessions).toHaveLength(0);
    expect(opened.length).toBeGreaterThanOrEqual(1);
    expect(opened.every((s) => s.closed)).toBe(true);
    expect(opened[0]!.options.scenarioId).toBe(h.target.scenario.id);
    // the adopted session's driverId selects the recordings directory
    expect(h.store.read('pw', h.target.scenario.id)).not.toBeNull();
    expect(h.store.read('fake', h.target.scenario.id)).toBeNull();
  });

});

describe('secrets and redaction (R-SE1)', () => {
  it('R-SE1: resolveValue maps {param} to the current step param and {secret} to the env value', async () => {
    const h = createHarness({
      steps: [when('fill the form', { params: { email: 'a@acme.test' } })],
      secrets: { adminPassword: 'correct-horse-battery' },
    });
    const seen: string[] = [];
    h.actor.handler = async (req, session) => {
      const resolve = (session as FakeSession).options.resolveValue;
      seen.push(resolve({ param: 'email' }), resolve({ secret: 'adminPassword' }), resolve({ literal: 'lit' }));
      return h.actor.succeed(req, session);
    };
    await h.run();
    expect(seen).toEqual(['a@acme.test', 'correct-horse-battery', 'lit']);
  });

  it('R-SE1: a missing secret makes the step an error with SECRET_MISSING, even if the actor swallows it', async () => {
    const h = createHarness({ steps: [when('sign in'), when('next')] });
    h.config.secrets.adminPassword = { env: 'ACME_ADMIN_PASSWORD' };
    h.actor.handler = async (req, session) => {
      try {
        (session as FakeSession).options.resolveValue({ secret: 'adminPassword' });
      } catch {
        // an actor that swallows the exception and reports an ordinary failure
      }
      return h.actor.failWith(req, session, 'ACT_BUDGET_EXHAUSTED');
    };
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['error', 'skipped']);
    expect(r.steps[0]?.error?.code).toBe('SECRET_MISSING');
    expect(r.steps[0]?.error?.message).toContain('ACME_ADMIN_PASSWORD');
    expect(r.status).toBe('error');
  });

  it('R-SE1: secret values never appear in error messages or details in results', async () => {
    const secret = 'correct-horse-battery';
    const h = createHarness({ steps: [when('sign in')], secrets: { adminPassword: secret } });
    h.actor.handler = async (_req, session) => {
      const obs = await session.observe();
      return {
        status: 'failed',
        error: { code: 'MODEL_OUTPUT_INVALID', message: `typed ${secret} and got ${encodeURIComponent(secret)}`, retryable: false, details: { echoed: secret } },
        actions: [],
        finalObservation: obs,
        summary: secret,
        usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 },
      };
    };
    const r = await h.run();
    const text = JSON.stringify(r);
    expect(text).not.toContain(secret);
    expect(text).toContain('<secret:adminPassword>');
  });

  it('R-SE1: a thrown non-AiBddError becomes an INTERNAL step error with a redacted message', async () => {
    const secret = 'correct-horse-battery';
    const h = createHarness({ steps: [when('sign in'), when('next')], secrets: { adminPassword: secret } });
    h.actor.handler = () => {
      throw new Error(`crash while typing ${secret}`);
    };
    const r = await h.run();
    expect(r.steps[0]).toMatchObject({ status: 'error' });
    expect(r.steps[0]?.error?.code).toBe('INTERNAL');
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.steps[1]?.status).toBe('skipped');
  });

  it('R-SE1: a model error from the judge is an error step carrying the error code', async () => {
    const h = createHarness({ steps: [thenStep('Fact', { nature: 'subjective' })] });
    h.judge.judge = () => Promise.reject(new AiBddError('MODEL_UNAVAILABLE', 'rate limited'));
    const r = await h.run();
    expect(r.steps[0]?.status).toBe('error');
    expect(r.steps[0]?.error).toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
    expect(r.status).toBe('error');
  });
});

describe('abort', () => {
  it('R-RN3: a signal aborted before the scenario starts gives an ABORTED error and opens no session', async () => {
    const h = createHarness({ steps: [when(GO)] });
    const c = new AbortController();
    c.abort();
    const r = await h.run({ signal: c.signal });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ABORTED');
    expect(h.driver.sessions).toHaveLength(0);
  });

  it('R-RN3: aborting mid-run skips the remaining steps, reports ABORTED and still tears the session down', async () => {
    const h = createHarness({ steps: [when('first'), when('second'), when('third')] });
    const c = new AbortController();
    h.actor.handler = async (req, session) => {
      c.abort();
      return h.actor.succeed(req, session);
    };
    const r = await h.run({ signal: c.signal });
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'skipped', 'skipped']);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ABORTED');
    expect(h.driver.sessions[0]?.closed).toBe(true);
    expect(r.recording).toBe('discarded');
  });
});

describe('recordings errors and modes', () => {
  it('R-CH6: -u in read-only mode is RECORDING_READ_ONLY and nothing runs', async () => {
    const h = createHarness({ steps: [when(GO)], recordingsMode: 'read-only' });
    const r = await h.run({ updateRecordings: true });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('RECORDING_READ_ONLY');
    expect(h.driver.sessions).toHaveLength(0);
    expect(r.steps.map((s) => s.status)).toEqual(['skipped']);
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH6: a read-only run with no recording characterizes but never writes or confirms', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)], recordingsMode: 'read-only' });
    h.effectShows(GO, SEES);
    const r = await h.run();
    expect(r.status).toBe('passed');
    expect(r.mode).toBe('characterize');
    expect(r.recording).toBe('discarded');
    expect(r.confirm).toBeUndefined();
    expect(h.driver.sessions).toHaveLength(1);
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH6: a read-only run replays existing recordings and reports recording none', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)], recordingsMode: 'read-only' });
    h.effectShows(GO, SEES);
    h.seed(recordingOf(h.target, h.target.scenario.steps.map((s) => entry(s))));
    const r = await h.run();
    expect(r.mode).toBe('replay');
    expect(r.recording).toBe('none');
    expect(r.status).toBe('passed');
  });

  it('R-CH6: off mode never loads a usable recording and never saves', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)], recordingsMode: 'off' });
    h.effectShows(GO, SEES);
    h.seed(recordingOf(h.target, h.target.scenario.steps.map((s) => entry(s))));
    const r = await h.run();
    expect(r.mode).toBe('characterize');
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH6: a store that refuses to save (RECORDING_READ_ONLY) discards the recording without failing the scenario', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    h.store.save = () => Promise.reject(new AiBddError('RECORDING_READ_ONLY', 'read-only store'));
    const r = await h.run();
    expect(r.status).toBe('passed');
    expect(r.recording).toBe('discarded');
  });

  it('R-CH6: any other save failure is an error and the recording is discarded', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    h.store.save = () => Promise.reject(new Error('disk full'));
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.recording).toBe('discarded');
    expect(r.error?.code).toBe('INTERNAL');
  });

  it('R-CH4: a corrupt recording is an error, but -u bypasses loading it', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    h.store.load = () => Promise.reject(new AiBddError('RECORDING_CORRUPT', 'bad json'));
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('RECORDING_CORRUPT');
    expect(h.driver.sessions[0]?.closed).toBe(true);
    const u = await h.run({ updateRecordings: true });
    expect(u.status).toBe('passed');
  });

  it('R-CH2: an infrastructure failure while opening the confirm session is an error, not instability', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    const original = h.driver.openSession.bind(h.driver);
    let n = 0;
    h.driver.openSession = (o) => (++n === 2 ? Promise.reject(new AiBddError('DRIVER_UNAVAILABLE', 'browser died')) : original(o));
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('DRIVER_UNAVAILABLE');
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-PL4: the saved recording carries prompt versions, fingerprint and driver major', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)], driver: { version: '4.2.0' } });
    h.effectShows(GO, SEES);
    await h.run();
    expect(h.store.read('fake', h.target.scenario.id)).toMatchObject({
      schemaVersion: 1,
      scenarioId: h.target.scenario.id,
      scenarioFingerprint: h.target.scenario.fingerprint,
      driver: { id: 'fake', major: 4 },
      promptVersions: { act: 'act-v1', checkgen: 'checkgen-v1', judge: 'judge-v1' },
    });
  });

  it('R-CH1: a scenario with no steps is skipped and records nothing', async () => {
    const h = createHarness({ steps: [] });
    const r = await h.run();
    expect(r.status).toBe('skipped');
    expect(r.steps).toEqual([]);
    expect(r.recording).toBe('none');
    expect(r.mode).toBe('replay');
    expect(mkTarget([]).scenario.steps).toEqual([]);
  });

  it('R-SE1: a {param} the step does not define is an error step, not a silent empty string', async () => {
    const h = createHarness({ steps: [when('fill the form')] });
    h.actor.handler = async (req, session) => {
      (session as FakeSession).options.resolveValue({ param: 'missing' });
      return h.actor.succeed(req, session);
    };
    const r = await h.run();
    expect(r.steps[0]?.status).toBe('error');
    expect(r.steps[0]?.error?.code).toBe('INTERNAL');
    expect(r.steps[0]?.error?.message).toContain('missing');
  });

  it('R-RN3: aborting before a confirm run is an infrastructure error and the recording is discarded', async () => {
    const h = createHarness({ steps: [when(GO), thenStep(SEES)] });
    h.effectShows(GO, SEES);
    const c = new AbortController();
    h.judge.verdictFor = () => {
      c.abort(); // the signal fires while the last main step runs
      return 'pass';
    };
    const r = await h.run({ signal: c.signal });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ABORTED');
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
  });
});
