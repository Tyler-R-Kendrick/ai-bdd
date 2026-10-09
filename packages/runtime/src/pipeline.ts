import { join } from 'node:path';
import type {
  ActOutcome,
  ActProgram,
  AssertOutcome,
  CheckProgram,
  Diagnostic,
  DriverSession,
  EvidenceRef,
  JsonValue,
  ModelSet,
  Observation,
  ResolvedConfig,
  Scenario,
  ScenarioResult,
  SpecDocument,
  Step,
  StepKind,
  StepResult,
  Status,
} from '@ai-bdd/contracts';
import { AiBddError, actKey, checkKey, lockKey, normalizeStepText } from '@ai-bdd/contracts';
import { createActor } from '@ai-bdd/act';
import { createAsserter } from '@ai-bdd/assert';
import { createCalibrationJournal, createJudge, createJudgeCache, type CalibrationJournal, type JudgeCache } from '@ai-bdd/judge';
import { createRedactor, settle, type EvidenceStore } from '@ai-bdd/evidence';
import type { CacheStore } from '@ai-bdd/cache';
import type { Resolver } from '@ai-bdd/lock';
import type { BindingRegistry } from '@ai-bdd/registry';
import { inferKind, mergeOptions } from '@ai-bdd/spec-directives';
import { span, type TraceContext } from './trace.js';

export interface PipelineDependencies {
  config: ResolvedConfig;
  registry: BindingRegistry;
  resolver: Resolver;
  cache: CacheStore;
  models: ModelSet;
  evidence: EvidenceStore;
  driver: { id: string; major: number; target?: string };
  judgeCache: JudgeCache;
  /** Calibration journal, so every judgment is recorded (R-K4a). */
  journal?: CalibrationJournal;
  frozen: boolean;
  strictCache: boolean;
  now: () => Date;
  diagnostics: Diagnostic[];
}

export interface StepState {
  windowBefore?: Observation;
  lastActionObservation?: Observation;
  pendingCommits: Array<() => Promise<void>>;
}

/**
 * Runs one scenario through the step pipeline (sections 6.1 and 6.2).
 *
 * Actions go through the act loop (replay, heal, record), assertions through the
 * check generator and the judge, and every step produces evidence. A recorded
 * program is committed only after a later assertion in the same scenario passes.
 */
export async function runScenario(
  deps: PipelineDependencies,
  document: SpecDocument,
  scenario: Scenario,
  session: DriverSession,
  traceId: string,
): Promise<ScenarioResult> {
  const redactor = createRedactor(deps.config.secrets);
  const state: StepState = { pendingCommits: [] };
  const results: StepResult[] = [];
  const started = deps.now().getTime();
  let scenarioStatus: Status = 'passed';
  const statusOf = (): Status => scenarioStatus;
  const setStatus = (next: Status): void => {
    scenarioStatus = next;
  };

  const scenarioOptions = mergeOptions({}, document.options, scenario.options, {});
  const execute = async (step: Step, isTeardown: boolean): Promise<void> => {
    const trace = span(traceId);
    const stepStarted = deps.now().getTime();
    try {
      const result = await runPipelineStep(deps, step, session, state, trace, scenario);
      results.push({ ...result, durationMs: deps.now().getTime() - stepStarted });
      if (!isTeardown && result.status !== 'passed' && result.status !== 'healed') setStatus('failed');
      if (result.status === 'healed' && statusOf() !== 'failed') setStatus('healed');
    } catch (error) {
      const payload = AiBddError.payload(error);
      results.push({
        stepId: step.id,
        text: step.text,
        kind: step.kind,
        kindSource: step.kindSource,
        status: 'failed',
        resolution: { type: 'agent', mode: step.kind === 'assertion' ? 'assert' : 'act', reason: 'no-match' },
        evidence: [],
        durationMs: deps.now().getTime() - stepStarted,
        traceId: trace.traceId,
        traceparent: trace.traceparent,
        error: payload,
      });
      if (!isTeardown) setStatus('failed');
      deps.diagnostics.push({
        code: payload.code,
        severity: 'error',
        message: payload.message,
        location: step.location,
      });
    }
    void scenarioOptions;
    void redactor;
  };

  const blocks = groupBlocks(scenario.steps);
  for (const block of blocks) {
    for (const step of block.steps) await execute(step, false);
  }
  // Teardown runs even after a failure and never masks the original failure (P8).
  // Gauge parsers may already inline the teardown steps into every scenario, so
  // only the steps that are not part of the scenario are executed here.
  const inlineTeardown = scenario.steps.some((step) => step.phase === 'teardown');
  if (!inlineTeardown) {
    for (const step of document.teardown) await execute({ ...step, phase: 'teardown' }, true);
  }

  if (statusOf() !== 'failed') {
    for (const commit of state.pendingCommits) await commit();
  }

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    specName: document.name,
    uri: document.uri,
    tags: scenario.tags,
    ...(scenario.dataRow ? { dataRow: scenario.dataRow } : {}),
    status: statusOf(),
    steps: results,
    durationMs: deps.now().getTime() - started,
    traceId,
    driver: deps.driver.id,
  };
}

export function createStepState(): StepState {
  return { pendingCommits: [] };
}

interface Block {
  steps: Step[];
}

/** Groups steps into contiguous action runs so the before window is well defined. */
function groupBlocks(steps: Step[]): Block[] {
  const blocks: Block[] = [];
  let current: Step[] = [];
  for (const step of steps) {
    current.push(step);
    if (step.kind !== 'action') {
      blocks.push({ steps: current });
      current = [];
    }
  }
  if (current.length > 0) blocks.push({ steps: current });
  return blocks;
}

export async function runPipelineStep(
  deps: PipelineDependencies,
  step: Step,
  session: DriverSession,
  state: StepState,
  trace: TraceContext,
  scenario: Scenario,
): Promise<StepResult> {
  const evidence: EvidenceRef[] = [];
  const options = mergeOptions({}, {}, {}, step.options);
  // Section 7.4: for a keyword-less step the kind of the matched binding wins over
  // the text heuristics, so a quick exact lookup runs before the full resolution.
  const exactProbe = kindSourceNeedsBinding(step) ? deps.registry.matchExact(step.text) : undefined;
  const bindingKind = exactProbe?.matches[0]?.binding.kind;
  const inferred = inferKind({
    text: step.text,
    ...(step.keyword !== undefined ? { keyword: step.keyword } : {}),
    options,
    ...(bindingKind !== undefined ? { bindingKind } : {}),
    config: { kinds: deps.config.kinds },
  });
  const kind: StepKind = step.kindSource === 'keyword' ? step.kind : inferred.kind;
  const kindSource = step.kindSource === 'keyword' ? step.kindSource : inferred.kindSource;

  const resolution = await deps.resolver.resolve({ ...step, kind, kindSource }, { frozen: deps.frozen });
  const base: Pick<StepResult, 'stepId' | 'text' | 'kind' | 'kindSource' | 'resolution' | 'traceId' | 'traceparent' | 'location'> = {
    stepId: step.id,
    text: step.text,
    kind,
    kindSource,
    resolution: resolution.resolution,
    traceId: trace.traceId,
    traceparent: trace.traceparent,
    location: step.location,
  };
  void scenario;

  if (resolution.resolution.type === 'ambiguous') {
    return {
      ...base,
      status: 'ambiguous',
      evidence,
      durationMs: 0,
      error: { code: 'STEP_AMBIGUOUS', message: resolution.resolution.message, retryable: false },
    };
  }
  if (resolution.resolution.type === 'unbound') {
    return {
      ...base,
      status: 'failed',
      evidence,
      durationMs: 0,
      error: {
        code: resolution.resolution.reason === 'setup-unbound' ? 'SETUP_UNBOUND' : 'SETUP_UNBOUND',
        message: resolution.resolution.message,
        retryable: false,
      },
    };
  }

  if (resolution.resolution.type === 'exact' || resolution.resolution.type === 'semantic') {
    const bindingId = resolution.resolution.bindingId;
    const params = resolution.resolution.params;
    const fn = deps.registry.functions().get(bindingId);
    let status: Status = 'passed';
    let error: { code: string; message: string; retryable: boolean } | undefined;
    if (fn) {
      try {
        await fn(params, { session, config: deps.config, params, now: deps.now });
      } catch (caught) {
        status = 'failed';
        error = AiBddError.payload(caught);
      }
    }
    const observation = await session.observe({ pixels: false });
    const record = await deps.evidence.write({
      kind: 'observation',
      data: redactObservation(observation),
      ext: 'json',
      stepId: step.id,
      traceId: trace.traceId,
    });
    evidence.push({ evidenceId: record.evidenceId, kind: 'observation', sha256: record.artifact.sha256 });

    let judge;
    let check;
    if (kind === 'assertion') {
      const asserter = createAsserter({
        model: deps.models.checkgen,
        judge: createJudge({
          model: deps.models.judge,
          config: deps.config.judge,
          cache: deps.judgeCache,
          ...(deps.journal !== undefined ? { journal: deps.journal } : {}),
        }),
        cache: deps.cache,
        config: deps.config.assertions,
        driver: { id: deps.driver.id, major: deps.driver.major, nativePredicates: false },
        params,
        ...(deps.config.context !== undefined ? { context: deps.config.context } : {}),
        cacheMode: deps.config.cache.mode,
      });
      const windowBefore = state.windowBefore ?? observation;
      const outcome: AssertOutcome = await asserter.assert(
        { id: step.id, text: step.text, options },
        {
          before: windowBefore,
          after: observation,
          actionPreceded: state.windowBefore !== undefined,
          beforeTree: describeTree(windowBefore),
          afterTree: describeTree(observation),
          key: checkKey({ text: step.text, driver: deps.driver.id, driverMajor: deps.driver.major }),
        },
      );
      check = outcome.check;
      judge = outcome.judge;
      if (outcome.status === 'failed') {
        status = 'failed';
        error = outcome.error ? { ...outcome.error, retryable: outcome.error.retryable ?? false } : undefined;
      } else {
        state.pendingCommits.push(() => asserter.pending());
      }
    }
    return { ...base, status, evidence, durationMs: 0, ...(check ? { check } : {}), ...(judge ? { judge } : {}), ...(error ? { error } : {}) };
  }

  // Agent fallback.
  if (kind === 'setup') {
    return {
      ...base,
      status: 'failed',
      evidence,
      durationMs: 0,
      error: {
        code: 'SETUP_UNBOUND',
        message: deps.config.resolution.allowAgentSetup
          ? 'setup steps cannot use the agent in this build'
          : 'no setup binding matches this step; add a binding (resolution.allowAgentSetup can opt in)',
        retryable: false,
      },
    };
  }

  if (deps.config.evidence.requireSettled) {
    const settled = await settle(session, deps.config.evidence.settle);
    if (!settled.settled) {
      return {
        ...base,
        status: 'failed',
        evidence,
        durationMs: 0,
        error: { code: 'SCREEN_NOT_SETTLED', message: settled.reason ?? 'the screen did not settle', retryable: false },
      };
    }
  }

  if (kind === 'action') {
    const before = state.lastActionObservation ?? (await session.observe({ pixels: false }));
    const actor = createActor({
      model: deps.models.act,
      cache: deps.cache,
      config: {
        maxActions: deps.config.agent.maxActions,
        maxModelCalls: deps.config.agent.maxModelCalls,
        grounding: deps.config.grounding,
        policy: deps.config.policy,
      },
      ...(deps.models.grounding ? { grounding: deps.models.grounding } : {}),
      evidence: deps.evidence as never,
      now: deps.now,
    });
    const params = resolution.resolution.type === 'agent' ? {} : {};
    const outcome: ActOutcome = await actor.act(
      { id: step.id, text: step.text, options },
      session,
      {
        params,
        before,
        key: actKey({
          text: step.text,
          params: [],
          driver: deps.driver.id,
          driverMajor: deps.driver.major,
          ...(deps.driver.target !== undefined ? { target: deps.driver.target } : {}),
        }),
        driver: deps.driver.id,
        driverMajor: deps.driver.major,
        cacheMode: deps.config.cache.mode,
      },
    );
    const after = await session.observe({ pixels: false });
    if (!state.lastActionObservation) state.windowBefore = before;
    state.lastActionObservation = after;
    if (outcome.status === 'passed' && outcome.pending) state.pendingCommits.push(outcome.pending);
    const healed = outcome.cache.mode === 'healed';
    return {
      ...base,
      status: outcome.status === 'passed' ? (healed ? 'healed' : 'passed') : 'failed',
      cache: outcome.cache,
      ...(healed ? { healing: { reason: 'the cached program did not match', replayedActions: outcome.replayedActions ?? 0, totalActions: outcome.actions.length } } : {}),
      evidence,
      durationMs: 0,
      modelCalls: outcome.modelCalls,
      ...(outcome.error ? { error: { ...outcome.error, retryable: false } } : {}),
    };
  }

  // Agent assertion without a binding.
  const before = state.windowBefore ?? (await session.observe({ pixels: false }));
  const after = await session.observe({ pixels: false });
  const asserter = createAsserter({
    model: deps.models.checkgen,
    judge: createJudge({
      model: deps.models.judge,
      config: deps.config.judge,
      cache: deps.judgeCache,
      ...(deps.journal !== undefined ? { journal: deps.journal } : {}),
    }),
    cache: deps.cache,
    config: deps.config.assertions,
    driver: { id: deps.driver.id, major: deps.driver.major, nativePredicates: false },
    params: {},
    ...(deps.config.context !== undefined ? { context: deps.config.context } : {}),
    cacheMode: deps.config.cache.mode,
  });
  const outcome = await asserter.assert(
    { id: step.id, text: step.text, options },
    {
      before,
      after,
      actionPreceded: state.windowBefore !== undefined,
      beforeTree: describeTree(before),
      afterTree: describeTree(after),
      key: checkKey({ text: step.text, driver: deps.driver.id, driverMajor: deps.driver.major }),
    },
  );
  if (outcome.status === 'passed') state.pendingCommits.push(() => asserter.pending());
  return {
    ...base,
    status: outcome.status === 'passed' ? 'passed' : 'failed',
    ...(outcome.check ? { check: outcome.check } : {}),
    ...(outcome.judge ? { judge: outcome.judge } : {}),
    evidence,
    durationMs: 0,
    ...(outcome.error ? { error: { ...outcome.error, retryable: false } } : {}),
  };
}

export function describeTree(observation: Observation): string {
  const lines: string[] = [];
  const walk = (nodes: Observation['nodes'], depth: number): void => {
    for (const node of nodes) {
      lines.push(`${'  '.repeat(depth)}${node.ref} ${node.role} "${node.name}"`);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(observation.nodes, 0);
  if (observation.route) lines.push(`route: ${observation.route}`);
  return lines.join('\n');
}

function redactObservation(observation: Observation): JsonValue {
  const { screenshot, ...rest } = observation;
  return { ...rest, ...(screenshot ? { screenshot: { sha256: screenshot.sha256, path: screenshot.path } } : {}) } as unknown as JsonValue;
}

export function lockKeyForStep(step: Step, kind: StepKind, kindSource: string): string {
  return lockKey({
    normalizedStepText: normalizeStepText(step.text),
    kind,
    kindClass: kindSource === 'keyword' ? 'explicit-keyword' : kindSource === 'directive' ? 'directive' : 'inferred',
  });
}

export function programsOf(programs: Array<ActProgram | CheckProgram>): string[] {
  return programs.map((program) => program.key);
}

export function runsDirFor(config: ResolvedConfig, runId: string): string {
  return join(config.projectRoot, config.evidence.dir, runId);
}

function kindSourceNeedsBinding(step: Step): boolean {
  return step.kindSource === 'default' || step.kindSource === 'prefix';
}
