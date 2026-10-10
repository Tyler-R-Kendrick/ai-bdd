import {
  AiBddError,
  type AiBddErrorPayload,
  type Driver,
  type JsonObject,
  type RunEvent,
  type RunnerDeps,
  type ScenarioMode,
  type ScenarioRecording,
  type ScenarioResult,
  type ScenarioRunOptions,
  type ScenarioStatus,
  type ScenarioTarget,
  type StepRecording,
  type StepResult,
} from '../contracts/index.ts';
import { normalizeForQuote, sha256Hex } from '../util/index.ts';
import { runConfirmRuns } from './confirm.ts';
import { prepareSession, teardownSession } from './session.ts';
import { runStep, skippedResult } from './steps.ts';
import {
  PROMPT_VERSIONS,
  aggregateStatus,
  addUsage,
  errorPayload,
  isFuzzyTagged,
  redactPayload,
  toJson,
  zeroUsage,
} from './support.ts';
import type { PendingSink, ScenarioEnv, SessionState } from './types.ts';

/** §9.3: the recording is usable up to the first step whose key or text hash differs (the characterization frontier). */
export function validPrefix(
  recording: ScenarioRecording | null,
  target: ScenarioTarget,
  driverVersion: string,
): { recording: ScenarioRecording | null; frontier: number } {
  if (recording === null) return { recording: null, frontier: 0 };
  if (recording.driver.major !== parseInt(driverVersion, 10)) return { recording: null, frontier: 0 };
  const steps = target.scenario.steps;
  let m = 0;
  while (m < steps.length) {
    const recorded = recording.steps[m];
    const step = steps[m];
    if (recorded === undefined || step === undefined) break;
    if (recorded.stepKey !== step.key || recorded.stepTextHash !== sha256Hex(normalizeForQuote(step.text))) break;
    m += 1;
  }
  return { recording, frontier: m };
}

function safeEmit(deps: RunnerDeps, event: RunEvent): void {
  try {
    deps.emit(event);
  } catch {
    // an event listener must never break a run
  }
}

function modeFor(updateRecordings: boolean, frontier: number, stepCount: number): ScenarioMode {
  if (updateRecordings) return 'characterize';
  if (stepCount > 0 && frontier === 0) return 'characterize';
  return frontier >= stepCount ? 'replay' : 'mixed';
}

/** The runner owns `events.jsonl` (S-FACADE note): every run event becomes one evidence entry. */
function eventEntry(event: RunEvent): JsonObject | undefined {
  switch (event.type) {
    case 'scenario-start':
      return { type: event.type, scenarioId: event.scenarioId, driver: event.driver, mode: event.mode };
    case 'step-start':
      return { type: event.type, scenarioId: event.scenarioId, stepKey: event.stepKey, kind: event.kind, text: event.text };
    case 'step-end': {
      const r = event.result;
      return toJson({
        type: event.type,
        scenarioId: event.scenarioId,
        stepKey: r.stepKey,
        kind: r.kind,
        status: r.status,
        path: r.path,
        determinism: r.determinism,
        fuzzyReasons: r.fuzzyReasons,
        durationMs: r.durationMs,
        actions: r.actions,
        usage: r.usage,
        evidence: r.evidence.map((e) => e.path),
        error: r.error === undefined ? undefined : { code: r.error.code, message: r.error.message },
      }) as JsonObject;
    }
    case 'scenario-end': {
      const r = event.result;
      return toJson({
        type: event.type,
        scenarioId: r.scenarioId,
        driver: r.driver,
        status: r.status,
        mode: r.mode,
        recording: r.recording,
        durationMs: r.durationMs,
        usage: r.usage,
        confirm: r.confirm,
        error: r.error === undefined ? undefined : { code: r.error.code, message: r.error.message },
      }) as JsonObject;
    }
    case 'log':
      return toJson({ type: event.type, level: event.level, message: event.message, scenarioId: event.scenarioId }) as JsonObject;
    default:
      return undefined;
  }
}

const STEP_FAILURES = new Set(['failed', 'blocked', 'error']);
const ERROR_BEARING = new Set<ScenarioStatus>(['error', 'failed', 'inconclusive', 'blocked']);

/**
 * Run one scenario end to end (§9.2 to §9.7). Never rejects: every problem becomes a `ScenarioResult`.
 */
export async function executeScenario(
  deps: RunnerDeps,
  target: ScenarioTarget,
  opts: ScenarioRunOptions,
  driver: Driver | undefined,
  driverName: string | undefined,
  presetError?: AiBddErrorPayload,
): Promise<ScenarioResult> {
  const { config, redactor, clock } = deps;
  const { scenario } = target;
  const steps = scenario.steps;
  const t0 = clock.now();
  let recordChain: Promise<void> = Promise.resolve();
  const emit = (event: RunEvent): void => {
    safeEmit(deps, event);
    const entry = eventEntry(event);
    if (entry !== undefined) {
      // appended in emission order; a failing evidence store never affects the run
      recordChain = recordChain.then(() => deps.evidence.record(entry)).catch(() => undefined);
    }
  };

  const env: ScenarioEnv = {
    deps,
    target,
    opts,
    driver,
    settleOpts: { quietMs: config.settle.quietMs, intervalMs: config.settle.intervalMs, timeoutMs: config.settle.timeoutMs },
    fuzzyTagged: isFuzzyTagged(scenario.tags),
    writable: config.recordingsMode === 'read-write',
    emit,
  };

  let started = false;
  let mode: ScenarioMode = 'characterize';
  let driverId = driverName ?? '';
  let driverMajor = 0;
  let scenarioError: AiBddErrorPayload | undefined = presetError;
  const stepResults: StepResult[] = [];
  const sink: PendingSink = { entries: [], dirty: false, reclassified: [] };
  const usage = zeroUsage();

  const startOnce = (): void => {
    if (started) return;
    started = true;
    emit({ type: 'scenario-start', scenarioId: scenario.id, driver: driverId, mode });
  };

  const pushResult = (result: StepResult): void => {
    stepResults.push(result);
    addUsage(usage, result.usage);
    emit({ type: 'step-end', scenarioId: scenario.id, result });
  };

  try {
    if (scenarioError === undefined) {
      if (opts.signal?.aborted) throw new AiBddError('ABORTED', 'run aborted before the scenario started');
      if (opts.updateRecordings && config.recordingsMode === 'read-only') {
        throw new AiBddError(
          'RECORDING_READ_ONLY',
          'recordings are read-only (CI default), so -u / --update-recordings cannot write; set AI_BDD_RECORDINGS=read-write',
        );
      }
      if (opts.sessionFactory === undefined && driver === undefined) {
        throw new AiBddError(
          'CONFIG_INVALID',
          driverName === undefined ? 'no driver selected and config.defaultDriver is not set' : `unknown driver "${driverName}"`,
          { details: { driver: driverName ?? null, known: Object.keys(config.drivers) } },
        );
      }
      const st = await prepareSession(env);
      try {
        driverId = st.session.driverId;
        driverMajor = Number.isNaN(parseInt(st.session.driverVersion, 10)) ? 0 : parseInt(st.session.driverVersion, 10);
        // §9.3 recording load and prefix validity.
        const loaded = opts.updateRecordings ? null : await deps.recordings.load(driverId, scenario.id);
        const { recording, frontier } = validPrefix(loaded, target, st.session.driverVersion);
        mode = modeFor(opts.updateRecordings, frontier, steps.length);
        sink.entries = steps.map((_, i) => {
          const recorded = recording?.steps[i];
          return i < frontier && recorded !== undefined ? structuredClone(recorded) : undefined;
        });
        const recordedSteps = sink.entries.slice();
        startOnce();
        await runMainSteps(env, st, pushResult, recordedSteps, sink);
        if (opts.signal?.aborted && stepResults.some((r) => r.status === 'skipped')) {
          scenarioError = redactPayload(redactor, errorPayload(new AiBddError('ABORTED', 'run aborted')));
        }
      } finally {
        await teardownSession(env, st);
      }
    }
  } catch (err) {
    scenarioError = redactPayload(redactor, errorPayload(err));
  }

  // Scenarios that never reached (or finished) the step loop: remaining steps are skipped.
  startOnce();
  for (let i = stepResults.length; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    emit({ type: 'step-start', scenarioId: scenario.id, stepKey: step.key, kind: step.kind, text: step.text });
    pushResult(skippedResult(step));
  }

  let status: ScenarioStatus = scenarioError !== undefined ? 'error' : aggregateStatus(stepResults.map((r) => r.status));
  let recordingOutcome: ScenarioResult['recording'] = 'none';
  let confirm: ScenarioResult['confirm'];

  // §9.7.2 commit rule.
  if (sink.dirty) {
    const complete = sink.entries.length === steps.length && sink.entries.every((e) => e !== undefined);
    if (!((status === 'passed' || status === 'healed') && env.writable && complete)) {
      recordingOutcome = 'discarded';
    } else {
      const pending: ScenarioRecording = {
        schemaVersion: 1,
        scenarioId: scenario.id,
        scenarioFingerprint: scenario.fingerprint,
        driver: { id: driverId, major: driverMajor },
        steps: sink.entries.filter((e): e is StepRecording => e !== undefined),
        promptVersions: { ...PROMPT_VERSIONS },
      };
      let commit = true;
      if (config.characterize.confirmRuns > 0) {
        const outcome = await runConfirmRuns(env, pending);
        addUsage(usage, outcome.usage);
        confirm = { runs: outcome.runs, reclassified: outcome.reclassified, failed: outcome.failedSteps.length > 0 };
        if (outcome.infraError !== undefined) {
          commit = false;
          status = 'error';
          scenarioError = outcome.infraError;
        } else if (outcome.failedSteps.length > 0) {
          commit = false;
          status = 'failed';
          scenarioError = redactPayload(redactor, {
            code: 'CHARACTERIZATION_UNSTABLE',
            message: 'the characterized recording did not reproduce in a fresh confirm run, so it was not saved',
            retryable: false,
            details: { steps: outcome.failedSteps.map((s) => ({ stepKey: s.stepKey, status: s.status, ...(s.code ? { code: s.code } : {}) })) },
          });
        }
      }
      if (!commit) {
        recordingOutcome = 'discarded';
      } else {
        try {
          recordingOutcome = await deps.recordings.save(pending);
        } catch (err) {
          recordingOutcome = 'discarded';
          const payload = errorPayload(err);
          if (payload.code !== 'RECORDING_READ_ONLY') {
            status = 'error';
            scenarioError = redactPayload(redactor, payload);
          }
        }
      }
    }
  }

  const firstStepError = ERROR_BEARING.has(status) ? stepResults.find((r) => r.status === status && r.error !== undefined)?.error : undefined;
  const result: ScenarioResult = {
    scenarioId: scenario.id,
    featureId: target.feature.id,
    docUri: target.plan.docUri,
    title: scenario.title,
    driver: driverId,
    status,
    mode,
    review: scenario.review,
    steps: stepResults,
    recording: recordingOutcome,
    usage,
    durationMs: clock.now() - t0,
  };
  if (confirm !== undefined) result.confirm = confirm;
  const error = scenarioError ?? firstStepError;
  if (error !== undefined) result.error = error;
  emit({ type: 'scenario-end', result });
  await recordChain;
  return result;
}

async function runMainSteps(
  env: ScenarioEnv,
  st: SessionState,
  push: (r: StepResult) => void,
  recorded: readonly (StepRecording | undefined)[],
  sink: PendingSink,
): Promise<void> {
  const { target, opts } = env;
  const scenarioId = target.scenario.id;
  let halted = false;
  for (let i = 0; i < target.scenario.steps.length; i++) {
    const step = target.scenario.steps[i];
    if (step === undefined) continue;
    env.emit({ type: 'step-start', scenarioId, stepKey: step.key, kind: step.kind, text: step.text });
    if (!halted && opts.signal?.aborted) halted = true;
    if (halted) {
      push(skippedResult(step));
      continue;
    }
    const result = await runStep(env, st, step, i, recorded[i], 'main', sink);
    st.priorSteps.push({ kind: step.kind, text: step.text, status: result.status });
    if (STEP_FAILURES.has(result.status)) halted = true;
    push(result);
  }
}
