import type {
  ActProgram,
  ActRequest,
  ActResult,
  ArtifactRef,
  CheckProgram,
  PerformedAction,
  Recorder,
  FixtureContext,
  FuzzyReason,
  JudgeRequest,
  JudgeVerdict,
  Observation,
  RecordedAction,
  Step,
  StepPath,
  StepRecording,
  StepResult,
} from '../contracts/index.ts';
import { normalizeForQuote, sha256Hex } from '../util/index.ts';
import { toJudgeEvidence, storeObservation } from './observed.ts';
import { settledObservation, settleState, wantsPixels } from './session.ts';
import { buildFixtureStub } from './stub.ts';
import { addUsage, dedupe, errorPayload, makePayload, redactPayload, toJson, zeroUsage } from './support.ts';
import type { Phase, PendingSink, ScenarioEnv, SessionState, StepAcc, StepBody, StepCtx } from './types.ts';

// ───────────────────────── entry points

/** Run one step through the §9.5 pipeline. Never throws: failures become `error` results. */
export async function runStep(
  env: ScenarioEnv,
  st: SessionState,
  step: Step,
  idx: number,
  rec: StepRecording | undefined,
  phase: Phase,
  sink: PendingSink,
): Promise<StepResult> {
  const { deps } = env;
  const t0 = deps.clock.now();
  const acc: StepAcc = { usage: zeroUsage(), actions: 0, evidence: [], finalObs: undefined, judged: false };
  const sc: StepCtx = { env, st, step, idx, rec, phase, sink, acc };
  st.holder.params = step.params;
  st.holder.secretError = undefined;

  let body: StepBody;
  try {
    body = await dispatch(sc);
  } catch (err) {
    body = errorBody(err);
  }
  // A missing secret makes the step an error even if the driver or actor swallowed the exception.
  if (st.holder.secretError !== undefined) body = errorBody(st.holder.secretError);
  if (body.error !== undefined) body.error = redactPayload(deps.redactor, body.error);
  acc.evidence.push(...(await captureEvidence(sc, body)));

  const result: StepResult = {
    stepKey: step.key,
    kind: step.kind,
    text: step.text,
    status: body.status,
    path: body.path,
    determinism: body.determinism,
    fuzzyReasons: body.fuzzyReasons,
    actions: acc.actions,
    usage: acc.usage,
    durationMs: deps.clock.now() - t0,
    evidence: acc.evidence,
    sources: step.sources,
  };
  if (body.error !== undefined) result.error = body.error;
  if (body.check !== undefined) result.check = body.check;
  if (body.judge !== undefined) result.judge = body.judge;
  return result;
}

export function skippedResult(step: Step): StepResult {
  return {
    stepKey: step.key,
    kind: step.kind,
    text: step.text,
    status: 'skipped',
    path: 'none',
    determinism: 'n/a',
    fuzzyReasons: [],
    actions: 0,
    usage: zeroUsage(),
    durationMs: 0,
    evidence: [],
    sources: step.sources,
  };
}

async function dispatch(sc: StepCtx): Promise<StepBody> {
  const { step } = sc;
  if (step.kind === 'given' && step.fixture !== undefined) return runFixture(sc);
  if (step.kind === 'given' && step.requiresState === true) return runBlocked(sc);
  if (step.kind === 'then') return runThen(sc);
  return runAction(sc);
}

// ───────────────────────── small helpers

function errorBody(err: unknown): StepBody {
  return { status: 'error', path: 'none', determinism: 'n/a', fuzzyReasons: [], error: errorPayload(err) };
}

function failure(
  path: StepPath,
  determinism: StepBody['determinism'],
  code: Parameters<typeof makePayload>[0],
  message: string,
  details?: unknown,
  extra: Partial<StepBody> = {},
): StepBody {
  return { status: 'failed', path, determinism, fuzzyReasons: [], error: makePayload(code, message, details), ...extra };
}

function noAgent(path: StepPath, determinism: StepBody['determinism']): StepBody {
  return failure(path, determinism, 'ACT_NO_AGENT', 'this step needs the agent but --no-agent is set');
}

export function newEntry(
  step: Step,
  determinism: StepRecording['determinism'],
  reasons: readonly FuzzyReason[],
  extra: { act?: ActProgram; check?: CheckProgram } = {},
): StepRecording {
  const entry: StepRecording = {
    stepKey: step.key,
    stepTextHash: sha256Hex(normalizeForQuote(step.text)),
    kind: step.kind,
    determinism,
    fuzzyReasons: dedupe(reasons),
    stats: { healCount: 0 },
  };
  if (extra.act !== undefined) entry.act = extra.act;
  if (extra.check !== undefined) entry.check = extra.check;
  return entry;
}

/** Confirm-run reclassification: the step becomes fuzzy; a failed check program is dropped, an act program stays as hints. */
function reclassify(sc: StepCtx, rec: StepRecording, reason: FuzzyReason): StepRecording {
  const next: StepRecording = {
    stepKey: rec.stepKey,
    stepTextHash: rec.stepTextHash,
    kind: rec.kind,
    determinism: 'fuzzy',
    fuzzyReasons: dedupe([...rec.fuzzyReasons, reason]),
    stats: rec.stats,
  };
  if (rec.act !== undefined) next.act = rec.act;
  sc.sink.entries[sc.idx] = next;
  if (!sc.sink.reclassified.includes(sc.step.key)) sc.sink.reclassified.push(sc.step.key);
  return next;
}

async function captureEvidence(sc: StepCtx, body: StepBody): Promise<ArtifactRef[]> {
  const obs = sc.acc.finalObs;
  if (obs === undefined || sc.phase === 'confirm') return [];
  const interesting = sc.step.kind === 'then' || body.status === 'failed' || body.status === 'error' || body.status === 'inconclusive';
  if (!interesting) return [];
  return storeObservation(sc.env.deps.evidence, obs, {
    redactor: sc.env.deps.redactor,
    maskingProven: sc.st.session.capabilities.maskingProven,
    screenshot: sc.acc.judged || body.status !== 'passed',
  });
}

// ───────────────────────── A. fixture, B. blocked

async function runFixture(sc: StepCtx): Promise<StepBody> {
  const { env, st, step, idx, rec, phase, sink } = sc;
  const call = step.fixture;
  if (call === undefined) return errorBody(new Error('fixture step without a fixture call'));
  const fixtures = env.deps.config.fixtures;
  const def = fixtures.find((f) => f.name === call.name);
  if (def === undefined) {
    return failure('fixture', 'deterministic', 'FIXTURE_FAILED', `fixture "${call.name}" is not registered`, {
      fixture: call.name,
      known: fixtures.map((f) => f.name),
    });
  }
  const ctx: FixtureContext = {
    session: st.session,
    signal: env.opts.signal ?? new AbortController().signal,
    log: (message) => env.emit({ type: 'log', level: 'debug', message: env.deps.redactor.redact(message), scenarioId: env.target.scenario.id }),
  };
  if (env.deps.config.baseURL !== undefined) ctx.baseURL = env.deps.config.baseURL;
  st.ring.invalidate();
  try {
    const cleanup = await def.run(call.args, ctx);
    if (typeof cleanup === 'function') st.cleanups.push({ name: def.name, run: cleanup });
  } catch (err) {
    const cause = errorPayload(err);
    return failure('fixture', 'deterministic', 'FIXTURE_FAILED', `fixture "${def.name}" failed: ${cause.message}`, {
      fixture: def.name,
      cause: cause.code,
    });
  }
  if (phase === 'main' && rec === undefined) sink.entries[idx] = newEntry(step, 'deterministic', []);
  return { status: 'passed', path: 'fixture', determinism: 'deterministic', fuzzyReasons: [] };
}

function runBlocked(sc: StepCtx): StepBody {
  const { name, stub } = buildFixtureStub(sc.step);
  return {
    status: 'blocked',
    path: 'none',
    determinism: 'n/a',
    fuzzyReasons: [],
    error: makePayload('FIXTURE_REQUIRED', `step needs application state that no fixture provides: ${sc.step.text}`, {
      fixture: name,
      stub,
    }),
  };
}

// ───────────────────────── C. UI actions

async function callActor(sc: StepCtx, hints: RecordedAction[] | undefined): Promise<ActResult> {
  const { env, st, step, acc } = sc;
  const scenario = env.target.scenario;
  const req: ActRequest = {
    scenario: { id: scenario.id, title: scenario.title },
    step,
    priorSteps: st.priorSteps.map((p) => ({ ...p })),
    params: step.params,
    appContext: env.deps.config.context,
    secretNames: [...env.deps.redactor.secretNames],
  };
  if (hints !== undefined) req.hints = hints;
  if (env.opts.signal) req.signal = env.opts.signal;
  const res = await env.deps.actor.act(req, st.session);
  addUsage(acc.usage, res.usage);
  acc.actions += res.actions.length;
  acc.finalObs = res.finalObservation;
  if (res.transcript !== undefined) acc.evidence.push(res.transcript);
  st.ring.invalidate();
  return res;
}

/** Re-record a performed step; the session capabilities let the recorder derive `agent-only-driver`. */
function rerecord(
  sc: StepCtx,
  performed: readonly PerformedAction[],
  before: Observation,
  after: Observation,
  afterProbe: Observation,
): ReturnType<Recorder['toRecording']> {
  return sc.env.deps.recorder.toRecording(performed, before, after, afterProbe, sc.step, { capabilities: sc.st.session.capabilities });
}

function actFailure(res: ActResult, path: StepPath, determinism: StepBody['determinism']): StepBody {
  const error =
    res.error ?? makePayload(res.status === 'blocked' ? 'ACT_BLOCKED' : 'INTERNAL', res.summary || 'the agent did not complete the step');
  return { status: 'failed', path, determinism, fuzzyReasons: [], error };
}

async function runAction(sc: StepCtx): Promise<StepBody> {
  const { env, st, rec } = sc;
  const startsRun = !st.inRun;
  st.inRun = true;
  const program = rec !== undefined && rec.determinism === 'deterministic' && !env.fuzzyTagged ? rec.act : undefined;
  if (rec !== undefined && program !== undefined) return replayBranch(sc, rec, program, startsRun);
  if (rec !== undefined) return fuzzyActionBranch(sc, rec, startsRun);
  return characterizeBranch(sc, startsRun);
}

/** C1: deterministic recording. */
async function replayBranch(sc: StepCtx, rec: StepRecording, program: ActProgram, startsRun: boolean): Promise<StepBody> {
  const { env, st, idx, phase, sink, acc } = sc;
  const { deps, opts } = env;
  const { config } = deps;
  const replayCtx: Parameters<typeof deps.recorder.replay>[2] = { policy: config.policy };
  if (config.baseURL !== undefined) replayCtx.baseURL = config.baseURL;
  if (opts.signal) replayCtx.signal = opts.signal;

  const replay = await deps.recorder.replay(program, st.session, replayCtx);
  st.ring.invalidate();
  acc.actions += replay.completedActions;
  acc.finalObs = replay.after;
  if (startsRun) st.lastRunBefore = replay.before;

  if (replay.outcome === 'replayed') {
    return { status: 'passed', path: 'replay', determinism: 'deterministic', fuzzyReasons: [] };
  }

  if (phase === 'confirm') {
    // Confirm runs never heal: the step is reclassified and the agent performs it so the run can continue.
    const next = reclassify(sc, rec, 'confirm-replay-failed');
    if (opts.noAgent) return noAgent('agent', 'fuzzy');
    const res = await callActor(sc, program.actions);
    if (res.status !== 'done') return actFailure(res, 'agent', 'fuzzy');
    return { status: 'passed', path: 'agent', determinism: 'fuzzy', fuzzyReasons: next.fuzzyReasons };
  }

  const divergence = { outcome: replay.outcome, completedActions: replay.completedActions, ...(replay.detail !== undefined ? { detail: replay.detail } : {}) };
  if (opts.strict) {
    return failure('replay', 'deterministic', 'REPLAY_DIVERGED', `recorded steps no longer replay (${replay.outcome}) and --strict forbids healing`, divergence);
  }
  if (opts.noAgent) return noAgent('heal', 'deterministic');

  // Heal: the agent finishes the step, starting from the state the replayed prefix left behind.
  const res = await callActor(sc, program.actions);
  if (res.status !== 'done') return actFailure(res, 'heal', 'deterministic');

  sink.dirty = true;
  if (!env.writable) return { status: 'healed', path: 'heal', determinism: 'deterministic', fuzzyReasons: [] };

  const afterR = await settleState(env, st, false);
  await deps.clock.sleep(config.characterize.probeMs, opts.signal);
  const probeR = await settleState(env, st, false);
  const rerecorded = rerecord(sc, res.actions, replay.before, afterR.observation, probeR.observation);
  const prefix = program.actions.slice(0, Math.min(replay.completedActions, program.actions.length));
  const healCount = rec.stats.healCount + 1;
  const reasons = dedupe<FuzzyReason>([
    ...rec.fuzzyReasons,
    ...rerecorded.fuzzyReasons,
    ...(healCount >= config.characterize.healThreshold ? (['heal-threshold'] as const) : []),
  ]);
  const determinism = reasons.length > 0 ? 'fuzzy' : 'deterministic';
  const entry: StepRecording = {
    stepKey: rec.stepKey,
    stepTextHash: rec.stepTextHash,
    kind: rec.kind,
    determinism,
    fuzzyReasons: reasons,
    act: { ...rerecorded.act, actions: [...prefix, ...rerecorded.act.actions] },
    stats: { healCount },
  };
  sink.entries[idx] = entry;
  return { status: 'healed', path: 'heal', determinism, fuzzyReasons: reasons };
}

/** C2: fuzzy recording (or a `@fuzzy` step): the agent performs the step every time, with the recording as hints. */
async function fuzzyActionBranch(sc: StepCtx, rec: StepRecording, startsRun: boolean): Promise<StepBody> {
  const { env, st } = sc;
  if (env.opts.noAgent) return noAgent('agent', 'fuzzy');
  if (startsRun) st.lastRunBefore = await settledObservation(env, st, false);
  const res = await callActor(sc, rec.act?.actions);
  if (res.status !== 'done') return actFailure(res, 'agent', 'fuzzy');
  const reasons = rec.determinism === 'fuzzy' ? rec.fuzzyReasons : (['directive'] as FuzzyReason[]);
  return { status: 'passed', path: 'agent', determinism: 'fuzzy', fuzzyReasons: reasons };
}

/** C3: no recording; characterize with before / after / probe. */
async function characterizeBranch(sc: StepCtx, startsRun: boolean): Promise<StepBody> {
  const { env, st, step, idx, sink } = sc;
  const { deps, opts } = env;
  if (opts.noAgent) return noAgent('agent', 'n/a');
  sink.dirty = true; // a characterization was attempted: a recording is pending even if the step fails

  const before = await settledObservation(env, st, false);
  if (startsRun) st.lastRunBefore = before;
  const res = await callActor(sc, undefined);
  if (res.status !== 'done') return actFailure(res, 'agent', 'n/a');

  const afterR = await settleState(env, st, false);
  await deps.clock.sleep(deps.config.characterize.probeMs, opts.signal);
  const probeR = await settleState(env, st, false);
  const rerecorded = rerecord(sc, res.actions, before, afterR.observation, probeR.observation);
  const reasons = dedupe<FuzzyReason>([...rerecorded.fuzzyReasons, ...(env.fuzzyTagged ? (['directive'] as const) : [])]);
  const determinism = reasons.length > 0 ? 'fuzzy' : 'deterministic';
  sink.entries[idx] = newEntry(step, determinism, reasons, { act: rerecorded.act });
  sink.dirty = true;
  return { status: 'passed', path: 'agent', determinism, fuzzyReasons: reasons };
}

// ───────────────────────── D. assertions

async function callJudge(sc: StepCtx, before: Observation, after: Observation, actionPreceded: boolean): Promise<JudgeVerdict> {
  const { env, st, step, acc } = sc;
  const { deps } = env;
  const eo = {
    vision: deps.config.judge.vision,
    maxTreeChars: deps.config.judge.maxTreeChars,
    maskingProven: st.session.capabilities.maskingProven,
    redactor: deps.redactor,
  };
  // R-JU1: the request is built from observations alone; nothing the actor produced can reach the judge.
  const req: JudgeRequest = {
    criterion: step.text,
    params: step.params,
    before: toJudgeEvidence(before, eo),
    after: toJudgeEvidence(after, eo),
    actionPreceded,
    appContext: deps.config.context,
  };
  const verdict = await deps.judge.judge(req, env.opts.signal);
  addUsage(acc.usage, verdict.usage);
  acc.judged = true;
  return verdict;
}

function judgeBody(v: JudgeVerdict, path: StepPath, determinism: StepBody['determinism'], reasons: FuzzyReason[]): StepBody {
  const base = { path, determinism, fuzzyReasons: reasons, judge: v };
  const details = { score: v.score, spread: v.spread, explanations: v.samples.map((s) => s.explanation) };
  if (v.verdict === 'pass') return { status: 'passed', ...base };
  if (v.verdict === 'fail') {
    return { status: 'failed', ...base, error: makePayload('JUDGE_FAILED', `the criterion does not hold (score ${v.score.toFixed(2)})`, details) };
  }
  return {
    status: 'inconclusive',
    ...base,
    error: makePayload('JUDGE_INCONCLUSIVE', `the judge could not decide (${v.reason ?? 'band'}, score ${v.score.toFixed(2)})`, {
      ...details,
      ...(v.reason !== undefined ? { reason: v.reason } : {}),
    }),
  };
}

function fuzzyReasonsFor(sc: StepCtx): FuzzyReason[] {
  const { rec, step, env } = sc;
  if (rec !== undefined && rec.determinism === 'fuzzy') return rec.fuzzyReasons;
  const reasons: FuzzyReason[] = [];
  if (step.nature === 'subjective') reasons.push('subjective');
  if (env.fuzzyTagged) reasons.push('directive');
  return reasons;
}

async function runThen(sc: StepCtx): Promise<StepBody> {
  const { env, st, step, idx, rec, phase, sink, acc } = sc;
  const { deps, opts } = env;
  const { config } = deps;
  const subjective = step.nature === 'subjective';
  const program = rec !== undefined && rec.determinism === 'deterministic' && !subjective && !env.fuzzyTagged ? rec.check : undefined;
  const auditing = program !== undefined && phase === 'main' && opts.audit;
  const pixels = (program === undefined || auditing) && wantsPixels(env, st);

  // D.1 settle `after`; an unsettled screen is never judged or checked (R-RN1).
  const cached = st.ring.take(pixels);
  let after: Observation;
  let settled: boolean;
  if (cached !== undefined) {
    after = cached;
    settled = true;
  } else {
    const r = await settleState(env, st, pixels);
    after = r.observation;
    settled = r.settled;
  }
  acc.finalObs = after;

  // D.2 window rule (§9.6): before = settled observation ahead of the latest contiguous run of actions.
  const actionPreceded = st.lastRunBefore !== undefined;
  const before = st.lastRunBefore ?? st.firstObs;
  st.inRun = false;

  if (!settled && config.settle.requireSettled) {
    return failure('none', 'n/a', 'SCREEN_NOT_SETTLED', 'the screen did not settle before the check', {
      route: after.route,
      timeoutMs: env.settleOpts.timeoutMs,
    });
  }

  // D1: deterministic recorded check.
  if (rec !== undefined && program !== undefined) {
    const evaluation = deps.asserter.evaluate(program, after, step.params);
    const verdict = auditing ? await callJudge(sc, before, after, actionPreceded) : undefined;
    if (phase === 'confirm' && !evaluation.passed) {
      const next = reclassify(sc, rec, 'confirm-check-failed');
      const v = await callJudge(sc, before, after, actionPreceded);
      return judgeBody(v, 'judge', 'fuzzy', next.fuzzyReasons);
    }
    const base: Partial<StepBody> = { check: evaluation };
    if (verdict !== undefined) base.judge = verdict;
    const path: StepPath = verdict !== undefined ? 'check+judge' : 'check';
    const disagrees =
      verdict !== undefined &&
      ((evaluation.passed && verdict.verdict === 'fail') || (!evaluation.passed && verdict.verdict === 'pass'));
    if (disagrees && verdict !== undefined) {
      return failure(path, 'deterministic', 'CHECK_JUDGE_DISAGREEMENT', `the recorded check ${evaluation.passed ? 'passed' : 'failed'} but the judge ${verdict.verdict === 'pass' ? 'passes' : 'fails'} the criterion`, {
        check: evaluation.passed ? 'pass' : 'fail',
        judge: verdict.verdict,
        score: verdict.score,
      }, base);
    }
    if (evaluation.passed) return { status: 'passed', path, determinism: 'deterministic', fuzzyReasons: [], ...base };
    return failure(path, 'deterministic', 'CHECK_FAILED', 'the recorded check does not hold', {
      predicates: toJson(evaluation.results.map((r) => ({ predicate: r.predicate, satisfied: r.satisfied, actual: r.actual ?? null }))),
    }, base);
  }

  // D2: fuzzy recording, subjective criterion or `@fuzzy` step; the judge decides every time.
  if (rec !== undefined || subjective || env.fuzzyTagged) {
    const reasons = fuzzyReasonsFor(sc);
    if (rec === undefined && phase === 'main') sink.dirty = true;
    const v = await callJudge(sc, before, after, actionPreceded);
    if (rec === undefined && phase === 'main') sink.entries[idx] = newEntry(step, 'fuzzy', reasons);
    return judgeBody(v, 'judge', 'fuzzy', reasons);
  }

  // D3: no recording: the judge decides first (R-CH1); only on a pass is a check generated.
  if (phase === 'main') sink.dirty = true;
  const v = await callJudge(sc, before, after, actionPreceded);
  if (v.verdict !== 'pass') return judgeBody(v, 'judge', 'n/a', []);
  await deps.clock.sleep(config.characterize.probeMs, opts.signal);
  const afterProbe = (await settleState(env, st, false)).observation;
  const gen = await deps.asserter.generate({
    scenarioId: env.target.scenario.id,
    stepKey: step.key,
    criterion: step.text,
    params: step.params,
    before,
    after,
    afterProbe,
    actionPreceded,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  addUsage(acc.usage, gen.usage);
  if (gen.program !== undefined) {
    const verified: CheckProgram = { ...gen.program, verified: { ...gen.program.verified, judgePassed: true } };
    sink.entries[idx] = newEntry(step, 'deterministic', [], { check: verified });
    sink.dirty = true;
    return { status: 'passed', path: 'check+judge', determinism: 'deterministic', fuzzyReasons: [], judge: v };
  }
  if (config.checks.requireDeterministic) {
    return failure('judge', 'n/a', 'CHECK_GENERATION_FAILED', 'no deterministic check could be generated and checks.requireDeterministic is set', {
      attempts: gen.attempts,
      reasons: gen.fuzzyReasons,
      errors: gen.errors,
    }, { judge: v });
  }
  const reasons: FuzzyReason[] = gen.fuzzyReasons.length > 0 ? gen.fuzzyReasons : ['check-generation-failed'];
  sink.entries[idx] = newEntry(step, 'fuzzy', reasons);
  sink.dirty = true;
  return { status: 'passed', path: 'judge', determinism: 'fuzzy', fuzzyReasons: reasons, judge: v };
}
