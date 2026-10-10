import type {
  ActRequest,
  AiBddError,
  AiBddErrorPayload,
  ArtifactRef,
  CheckEvaluation,
  Driver,
  DriverSession,
  FuzzyReason,
  JudgeVerdict,
  Observation,
  RunEvent,
  RunnerDeps,
  ScenarioRunOptions,
  ScenarioTarget,
  SettleOptions,
  Step,
  StepPath,
  StepRecording,
  StepResult,
  StepStatus,
  Usage,
} from '../contracts/index.ts';
import type { ObservationRing } from './support.ts';

export type Phase = 'main' | 'confirm';

/** Everything that stays constant while one scenario runs. */
export interface ScenarioEnv {
  deps: RunnerDeps;
  target: ScenarioTarget;
  opts: ScenarioRunOptions;
  driver: Driver | undefined;
  settleOpts: SettleOptions;
  fuzzyTagged: boolean;
  /** `read-write` is the only mode in which recordings are created or updated. */
  writable: boolean;
  emit(event: RunEvent): void;
}

/** Shared with the session's `resolveValue` closure. */
export interface ResolveHolder {
  params: Record<string, string>;
  secretError: AiBddError | undefined;
}

/** One open session plus the per-session bookkeeping of the step pipeline. */
export interface SessionState {
  session: DriverSession;
  holder: ResolveHolder;
  ring: ObservationRing;
  /** The settled observation taken right after session setup (§9.2.4). */
  firstObs: Observation;
  /** Settled observation captured immediately before the first action of the latest contiguous action run (§9.6). */
  lastRunBefore: Observation | undefined;
  /**
   * Whether `lastRunBefore` was captured on a settled screen. An unsettled baseline cannot show that a check is
   * discriminative (the page may have been mid-load), so it blocks deterministic check generation (R-AS1, R-RN1).
   */
  lastRunBeforeSettled: boolean;
  inRun: boolean;
  cleanups: { name: string; run(): Promise<void> }[];
  priorSteps: ActRequest['priorSteps'];
}

/** The pending recording being assembled; index-aligned with `scenario.steps`. */
export interface PendingSink {
  entries: (StepRecording | undefined)[];
  /** True when any step was characterized or healed (a pending recording exists, §9.7.2). */
  dirty: boolean;
  reclassified: string[];
}

export interface StepAcc {
  usage: Usage;
  actions: number;
  evidence: ArtifactRef[];
  finalObs: Observation | undefined;
  judged: boolean;
}

export interface StepBody {
  status: StepStatus;
  path: StepPath;
  determinism: StepResult['determinism'];
  fuzzyReasons: FuzzyReason[];
  error?: AiBddErrorPayload;
  check?: CheckEvaluation;
  judge?: JudgeVerdict;
}

export interface StepCtx {
  env: ScenarioEnv;
  st: SessionState;
  step: Step;
  idx: number;
  /** Valid recording of this step: from the loaded prefix (main) or the pending recording (confirm). */
  rec: StepRecording | undefined;
  phase: Phase;
  sink: PendingSink;
  acc: StepAcc;
}
