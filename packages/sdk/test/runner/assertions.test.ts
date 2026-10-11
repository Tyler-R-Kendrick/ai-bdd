import { describe, expect, it } from 'vitest';
import { existsProgram } from './doubles/collaborators.ts';
import { createHarness, entry, fixtureStep, fuzzyEntry, recordingOf, thenStep, when, type Harness } from './doubles/harness.ts';

const ACT = 'the user clicks Upgrade to Pro';
const CHECK = 'Plan: Pro';

function seeded(h: Harness, over?: (e: ReturnType<typeof entry>[]) => void): void {
  const entries = h.target.scenario.steps.map((s) => entry(s));
  over?.(entries);
  h.seed(recordingOf(h.target, entries));
}

describe('D1 deterministic checks', () => {
  it('R-AS4: a failing recorded check is CHECK_FAILED with per-predicate actuals and zero judge calls', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effect(ACT, () => undefined); // the bug: nothing happens
    seeded(h);
    const r = await h.run();

    expect(r.status).toBe('failed');
    expect(r.steps[1]).toMatchObject({ status: 'failed', path: 'check', determinism: 'deterministic' });
    expect(r.steps[1]?.error?.code).toBe('CHECK_FAILED');
    expect(r.steps[1]?.error?.details).toMatchObject({ predicates: [{ satisfied: false, actual: 0, predicate: { op: 'exists' } }] });
    expect(r.steps[1]?.check?.passed).toBe(false);
    expect(h.judge.requests).toHaveLength(0);
    expect(r.error?.code).toBe('CHECK_FAILED');
  });

  it('R-AS4: --audit runs the judge too; agreement keeps the check result and the path becomes check+judge', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    const r = await h.run({ audit: true });
    expect(r.status).toBe('passed');
    expect(r.steps[1]).toMatchObject({ path: 'check+judge' });
    expect(r.steps[1]?.judge?.verdict).toBe('pass');
    expect(h.judge.requests).toHaveLength(1);
  });

  it('R-AS4: --audit: check passes but the judge fails is CHECK_JUDGE_DISAGREEMENT', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    h.judge.verdictFor = () => 'fail';
    const r = await h.run({ audit: true });
    expect(r.status).toBe('failed');
    expect(r.steps[1]).toMatchObject({ status: 'failed', path: 'check+judge' });
    expect(r.steps[1]?.error?.code).toBe('CHECK_JUDGE_DISAGREEMENT');
  });

  it('R-AS4: --audit: check fails but the judge passes is CHECK_JUDGE_DISAGREEMENT', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effect(ACT, () => undefined);
    seeded(h);
    const r = await h.run({ audit: true });
    expect(r.steps[1]?.error?.code).toBe('CHECK_JUDGE_DISAGREEMENT');
    expect(r.steps[1]?.path).toBe('check+judge');
  });

  it('R-AS4: --audit: check and judge both failing stays CHECK_FAILED', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effect(ACT, () => undefined);
    seeded(h);
    h.judge.verdictFor = () => 'fail';
    const r = await h.run({ audit: true });
    expect(r.steps[1]?.error?.code).toBe('CHECK_FAILED');
    expect(r.steps[1]?.path).toBe('check+judge');
  });

  it('R-AS4: --audit: an inconclusive judge is not a disagreement', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    h.judge.verdictFor = () => 'inconclusive';
    const r = await h.run({ audit: true });
    expect(r.steps[1]?.status).toBe('passed');
  });

  it('R-AS4: without --audit the judge is never called for a deterministic check, even when the check fails', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    await h.run();
    expect(h.judge.requests).toHaveLength(0);
  });
});

describe('D2 fuzzy and subjective criteria', () => {
  it('R-JU2: a fuzzy recorded check is judged every run; fail maps to JUDGE_FAILED', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    h.seed(recordingOf(h.target, [entry(h.target.scenario.steps[0]!), fuzzyEntry(h.target.scenario.steps[1]!, ['volatile-content'])]));
    h.judge.verdictFor = () => 'fail';
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ status: 'failed', path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['volatile-content'] });
    expect(r.steps[1]?.error?.code).toBe('JUDGE_FAILED');
    expect(h.asserter.evaluations).toHaveLength(0);
    expect(h.asserter.generations).toHaveLength(0);
  });

  it('R-JU2: an inconclusive judge makes the step and scenario inconclusive and later steps still run', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK, { nature: 'subjective' }), thenStep('Another visible fact')] });
    h.effect(ACT, (w) => {
      w.add({ role: 'status', name: CHECK });
      w.add({ role: 'status', name: 'Another visible fact' });
    });
    h.judge.verdictFor = (req) => (req.criterion === CHECK ? 'inconclusive' : 'pass');
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'inconclusive', 'passed']);
    expect(r.steps[1]?.error?.code).toBe('JUDGE_INCONCLUSIVE');
    expect(r.status).toBe('inconclusive');
    expect(r.error?.code).toBe('JUDGE_INCONCLUSIVE');
    expect(r.recording).toBe('discarded');
  });
});

describe('window rule (§9.6)', () => {
  const subjective = (text: string) => thenStep(text, { nature: 'subjective' });

  it('R-RN1: before is the observation ahead of the contiguous action run; both then steps see the same before', async () => {
    const h = createHarness({ steps: [when('do first'), when('do second'), subjective('check one'), subjective('check two')] });
    h.effect('do first', (w) => w.add({ role: 'status', name: 'after-first' }));
    h.effect('do second', (w) => w.add({ role: 'status', name: 'after-second' }));
    await h.run({ updateRecordings: true });
    const [one, two] = h.judge.requests;
    for (const req of [one!, two!]) {
      expect(req.actionPreceded).toBe(true);
      expect(req.before.treeText).not.toContain('after-first');
      expect(req.after.treeText).toContain('after-first');
      expect(req.after.treeText).toContain('after-second');
    }
  });

  it('R-RN1: a then step between actions breaks the run; the next then step starts from the later run', async () => {
    const h = createHarness({ steps: [when('do first'), subjective('check one'), when('do second'), subjective('check two')] });
    h.effect('do first', (w) => w.add({ role: 'status', name: 'after-first' }));
    h.effect('do second', (w) => w.add({ role: 'status', name: 'after-second' }));
    await h.run({ updateRecordings: true });
    const [one, two] = h.judge.requests;
    expect(one!.before.treeText).not.toContain('after-first');
    expect(two!.before.treeText).toContain('after-first');
    expect(two!.before.treeText).not.toContain('after-second');
    expect(two!.after.treeText).toContain('after-second');
  });

  it('R-RN1: fixture steps neither break nor start an action run', async () => {
    const seed = { name: 'seedAccount', description: 'd', params: {}, run: async () => undefined };
    const h = createHarness({
      steps: [when('do first'), fixtureStep('Seed the account', 'seedAccount'), when('do second'), subjective('check one')],
      fixtures: [seed],
    });
    h.effect('do first', (w) => w.add({ role: 'status', name: 'after-first' }));
    h.effect('do second', (w) => w.add({ role: 'status', name: 'after-second' }));
    await h.run({ updateRecordings: true });
    const req = h.judge.requests[0]!;
    expect(req.before.treeText).not.toContain('after-first');
    expect(req.after.treeText).toContain('after-second');
  });

  it('R-RN1: with no action before the check, before is the first observation and actionPreceded is false', async () => {
    const h = createHarness({ steps: [thenStep('Billing heading is visible')], initialPage: [{ role: 'heading', name: 'Billing', level: 1 }, { role: 'status', name: 'Billing heading is visible' }] });
    await h.run();
    const req = h.judge.requests[0]!;
    expect(req.actionPreceded).toBe(false);
    expect(req.before.treeText).toBe(req.after.treeText);
    expect(h.asserter.generations[0]?.actionPreceded).toBe(false);
    expect(h.asserter.generations[0]?.before.treeHash).toBe(h.asserter.generations[0]?.after.treeHash);
  });

  it('R-RN1: a then step after only fixtures (no UI action) has actionPreceded false', async () => {
    const seed = { name: 'seedAccount', description: 'd', params: {}, run: async () => undefined };
    const h = createHarness({
      steps: [fixtureStep('Seed the account', 'seedAccount'), thenStep('Billing heading is visible')],
      fixtures: [seed],
      initialPage: [{ role: 'status', name: 'Billing heading is visible' }],
    });
    await h.run();
    expect(h.judge.requests[0]?.actionPreceded).toBe(false);
  });
});

describe('settling before checks (R-RN1)', () => {
  it('R-RN1: an unsettled screen fails with SCREEN_NOT_SETTLED and is never judged, checked or generated', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    h.settler.settledWhen = (obs) => !obs.nodes.some((n) => n.name === CHECK); // settles only before the effect shows
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.steps[1]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(h.judge.requests).toHaveLength(0);
    expect(h.asserter.generations).toHaveLength(0);
    expect(r.recording).toBe('discarded');
  });

  it('R-RN1: an unsettled screen also stops a deterministic check from evaluating', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    h.settler.settledWhen = (obs) => !obs.nodes.some((n) => n.name === CHECK);
    const r = await h.run();
    expect(r.steps[1]?.error?.code).toBe('SCREEN_NOT_SETTLED');
    expect(h.asserter.evaluations).toHaveLength(0);
  });

  it('R-RN1: settle.requireSettled=false lets an unsettled screen be judged', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)], config: { settle: { quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: false } } });
    h.effectShows(ACT, CHECK);
    h.settler.settledWhen = () => false;
    const r = await h.run();
    expect(r.steps[1]?.status).toBe('passed');
  });

  it('R-RN1: settle options from config reach the settler', async () => {
    const h = createHarness({ steps: [thenStep('x', { nature: 'subjective' })], config: { settle: { quietMs: 11, intervalMs: 22, timeoutMs: 33, requireSettled: true } } });
    let seen: unknown;
    const original = h.settler.settle.bind(h.settler);
    h.settler.settle = (session, opts, extra) => {
      seen = opts;
      return original(session, opts, extra);
    };
    await h.run();
    expect(seen).toEqual({ quietMs: 11, intervalMs: 22, timeoutMs: 33 });
  });
});

describe('judge input (R-JU1, R-JU3)', () => {
  it('R-JU1: the judge request has exactly the allowed keys and never carries agent output', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    h.actor.handler = async (req, session, _n, w) => {
      w.apply(req.step.text);
      const obs = await session.observe();
      return {
        status: 'done',
        actions: [{ action: { verb: 'click', target: { ref: 'e0' } }, chosenFrom: obs, outcome: { ok: true } }],
        finalObservation: obs,
        summary: 'CANARY-7f3a agent says the plan is Pro',
        usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 },
        transcript: { sha256: 'a'.repeat(64), path: 'artifacts/t.txt', kind: 'act-transcript', bytes: 10 },
      };
    };
    await h.run();
    const req = h.judge.requests[0]!;
    expect(Object.keys(req).sort()).toEqual(['actionPreceded', 'after', 'appContext', 'before', 'criterion', 'params']);
    expect(JSON.stringify(req)).not.toContain('CANARY-7f3a');
    expect(req.criterion).toBe(CHECK);
    expect(req.appContext).toBe('Acme billing app');
  });

  it('R-JU1: tree text sent to the judge has no refs and is redacted', async () => {
    const h = createHarness({
      steps: [thenStep('Token is shown', { nature: 'subjective' })],
      secrets: { adminPassword: 'correct-horse-battery' },
      initialPage: [{ role: 'status', name: 'Token is correct-horse-battery' }],
    });
    await h.run();
    const text = h.judge.requests[0]!.after.treeText;
    expect(text).not.toContain('[ref=');
    expect(text).not.toContain('correct-horse-battery');
    expect(text).toContain('<secret:adminPassword>');
  });

  it('R-JU1: tree text is truncated to judge.maxTreeChars', async () => {
    const h = createHarness({
      steps: [thenStep('A long page', { nature: 'subjective' })],
      config: { judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 40 } },
      initialPage: Array.from({ length: 30 }, (_, i) => ({ role: 'paragraph', name: `row number ${i}` })),
    });
    await h.run();
    const text = h.judge.requests[0]!.after.treeText;
    expect(text.length).toBe(40);
    expect(text.endsWith('...[truncated]')).toBe(true);
  });

  it('R-JU3: an untainted screenshot reaches the judge when vision is on, and pixels are requested from the settler', async () => {
    const h = createHarness({ steps: [thenStep('Anything', { nature: 'subjective' })] });
    await h.run();
    expect(h.judge.requests[0]!.after.screenshot).toBeDefined();
    expect(h.settler.calls.some((c) => c.pixels)).toBe(true);
  });

  it('R-JU3: judge.vision=false never sends a screenshot nor requests pixels', async () => {
    const h = createHarness({
      steps: [thenStep('Anything', { nature: 'subjective' })],
      config: { judge: { passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: false, maxTreeChars: 20000 } },
    });
    await h.run();
    expect(h.judge.requests[0]!.after.screenshot).toBeUndefined();
    expect(h.settler.calls.every((c) => !c.pixels)).toBe(true);
  });

  it('R-JU3: a driver without pixels never gets a pixel request', async () => {
    const h = createHarness({ steps: [thenStep('Anything', { nature: 'subjective' })], driver: { pixels: false } });
    await h.run();
    expect(h.settler.calls.every((c) => !c.pixels)).toBe(true);
    expect(h.judge.requests[0]!.after.screenshot).toBeUndefined();
  });

  it('R-JU3: a tainted unmasked screenshot is withheld from the judge (R-SE2)', async () => {
    const h = createHarness({ steps: [thenStep('Signed in', { nature: 'subjective' })], initialPage: [{ role: 'heading', name: 'Signed in' }] });
    const original = h.driver.openSession.bind(h.driver);
    h.driver.openSession = async (o) => {
      const s = await original(o);
      s.world.tainted = true;
      return s;
    };
    await h.run();
    expect(h.judge.requests[0]!.after.screenshot).toBeUndefined();
  });

  it('R-JU3: a tainted screenshot that is masked on a driver proving masking is allowed', async () => {
    const h = createHarness({ steps: [thenStep('Signed in', { nature: 'subjective' })], driver: { maskingProven: true } });
    const original = h.driver.openSession.bind(h.driver);
    h.driver.openSession = async (o) => {
      const s = await original(o);
      s.world.tainted = true;
      s.world.masked = true;
      return s;
    };
    await h.run();
    expect(h.judge.requests[0]!.after.screenshot).toBeDefined();
  });

  it('R-JU3: a masked screenshot on a driver that does not prove masking is withheld when tainted', async () => {
    const h = createHarness({ steps: [thenStep('Signed in', { nature: 'subjective' })], driver: { maskingProven: false } });
    const original = h.driver.openSession.bind(h.driver);
    h.driver.openSession = async (o) => {
      const s = await original(o);
      s.world.tainted = true;
      s.world.masked = true;
      return s;
    };
    await h.run();
    expect(h.judge.requests[0]!.after.screenshot).toBeUndefined();
  });

  it('R-SE2: a tainted screenshot is not stored as evidence either', async () => {
    const h = createHarness({ steps: [thenStep('Signed in', { nature: 'subjective' })] });
    h.judge.verdictFor = () => 'fail';
    const original = h.driver.openSession.bind(h.driver);
    h.driver.openSession = async (o) => {
      const s = await original(o);
      s.world.tainted = true;
      return s;
    };
    await h.run();
    expect(h.evidence.artifacts.some((a) => a.kind === 'screenshot')).toBe(false);
    expect(h.evidence.artifacts.some((a) => a.kind === 'observation')).toBe(true);
  });
});

describe('evidence and usage on assertion steps', () => {
  it('R-EV1: then steps store an observation artifact and failures add a screenshot', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effect(ACT, () => undefined);
    seeded(h);
    const r = await h.run();
    const kinds = r.steps[1]!.evidence.map((e) => e.kind);
    expect(kinds).toEqual(['observation']); // deterministic checks request no pixels, so there is no screenshot
  });

  it('R-EV1: a failing evidence store never changes the step outcome', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    h.evidence.putArtifact = () => Promise.reject(new Error('disk full'));
    const r = await h.run();
    expect(r.status).toBe('passed');
    expect(r.steps[1]?.evidence).toEqual([]);
  });

  it('R-CH1: step usage includes judge and check-generation calls', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    const r = await h.run();
    expect(r.steps[1]?.usage.modelCalls).toBe(3 + 1);
    expect(r.steps[0]?.usage.modelCalls).toBe(1);
  });

  it('R-CH1: a generated program keeps its classification and gets verified.judgePassed = true', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    h.asserter.generateHandler = () => ({
      program: existsProgram('status', CHECK, { verified: { afterTrue: true, probeTrue: true, beforeFalse: true, judgePassed: false } }),
      fuzzyReasons: [],
      attempts: 2,
      usage: { modelCalls: 2, inputTokens: 1, outputTokens: 1 },
      errors: [],
    });
    await h.run();
    expect(h.saved?.steps[1]?.check?.verified).toEqual({ afterTrue: true, probeTrue: true, beforeFalse: true, judgePassed: true });
    expect(h.saved?.steps[1]?.check?.classification).toBe('change');
  });

  it('R-RN1: in replay mode the window starts at the replay\'s own pre-action observation', async () => {
    const h = createHarness({ steps: [when('do first'), thenStep('check one', { nature: 'subjective' })] });
    h.effect('do first', (w) => w.add({ role: 'status', name: 'after-first' }));
    const [a, t] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), fuzzyEntry(t!, ['subjective'])]));
    const r = await h.run();
    expect(r.mode).toBe('replay');
    const req = h.judge.requests[0]!;
    expect(req.actionPreceded).toBe(true);
    expect(req.before.treeText).not.toContain('after-first');
    expect(req.after.treeText).toContain('after-first');
  });

  it('R-RN1: after a heal the window still starts before the diverged replay', async () => {
    const h = createHarness({ steps: [when('do first'), thenStep('check one', { nature: 'subjective' })] });
    h.effect('do first', (w) => w.add({ role: 'status', name: 'after-first' }));
    const [a, t] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), fuzzyEntry(t!, ['subjective'])]));
    h.recorder.diverge('do first', 'target-missing', 0);
    const r = await h.run();
    expect(r.steps[0]?.status).toBe('healed');
    const req = h.judge.requests[0]!;
    expect(req.before.treeText).not.toContain('after-first');
    expect(req.after.treeText).toContain('after-first');
  });

  it('R-AS4: the recorded check is evaluated against the settled after observation with the step params', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK, { params: { plan: 'Pro' } })] });
    h.effectShows(ACT, CHECK);
    seeded(h);
    await h.run();
    expect(h.asserter.evaluations).toHaveLength(1);
    expect(h.asserter.evaluations[0]?.obs.nodes.map((n) => n.name)).toContain(CHECK);
    expect(h.asserter.generations).toHaveLength(0);
  });

  it('R-EV1: the agent transcript artifact is attached to the action step', async () => {
    const h = createHarness({ steps: [when(ACT)] });
    const ref = { sha256: 'b'.repeat(64), path: 'artifacts/transcript.txt', kind: 'act-transcript' as const, bytes: 7 };
    h.actor.handler = async (req, session) => ({ ...(await h.actor.succeed(req, session)), transcript: ref });
    const r = await h.run();
    expect(r.steps[0]?.evidence).toContainEqual(ref);
  });
});
