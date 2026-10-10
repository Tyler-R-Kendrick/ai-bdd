import type { AiBddErrorPayload, ErrorCode, ScenarioRecording, StepRecording, StepStatus, Usage } from '../contracts/index.ts';
import { errorPayload, redactPayload, addUsage, zeroUsage } from './support.ts';
import { prepareSession, teardownSession } from './session.ts';
import { runStep } from './steps.ts';
import type { PendingSink, ScenarioEnv } from './types.ts';

export interface ConfirmOutcome {
  runs: number;
  reclassified: string[];
  failedSteps: { stepKey: string; status: StepStatus; code?: ErrorCode }[];
  /** Setup problem (session could not open, abort): infrastructure, not instability. */
  infraError?: AiBddErrorPayload;
  usage: Usage;
}

/**
 * Confirm runs (R-CH2, §9.7.3). Each run opens a fresh session, reruns the fixtures and replays the pending
 * recording without healing. Reclassifications are written back into `pending`.
 */
export async function runConfirmRuns(env: ScenarioEnv, pending: ScenarioRecording): Promise<ConfirmOutcome> {
  const { deps, target, opts } = env;
  const steps = target.scenario.steps;
  const wanted = deps.config.characterize.confirmRuns;
  const out: ConfirmOutcome = { runs: 0, reclassified: [], failedSteps: [], usage: zeroUsage() };

  for (let run = 1; run <= wanted; run++) {
    if (opts.signal?.aborted) {
      out.infraError = errorPayload(Object.assign(new Error('run aborted during a confirm run'), { name: 'AbortError' }));
      return out;
    }
    let st;
    try {
      st = await prepareSession(env);
    } catch (err) {
      out.infraError = redactPayload(deps.redactor, errorPayload(err));
      return out;
    }
    out.runs += 1;
    const sink: PendingSink = { entries: pending.steps.slice(), dirty: false, reclassified: [] };
    env.emit({ type: 'log', level: 'debug', scenarioId: target.scenario.id, message: `confirm run ${run}/${wanted}` });
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step === undefined) continue;
        const result = await runStep(env, st, step, i, sink.entries[i], 'confirm', sink);
        addUsage(out.usage, result.usage);
        st.priorSteps.push({ kind: step.kind, text: step.text, status: result.status });
        if (result.status !== 'passed') {
          const failed: ConfirmOutcome['failedSteps'][number] = { stepKey: step.key, status: result.status };
          if (result.error !== undefined) failed.code = result.error.code;
          out.failedSteps.push(failed);
          // A step that ended in `error` was cut short by an exception (a lost session, an unavailable model), so the
          // confirm run proved nothing about the recording: that is infrastructure, not instability.
          if (result.status === 'error' && result.error !== undefined) out.infraError = result.error;
          break;
        }
      }
    } finally {
      await teardownSession(env, st);
    }
    pending.steps = sink.entries.filter((e): e is StepRecording => e !== undefined);
    for (const key of sink.reclassified) if (!out.reclassified.includes(key)) out.reclassified.push(key);
    if (out.failedSteps.length > 0) break;
  }
  return out;
}
