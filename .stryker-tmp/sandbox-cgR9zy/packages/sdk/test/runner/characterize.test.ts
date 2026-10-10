// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { createHarness, entry, fuzzyEntry, given, recordingOf, thenStep, when, type Harness } from './doubles/harness.ts';

const ACT = 'the user clicks Upgrade to Pro';
const CHECK = 'Plan: Pro';

function upgradeHarness(over: Partial<Parameters<typeof createHarness>[0]> = {}): Harness {
  const h = createHarness({ steps: [when(ACT), thenStep(CHECK)], ...over });
  h.effectShows(ACT, CHECK);
  return h;
}

describe('characterization run (C3, D3, commit rule)', () => {
  it('R-CH1: first run characterizes: agent acts, judge passes first, check generated, recording created', async () => {
    const h = upgradeHarness();
    const r = await h.run();

    expect(r.status).toBe('passed');
    expect(r.mode).toBe('characterize');
    expect(r.recording).toBe('created');
    const [act, check] = r.steps;
    expect(act).toMatchObject({ status: 'passed', path: 'agent', determinism: 'deterministic', fuzzyReasons: [] });
    expect(check).toMatchObject({ status: 'passed', path: 'check+judge', determinism: 'deterministic' });
    expect(h.actor.calls).toHaveLength(1);
    expect(h.judge.requests).toHaveLength(1);
    expect(h.asserter.generations).toHaveLength(1);

    const saved = h.saved;
    expect(saved?.steps).toHaveLength(2);
    expect(saved?.steps[0]?.act?.actions).toHaveLength(1);
    expect(saved?.steps[1]?.check?.verified.judgePassed).toBe(true);
    expect(saved?.driver).toEqual({ id: 'fake', major: 1 });
    expect(saved?.scenarioFingerprint).toBe(h.target.scenario.fingerprint);
  });

  it('R-CH1: C3 settles before, after and (after probeMs) afterProbe, then calls the recorder once', async () => {
    const h = upgradeHarness({ config: { characterize: { confirmRuns: 0, probeMs: 500, healThreshold: 2 } } });
    await h.run();
    expect(h.recorder.recordings).toHaveLength(1);
    const rec = h.recorder.recordings[0];
    expect(rec?.before.nodes.map((n) => n.name)).not.toContain(CHECK);
    expect(rec?.after.nodes.map((n) => n.name)).toContain(CHECK);
    expect(rec?.probe?.nodes.map((n) => n.name)).toContain(CHECK);
    // action step: 500ms probe wait; then step: another 500ms probe wait before generating
    expect(h.clock.sleeps).toEqual([500, 500]);
  });

  it('R-CH1: a failing first run records nothing (judge fails, nothing generated, recording discarded)', async () => {
    const h = upgradeHarness();
    h.judge.verdictFor = () => 'fail';
    const r = await h.run();

    expect(r.status).toBe('failed');
    expect(r.recording).toBe('discarded');
    expect(r.steps[1]).toMatchObject({ status: 'failed', path: 'judge' });
    expect(r.steps[1]?.error?.code).toBe('JUDGE_FAILED');
    expect(h.asserter.generations).toHaveLength(0);
    expect(h.store.saves).toHaveLength(0);
    expect(h.saved).toBeNull();
  });

  it('R-CH1: a failing first run leaves the previous recording file untouched', async () => {
    const h = upgradeHarness();
    const old = recordingOf(h.target, [entry(h.target.scenario.steps[0]!)], { driver: { id: 'fake', major: 1 } });
    h.seed(old);
    const before = JSON.stringify(h.saved);
    h.judge.verdictFor = () => 'fail';
    const r = await h.run({ updateRecordings: true });
    expect(r.recording).toBe('discarded');
    expect(JSON.stringify(h.saved)).toBe(before);
  });

  it('R-CH1: an inconclusive judge on a first run is inconclusive, generates nothing and discards', async () => {
    const h = upgradeHarness();
    h.judge.verdictFor = () => 'inconclusive';
    const r = await h.run();
    expect(r.status).toBe('inconclusive');
    expect(r.steps[1]?.error?.code).toBe('JUDGE_INCONCLUSIVE');
    expect(r.recording).toBe('discarded');
    expect(h.asserter.generations).toHaveLength(0);
  });

  it('R-CH1: a failing action step on a first run records nothing', async () => {
    const h = upgradeHarness();
    h.actor.handler = (req, session) => h.actor.failWith(req, session, 'ACT_BUDGET_EXHAUSTED');
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(r.steps[0]?.error?.code).toBe('ACT_BUDGET_EXHAUSTED');
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH2: the confirm run opens a fresh session and replays the pending recording with zero model calls', async () => {
    const h = upgradeHarness();
    const r = await h.run();
    expect(r.confirm).toEqual({ runs: 1, reclassified: [], failed: false });
    expect(h.driver.sessions).toHaveLength(2);
    expect(h.driver.sessions.every((s) => s.closed)).toBe(true);
    expect(h.actor.calls).toHaveLength(1); // only the characterization run used the agent
    expect(h.judge.requests).toHaveLength(1);
    expect(h.recorder.replays).toHaveLength(1);
  });

  it('R-CH2: confirmRuns=0 skips confirm runs and still saves', async () => {
    const h = upgradeHarness({ config: { characterize: { confirmRuns: 0, probeMs: 500, healThreshold: 2 } } });
    const r = await h.run();
    expect(r.confirm).toBeUndefined();
    expect(r.recording).toBe('created');
    expect(h.driver.sessions).toHaveLength(1);
  });

  it('R-CH2: confirmRuns=2 runs two fresh sessions', async () => {
    const h = upgradeHarness({ config: { characterize: { confirmRuns: 2, probeMs: 500, healThreshold: 2 } } });
    const r = await h.run();
    expect(r.confirm?.runs).toBe(2);
    expect(h.driver.sessions).toHaveLength(3);
    expect(h.recorder.replays).toHaveLength(2);
  });

  it('R-CH2: a confirm replay that diverges reclassifies the step as fuzzy (confirm-replay-failed) and the agent performs it', async () => {
    const h = upgradeHarness();
    // main run (characterize) does not replay; the first replay is the confirm run's
    h.recorder.forceCall = (n) => (n === 1 ? { outcome: 'target-missing', completedActions: 0 } : undefined);
    const r = await h.run();

    expect(r.status).toBe('passed');
    expect(r.confirm).toEqual({ runs: 1, reclassified: [h.target.scenario.steps[0]!.key], failed: false });
    expect(r.recording).toBe('created');
    expect(h.actor.calls).toHaveLength(2); // characterize + the confirm run's reclassified step
    expect(h.actor.calls[1]?.req.hints).toBeDefined();
    const saved = h.saved;
    expect(saved?.steps[0]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['confirm-replay-failed'] });
    expect(saved?.steps[0]?.act).toBeDefined(); // kept as hints
  });

  it('R-CH2: a failing deterministic check in the confirm run reclassifies to fuzzy (confirm-check-failed); the judge decides', async () => {
    const h = upgradeHarness();
    let evaluations = 0;
    const real = h.asserter.evaluate.bind(h.asserter);
    h.asserter.evaluate = (program, obs, params) => {
      evaluations += 1;
      const ev = real(program, obs, params);
      return { ...ev, passed: false };
    };
    const r = await h.run();

    expect(evaluations).toBe(1);
    expect(r.status).toBe('passed');
    expect(r.confirm).toMatchObject({ runs: 1, failed: false, reclassified: [h.target.scenario.steps[1]!.key] });
    expect(h.judge.requests).toHaveLength(2); // characterization judge + confirm-run judge
    const saved = h.saved;
    expect(saved?.steps[1]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['confirm-check-failed'] });
    expect(saved?.steps[1]?.check).toBeUndefined();
  });

  it('R-CH2: CHARACTERIZATION_UNSTABLE when a confirm step still fails after reclassification; recording discarded', async () => {
    const h = upgradeHarness();
    h.recorder.forceCall = (n) => (n === 1 ? { outcome: 'effect-unverified', completedActions: 1 } : undefined);
    h.actor.handler = async (req, session, n, w) => {
      if (n === 1) {
        w.apply(req.step.text);
        const obs = await session.observe();
        return { status: 'done', actions: [{ action: { verb: 'click', target: { ref: 'e0' } }, chosenFrom: obs, outcome: { ok: true } }], finalObservation: obs, summary: 'ok', usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 } };
      }
      return h.actor.failWith(req, session, 'ACT_BUDGET_EXHAUSTED');
    };
    const r = await h.run();

    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('CHARACTERIZATION_UNSTABLE');
    expect(r.error?.details).toMatchObject({ steps: [{ stepKey: h.target.scenario.steps[0]!.key, status: 'failed' }] });
    expect(r.recording).toBe('discarded');
    expect(r.confirm).toMatchObject({ runs: 1, failed: true });
    expect(h.store.saves).toHaveLength(0);
    // main-run step results are unchanged by the confirm outcome
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'passed']);
  });

  it('R-CH2: confirm-run step results are not part of steps, but their usage is counted', async () => {
    const h = upgradeHarness();
    const r = await h.run();
    expect(r.steps).toHaveLength(2);
    const stepCalls = r.steps.reduce((n, s) => n + s.usage.modelCalls, 0);
    expect(r.usage.modelCalls).toBeGreaterThanOrEqual(stepCalls);
    expect(r.usage.modelCalls).toBe(1 + 3 + 1); // actor + judge + checkgen
  });

  it('R-CH3: the agent-recorded fuzzy reasons from the recorder make the step fuzzy and are recorded', async () => {
    const h = upgradeHarness();
    h.recorder.reasons.set(ACT, ['no-observable-effect']);
    const r = await h.run();
    expect(r.steps[0]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['no-observable-effect'] });
    expect(h.saved?.steps[0]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['no-observable-effect'] });
  });

  it('R-CH3: coordinate-action and agent-only-driver reasons pass through to the recording', async () => {
    const h = upgradeHarness();
    h.recorder.reasons.set(ACT, ['coordinate-action', 'agent-only-driver']);
    const r = await h.run();
    expect(r.steps[0]?.fuzzyReasons).toEqual(['coordinate-action', 'agent-only-driver']);
  });

  it('R-CH3: a @fuzzy scenario tag makes the action step fuzzy with reason directive', async () => {
    const h = upgradeHarness({ scenario: { tags: ['@fuzzy'] } });
    const r = await h.run();
    expect(r.steps[0]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['directive'], path: 'agent' });
    expect(h.saved?.steps[0]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['directive'] });
  });

  it('R-CH3: a @fuzzy then step is judged only (D2), recorded fuzzy with reason directive, nothing generated', async () => {
    const h = upgradeHarness({ scenario: { tags: ['@fuzzy'] } });
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ status: 'passed', path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['directive'] });
    expect(h.asserter.generations).toHaveLength(0);
  });

  it('R-CH3: a subjective then step is fuzzy with reason subjective and judged every run', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep('The message feels friendly', { nature: 'subjective' })] });
    h.effect(ACT, () => undefined);
    const first = await h.run();
    expect(first.steps[1]).toMatchObject({ path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['subjective'] });
    expect(h.saved?.steps[1]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['subjective'] });
    const second = await h.run();
    expect(second.mode).toBe('replay');
    expect(second.steps[1]).toMatchObject({ path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['subjective'] });
    expect(h.judge.requests.length).toBeGreaterThanOrEqual(3);
  });

  it('R-CH3: a generated-check failure returns the asserter reasons; the step is judge-only and fuzzy', async () => {
    const h = upgradeHarness();
    h.asserter.generateHandler = () => ({ fuzzyReasons: ['volatile-content'], attempts: 3, usage: { modelCalls: 3, inputTokens: 1, outputTokens: 1 }, errors: ['volatile'] });
    const r = await h.run();
    expect(r.steps[1]).toMatchObject({ status: 'passed', path: 'judge', determinism: 'fuzzy', fuzzyReasons: ['volatile-content'] });
    expect(h.saved?.steps[1]).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['volatile-content'] });
  });

  it('R-CH3: check-not-discriminative and check-generation-failed reasons are recorded as returned', async () => {
    for (const reason of ['check-not-discriminative', 'check-generation-failed'] as const) {
      const h = upgradeHarness();
      h.asserter.generateHandler = () => ({ fuzzyReasons: [reason], attempts: 3, usage: { modelCalls: 3, inputTokens: 1, outputTokens: 1 }, errors: [] });
      const r = await h.run();
      expect(r.steps[1]?.fuzzyReasons).toEqual([reason]);
    }
  });

  it('R-CH3: checks.requireDeterministic turns a failed generation into CHECK_GENERATION_FAILED', async () => {
    const h = upgradeHarness({ config: { checks: { maxAttempts: 3, maxPredicates: 8, requireDeterministic: true } } });
    h.asserter.generateHandler = () => ({ fuzzyReasons: ['check-not-discriminative'], attempts: 3, usage: { modelCalls: 3, inputTokens: 1, outputTokens: 1 }, errors: ['not discriminative'] });
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.steps[1]?.error?.code).toBe('CHECK_GENERATION_FAILED');
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
  });

  it('R-CH3: when generation fails with no reasons the step still records check-generation-failed', async () => {
    const h = upgradeHarness();
    h.asserter.generateHandler = () => ({ fuzzyReasons: [], attempts: 1, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 }, errors: [] });
    const r = await h.run();
    expect(r.steps[1]?.fuzzyReasons).toEqual(['check-generation-failed']);
  });

  it('R-CH2: the judge passes but afterProbe settle happens before generation, passing before/after/afterProbe', async () => {
    const h = upgradeHarness({ config: { characterize: { confirmRuns: 0, probeMs: 250, healThreshold: 2 } } });
    await h.run();
    const req = h.asserter.generations[0]!;
    expect(req.scenarioId).toBe(h.target.scenario.id);
    expect(req.stepKey).toBe(h.target.scenario.steps[1]!.key);
    expect(req.criterion).toBe(CHECK);
    expect(req.actionPreceded).toBe(true);
    expect(req.before.nodes.map((n) => n.name)).not.toContain(CHECK);
    expect(req.after.nodes.map((n) => n.name)).toContain(CHECK);
    expect(req.afterProbe.nodes.map((n) => n.name)).toContain(CHECK);
    expect(h.clock.sleeps).toContain(250);
  });

  it('R-CH1: saving identical content reports unchanged', async () => {
    const h = upgradeHarness({ config: { characterize: { confirmRuns: 0, probeMs: 500, healThreshold: 2 } } });
    const first = await h.run();
    expect(first.recording).toBe('created');
    const second = await h.run({ updateRecordings: true });
    expect(second.recording).toBe('unchanged');
    expect(second.mode).toBe('characterize');
  });

  it('R-CH1: -u re-characterizes even when a valid recording exists, and updates the file', async () => {
    const h = upgradeHarness();
    const steps = h.target.scenario.steps;
    h.seed(recordingOf(h.target, [entry(steps[0]!), entry(steps[1]!)]));
    const r = await h.run({ updateRecordings: true });
    expect(r.mode).toBe('characterize');
    expect(r.steps.map((s) => s.path)).toEqual(['agent', 'check+judge']);
    expect(r.recording).toBe('updated');
  });

  it('R-CH3: fuzzyEntry helper reasons round trip (sanity for later suites)', () => {
    const s = thenStep('x');
    expect(fuzzyEntry(s, ['subjective'])).toMatchObject({ determinism: 'fuzzy', fuzzyReasons: ['subjective'] });
    expect(given('y')).toBeDefined();
  });

  it('R-CH3: the session capabilities reach the recorder so agent-only-driver can be derived', async () => {
    const h = upgradeHarness({ driver: { verbs: ['navigate', 'click'] } });
    await h.run();
    expect(h.recorder.recordings[0]?.capabilities?.verbs).toEqual(['navigate', 'click']);
  });
});
