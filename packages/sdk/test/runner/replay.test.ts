import { describe, expect, it } from 'vitest';
import { selectorFor } from './doubles/collaborators.ts';
import { createHarness, entry, fuzzyEntry, recordingOf, thenStep, when, type Harness } from './doubles/harness.ts';

const A = 'the user opens the billing page';
const B = 'the user clicks Upgrade to Pro';
const C = 'Plan: Pro';

function threeStep(over: Partial<Parameters<typeof createHarness>[0]> = {}): Harness {
  const h = createHarness({ steps: [when(A), when(B), thenStep(C)], ...over });
  h.effectShows(B, C);
  return h;
}

function seedFull(h: Harness, opts: { healCountB?: number } = {}): void {
  const [a, b, c] = h.target.scenario.steps;
  h.seed(recordingOf(h.target, [entry(a!), entry(b!, { stats: { healCount: opts.healCountB ?? 0 } }), entry(c!)]));
}

describe('replay mode (C1, D1)', () => {
  it('R-CH4: the second run replays everything with zero model calls', async () => {
    const h = threeStep();
    const first = await h.run();
    expect(first.recording).toBe('created');
    const modelCallsBefore = { actor: h.actor.calls.length, judge: h.judge.requests.length, gen: h.asserter.generations.length };

    const second = await h.run();
    expect(second.status).toBe('passed');
    expect(second.mode).toBe('replay');
    expect(second.recording).toBe('none');
    expect(second.steps.map((s) => s.path)).toEqual(['replay', 'replay', 'check']);
    expect(second.steps.every((s) => s.determinism === 'deterministic')).toBe(true);
    expect(second.usage).toEqual({ modelCalls: 0, inputTokens: 0, outputTokens: 0 });
    expect(h.actor.calls.length).toBe(modelCallsBefore.actor);
    expect(h.judge.requests.length).toBe(modelCallsBefore.judge);
    expect(h.asserter.generations.length).toBe(modelCallsBefore.gen);
    expect(h.store.saves).toHaveLength(1);
    expect(second.confirm).toBeUndefined();
  });

  it('R-CH4: prefix invalidation: a changed step 2 replays step 1 and characterizes the rest (mode mixed)', async () => {
    const first = threeStep();
    await first.run();
    const h = createHarness({ steps: [when(A), when('the user clicks the Go Pro button'), thenStep(C)] });
    h.effectShows('the user clicks the Go Pro button', C);
    const recorded = first.saved;
    expect(recorded).not.toBeNull();
    h.seed(recorded!);

    const r = await h.run();
    expect(r.mode).toBe('mixed');
    expect(r.steps.map((s) => s.path)).toEqual(['replay', 'agent', 'check+judge']);
    expect(h.actor.calls).toHaveLength(1);
    expect(h.actor.calls[0]?.req.step.text).toBe('the user clicks the Go Pro button');
    expect(r.recording).toBe('updated');
    expect(h.saved?.steps.map((s) => s.stepKey)).toEqual(h.target.scenario.steps.map((s) => s.key));
  });

  it('R-CH4: recording steps at or after the frontier are discarded even when the later steps still match', async () => {
    const first = threeStep();
    await first.run();
    // the middle step changes; the third step text is identical but must NOT be reused (earlier state changed)
    const h = createHarness({ steps: [when(A), when('the user clicks Upgrade now'), thenStep(C)] });
    h.effectShows('the user clicks Upgrade now', C);
    h.seed(first.saved!);
    const r = await h.run();
    expect(r.steps[2]?.path).toBe('check+judge');
    expect(h.judge.requests).toHaveLength(1);
  });

  it('R-CH4: a changed first step means nothing is reusable: mode characterize', async () => {
    const first = threeStep();
    await first.run();
    const h = createHarness({ steps: [when('something else entirely'), when(B), thenStep(C)] });
    h.effectShows(B, C);
    h.seed(first.saved!);
    const r = await h.run();
    expect(r.mode).toBe('characterize');
    expect(r.steps.map((s) => s.path)).toEqual(['agent', 'agent', 'check+judge']);
    expect(h.recorder.replays).toHaveLength(2); // only the confirm run replays (two action steps)
  });

  it('R-CH4: appended steps run in characterize mode after the replayed prefix (mixed)', async () => {
    const first = threeStep();
    await first.run();
    const extra = 'the user sees Plan: Pro again';
    const h = createHarness({ steps: [when(A), when(B), thenStep(C), thenStep(extra)] });
    h.effectShows(B, C);
    h.effect(B, (w) => {
      w.add({ role: 'status', name: C });
      w.add({ role: 'status', name: extra });
    });
    h.seed(first.saved!);
    const r = await h.run();
    expect(r.mode).toBe('mixed');
    expect(r.steps.map((s) => s.path)).toEqual(['replay', 'replay', 'check', 'check+judge']);
  });

  it('R-CH4: a recording shorter than the scenario only covers its prefix', async () => {
    const h = threeStep();
    const [a, b] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), entry(b!)]));
    const r = await h.run();
    expect(r.mode).toBe('mixed');
    expect(r.steps.map((s) => s.path)).toEqual(['replay', 'replay', 'check+judge']);
  });

  it('R-CH4: a driver major mismatch invalidates the whole recording', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), entry(b!), entry(c!)], { driver: { id: 'fake', major: 2 } }));
    const r = await h.run();
    expect(r.mode).toBe('characterize');
    expect(r.steps[1]?.path).toBe('agent');
  });

  it('R-CH4: the same major with a newer minor version still replays', async () => {
    const h = threeStep({ driver: { version: '2.7.1' } });
    const [a, b, c] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), entry(b!), entry(c!)], { driver: { id: 'fake', major: 2 } }));
    const r = await h.run();
    expect(r.mode).toBe('replay');
    expect(r.driver).toBe('fake');
  });

  it('R-CH4: a same-length edit of the step text (hash differs, key identical) still invalidates', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    const tampered = entry(b!);
    tampered.stepTextHash = 'f'.repeat(64);
    h.seed(recordingOf(h.target, [entry(a!), tampered, entry(c!)]));
    const r = await h.run();
    expect(r.mode).toBe('mixed');
    expect(r.steps.map((s) => s.path)).toEqual(['replay', 'agent', 'check+judge']);
  });
});

describe('heal, strict and the heal threshold (C1)', () => {
  it('R-CH5: a diverged replay is healed by the agent with the recorded actions as hints; status healed', async () => {
    const h = threeStep();
    seedFull(h);
    h.recorder.forceCall = (n, act) => (n === 2 && act.actions.length > 0 ? { outcome: 'target-missing', completedActions: 0 } : undefined);
    const r = await h.run();

    // replay call 1 = step A, call 2 = step B (diverges), confirm run replays A and B again
    expect(r.status).toBe('healed');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'healed', 'passed']);
    expect(r.steps[1]).toMatchObject({ path: 'heal', determinism: 'deterministic' });
    expect(h.actor.calls).toHaveLength(1);
    expect(h.actor.calls[0]?.req.hints).toEqual([selectorFor(B)]);
    expect(h.judge.requests).toHaveLength(0);
    expect(r.recording).toBe('updated');
    expect(h.saved?.steps[1]?.stats.healCount).toBe(1);
    expect(h.saved?.steps[1]?.determinism).toBe('deterministic');
  });

  it('R-CH5: healing keeps the already-completed replay prefix in the new program', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    const twoActions = entry(b!);
    twoActions.act = { ...entry(b!).act!, actions: [selectorFor('open the menu'), selectorFor(B)] };
    h.seed(recordingOf(h.target, [entry(a!), twoActions, entry(c!)]));
    h.effect('open the menu', () => undefined);
    h.recorder.forceCall = (n) => (n === 2 ? { outcome: 'target-missing', completedActions: 1 } : undefined);
    const r = await h.run({});
    expect(r.steps[1]?.status).toBe('healed');
    const healed = h.saved?.steps[1]?.act?.actions;
    expect(healed).toEqual([selectorFor('open the menu'), selectorFor(B)]);
    expect(h.recorder.recordings).toHaveLength(1);
    // the new program was derived from the observation taken before the replay started
    expect(h.recorder.recordings[0]?.before.nodes.map((n) => n.name)).not.toContain(C);
  });

  it('R-CH5: --strict turns a diverged replay into REPLAY_DIVERGED without calling the agent', async () => {
    const h = threeStep();
    seedFull(h);
    h.recorder.diverge(B, 'target-missing', 0);
    const r = await h.run({ strict: true });

    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[1]?.error?.code).toBe('REPLAY_DIVERGED');
    expect(r.steps[1]?.error?.details).toMatchObject({ outcome: 'target-missing', completedActions: 0 });
    expect(h.actor.calls).toHaveLength(0);
    expect(r.recording).toBe('none');
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH5: --strict does not affect replays that succeed', async () => {
    const h = threeStep();
    seedFull(h);
    const r = await h.run({ strict: true });
    expect(r.status).toBe('passed');
  });

  it('R-CH5: reaching characterize.healThreshold demotes the step to fuzzy with heal-threshold', async () => {
    const h = threeStep();
    seedFull(h, { healCountB: 1 });
    h.recorder.forceCall = (n) => (n === 2 ? { outcome: 'target-ambiguous', completedActions: 0 } : undefined);
    const r = await h.run();

    expect(r.steps[1]).toMatchObject({ status: 'healed', path: 'heal', determinism: 'fuzzy', fuzzyReasons: ['heal-threshold'] });
    expect(h.saved?.steps[1]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['heal-threshold'], stats: { healCount: 2 } });
    expect(h.saved?.steps[1]?.act).toBeDefined();
  });

  it('R-CH5: a demoted step runs through the agent (C2) with hints on the next run, never replaying', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), { ...fuzzyEntry(b!, ['heal-threshold']), stats: { healCount: 2 } }, entry(c!)]));
    const r = await h.run();
    expect(r.status).toBe('passed');
    expect(r.steps[1]).toMatchObject({ path: 'agent', determinism: 'fuzzy', fuzzyReasons: ['heal-threshold'] });
    expect(h.actor.calls).toHaveLength(1);
    expect(h.actor.calls[0]?.req.hints).toEqual([selectorFor(B)]);
    expect(h.recorder.replays.length).toBe(1); // step A only
    expect(r.recording).toBe('none');
  });

  it('R-CH5: a higher healThreshold keeps the step deterministic after a heal', async () => {
    const h = threeStep({ config: { characterize: { confirmRuns: 0, probeMs: 500, healThreshold: 5 } } });
    seedFull(h, { healCountB: 3 });
    h.recorder.diverge(B, 'start-mismatch', 0);
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ status: 'healed', determinism: 'deterministic', fuzzyReasons: [] });
    expect(h.saved?.steps[1]?.stats.healCount).toBe(4);
  });

  it('R-CH5: a heal whose agent does not finish fails the step with the agent error and records nothing', async () => {
    const h = threeStep();
    seedFull(h);
    h.recorder.diverge(B, 'action-failed', 0);
    h.actor.handler = (req, session) => h.actor.failWith(req, session, 'ACT_BUDGET_EXHAUSTED');
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[1]).toMatchObject({ path: 'heal' });
    expect(r.steps[1]?.error?.code).toBe('ACT_BUDGET_EXHAUSTED');
    expect(r.recording).toBe('none'); // nothing was healed, so no pending recording exists
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH5: an agent that reports blocked on a heal fails the step with ACT_BLOCKED', async () => {
    const h = threeStep();
    seedFull(h);
    h.recorder.diverge(B, 'policy-denied', 0);
    h.actor.handler = (req, session) => h.actor.failWith(req, session, 'ACT_BLOCKED');
    const r = await h.run();
    expect(r.steps[1]?.status).toBe('failed');
    expect(r.steps[1]?.error?.code).toBe('ACT_BLOCKED');
  });

  it('R-CH6: in read-only mode a heal reports healed but never updates or writes the recording', async () => {
    const h = threeStep({ recordingsMode: 'read-only' });
    seedFull(h);
    h.recorder.diverge(B, 'target-missing', 0);
    const r = await h.run();
    expect(r.status).toBe('healed');
    expect(r.recording).toBe('discarded');
    expect(h.recorder.recordings).toHaveLength(0); // no re-recording work in read-only mode
    expect(h.store.saves).toHaveLength(0);
    expect(h.driver.sessions).toHaveLength(1); // no confirm runs
  });

  it('R-CH5: status precedence puts healed above passed in the scenario status', async () => {
    const h = threeStep();
    seedFull(h);
    h.recorder.forceCall = (n) => (n === 1 ? { outcome: 'start-mismatch', completedActions: 0 } : undefined);
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['healed', 'passed', 'passed']);
    expect(r.status).toBe('healed');
  });
});

describe('fuzzy action steps (C2) and --no-agent', () => {
  it('R-CH3: a fuzzy recorded action runs through the agent every time with the recording as hints', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), fuzzyEntry(b!, ['no-observable-effect']), entry(c!)]));
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ status: 'passed', path: 'agent', determinism: 'fuzzy', fuzzyReasons: ['no-observable-effect'] });
    expect(h.actor.calls[0]?.req.hints).toEqual([selectorFor(B)]);
    expect(h.recorder.recordings).toHaveLength(0);
    expect(r.recording).toBe('none');
  });

  it('R-CH3: a failing fuzzy action step fails with the agent error', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), fuzzyEntry(b!, ['coordinate-action']), entry(c!)]));
    h.actor.handler = (req, session) => h.actor.failWith(req, session, 'ACT_TARGET_AMBIGUOUS');
    const r = await h.run();
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[1]?.error?.code).toBe('ACT_TARGET_AMBIGUOUS');
  });

  it('R-CH3: a @fuzzy tag overrides a deterministic recording: the agent runs instead of replay', async () => {
    const h = threeStep({ scenario: { tags: ['@fuzzy'] } });
    seedFull(h);
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ path: 'agent', determinism: 'fuzzy', fuzzyReasons: ['directive'] });
    expect(h.recorder.replays).toHaveLength(0);
  });

  it('R-RN3: --no-agent fails with ACT_NO_AGENT where a characterization needs the agent, and records nothing', async () => {
    const h = threeStep();
    const r = await h.run({ noAgent: true });
    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(r.steps[0]?.error?.code).toBe('ACT_NO_AGENT');
    expect(h.actor.calls).toHaveLength(0);
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-RN3: --no-agent fails a diverged replay with ACT_NO_AGENT instead of healing', async () => {
    const h = threeStep();
    seedFull(h);
    h.recorder.diverge(B, 'target-missing', 0);
    const r = await h.run({ noAgent: true });
    expect(r.steps[1]).toMatchObject({ status: 'failed', path: 'heal' });
    expect(r.steps[1]?.error?.code).toBe('ACT_NO_AGENT');
  });

  it('R-RN3: --no-agent fails a fuzzy action step with ACT_NO_AGENT', async () => {
    const h = threeStep();
    const [a, b, c] = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(a!), fuzzyEntry(b!, ['no-observable-effect']), entry(c!)]));
    const r = await h.run({ noAgent: true });
    expect(r.steps[1]?.error?.code).toBe('ACT_NO_AGENT');
  });

  it('R-RN3: --no-agent still replays and checks deterministic steps with zero model calls', async () => {
    const h = threeStep();
    seedFull(h);
    const r = await h.run({ noAgent: true });
    expect(r.status).toBe('passed');
    expect(r.usage.modelCalls).toBe(0);
  });

  it('R-AG1: the actor request carries scenario, step, params, hints, app context, secret names and prior steps', async () => {
    const h = createHarness({
      steps: [when(A), when(B, { params: { plan: 'Pro' } }), thenStep(C)],
      secrets: { adminPassword: 'correct-horse-battery' },
    });
    h.effectShows(B, C);
    await h.run();
    const first = h.actor.calls[0]!.req;
    expect(first.scenario).toEqual({ id: h.target.scenario.id, title: 'Upgrade to Pro' });
    expect(first.priorSteps).toEqual([]);
    expect(first.appContext).toBe('Acme billing app');
    expect(first.secretNames).toEqual(['adminPassword']);
    expect(first.hints).toBeUndefined();
    const second = h.actor.calls[1]!.req;
    expect(second.params).toEqual({ plan: 'Pro' });
    expect(second.priorSteps).toEqual([{ kind: 'when', text: A, status: 'passed' }]);
  });
});
