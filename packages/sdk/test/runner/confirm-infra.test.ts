import { describe, expect, it } from 'vitest';
import { AiBddError } from '../../src/contracts/index.ts';
import { createHarness, thenStep, when } from './doubles/harness.ts';

const ACT = 'the user clicks Upgrade to Pro';
const CHECK = 'Plan: Pro';

describe('a confirm run that dies of infrastructure is not "the recording is unstable"', () => {
  it('a lost session in the confirm run ends the scenario in error with the driver\'s code, discards the recording and commits nothing', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    h.recorder.forceCall = (n) => (n === 1 ? { outcome: 'action-failed', completedActions: 0, detail: 'session lost' } : undefined);
    h.actor.handler = async (req, session, n, w) => {
      if (n === 1) {
        w.apply(req.step.text);
        const obs = await session.observe();
        return { status: 'done', actions: [{ action: { verb: 'click', target: { ref: 'e0' } }, chosenFrom: obs, outcome: { ok: true } }], finalObservation: obs, summary: 'ok', usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 } };
      }
      throw new AiBddError('DRIVER_ERROR', 'session lost');
    };
    const r = await h.run();
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ code: 'DRIVER_ERROR', retryable: true });
    expect(r.error?.code).not.toBe('CHARACTERIZATION_UNSTABLE');
    expect(r.recording).toBe('discarded');
    expect(r.confirm).toMatchObject({ runs: 1, failed: true });
    expect(h.store.saves).toHaveLength(0);
    expect(r.steps.map((s) => s.status), 'the main run is unaffected').toEqual(['passed', 'passed']);
  });

  it('but a confirm step that errors for another reason (the model could not act) is still "did not reproduce": CHARACTERIZATION_UNSTABLE', async () => {
    const h = createHarness({ steps: [when(ACT), thenStep(CHECK)] });
    h.effectShows(ACT, CHECK);
    h.recorder.forceCall = (n) => (n === 1 ? { outcome: 'effect-unverified', completedActions: 1 } : undefined);
    h.actor.handler = async (req, session, n, w) => {
      if (n === 1) {
        w.apply(req.step.text);
        const obs = await session.observe();
        return { status: 'done', actions: [{ action: { verb: 'click', target: { ref: 'e0' } }, chosenFrom: obs, outcome: { ok: true } }], finalObservation: obs, summary: 'ok', usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 } };
      }
      throw new AiBddError('MODEL_NO_RULE', 'the double has no rule for this page');
    };
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('CHARACTERIZATION_UNSTABLE');
    expect(r.recording).toBe('discarded');
    expect(h.store.saves).toHaveLength(0);
  });
});
