import type { Action, ArtifactRef, Observation, Selector } from './driver.js';
import type { EvidenceKind } from './evidence.js';
import type { EffectSignature, StartFingerprint } from './programs.js';
import type { EvidenceRef } from './results.js';
import type { JsonValue, StepKind } from './primitives.js';
import type { Rubric } from './eval.js';

/**
 * The act-actor SPI.
 *
 * An *actor* is whatever turns an intent into driver actions. The core never calls a
 * specific vendor: `e2e`'s own `agent.act`, a model loop over the Playwright driver,
 * Cua's grounding scorer and a scripted fake are all implementations of this one
 * interface, so a project swaps providers without touching a spec or a binding.
 */
export interface ActIntent {
  /** The sentence a human wrote, after parameter substitution. */
  text: string;
  kind: StepKind;
  /** Resolved binding parameters, when the step had a binding. */
  params: Record<string, JsonValue>;
  /** The data row values, when the scenario is data-driven. */
  dataRow?: string[];
}

export interface ActBudget {
  maxActions: number;
  maxModelCalls: number;
  /** Wall-clock ceiling for the whole step. */
  timeoutMs?: number;
}

export interface ActPolicy {
  allowHosts: string[];
  denyVerbs: string[];
  cua?: { allowApps: string[] };
}

/** One action a reproduction will replay, with the selector that finds it again. */
export interface RecordedAction {
  verb: Action['verb'];
  selector?: Selector;
  /** A literal, or a slot filled from a step parameter or secret at replay time. */
  value?: { literal: string } | { param: string } | { secret: string };
  params?: JsonValue;
  delivery?: 'background' | 'foreground';
}

export type Determinism = 'deterministic' | 'non-deterministic' | 'unknown';


/**
 * The recorded, replayable form of one step.
 *
 * This is the intermediate lockfile entry: it is what makes a characterization run
 * reproducible. It holds the actions in order, the effect that must be newly true for
 * a replay to count, the evidence produced, and whether the step is deterministic
 * (replay + verify) or non-deterministic (rubric eval).
 */
export interface StepReproduction {
  /** Stable key: normalized intent + kind + driver class (never the driver id). */
  key: string;
  intent: ActIntent;
  actorId: string;
  actorVersion: string;
  driverId: string;
  driverMajor: number;
  target?: string;
  start: StartFingerprint;
  actions: RecordedAction[];
  effect: EffectSignature;
  determinism: Determinism;
  rubric?: Rubric;
  evidence: EvidenceRef[];
  modelCalls: number;
  recordedAt: string;
  /** True until a later assertion in the same scenario passes. */
  pending?: boolean;
  /** Set when a human corrected this step; the reproduction includes their actions. */
  correctedBy?: string;
}

/** The committed record of every step that needed an actor, for reproduction. */
export interface ReproductionLock {
  version: 1;
  generator: string;
  steps: StepReproduction[];
}

/** A request for a human to correct or confirm the actor. */
export interface HandoffRequest {
  reason: HandoffReason;
  /** What the actor was trying to do. */
  intent: string;
  /** What went wrong, in one sentence. */
  message: string;
  /** What the actor did before stopping, so a human can see the state. */
  attempted: RecordedAction[];
  /** The observation it stopped on. */
  observation: Observation;
  /** A screenshot reference, for a terminal that can show one. */
  screenshot?: ArtifactRef;
  /** Concrete choices, when the actor can enumerate them. */
  choices?: string[];
}

export type HandoffReason =
  | 'stuck'
  | 'ambiguous-target'
  | 'budget-exhausted'
  | 'policy-refused'
  | 'assertion-unclear'
  | 'driver-error';

export interface UserCorrection {
  /** Free-form guidance, fed to the next attempt. */
  guidance?: string;
  /** A choice the user picked from `choices`. */
  choice?: string;
  /** Actions the user performed by hand, recorded as the reproduction. */
  actions?: RecordedAction[];
  /** The user says the step needs no action after all. */
  skip?: boolean;
}

export interface ActCapabilities {
  /** The provider drives the UI itself (it owns an agent loop). */
  drivesUi: boolean;
  /** The provider can record a replayable reproduction. */
  records: boolean;
  /** The provider can ask a human for help. */
  handoff: boolean;
  /** The provider can produce a video capture. */
  video: boolean;
  /** Extra evidence kinds the provider emits. */
  evidence: EvidenceKind[];
}

export interface ActSessionRef {
  sessionId: string;
  driverId: string;
  driverMajor: number;
  target?: JsonValue;
  /** True when the session captured a secret, so pixels must be withheld. */
  tainted: boolean;
}

export interface ActRequest {
  intent: ActIntent;
  session: ActSessionRef;
  /** The settled observation the step starts from. */
  observation: Observation;
  budget: ActBudget;
  policy: ActPolicy;
  /** App vocabulary from config.context, for grounding and prompts. */
  context?: string;
  secrets?: Record<string, string>;
  /** The previous reproduction for this step, when the lockfile has one. */
  previous?: StepReproduction;
  /** A correction the user supplied after a failed attempt. */
  correction?: UserCorrection;
  /** Called around each action, for write-ahead logging. */
  onAction?: (action: RecordedAction, phase: 'will-perform' | 'performed') => Promise<void>;
  /** Called when the actor wants a human to decide. */
  onHandoff?: (request: HandoffRequest) => Promise<UserCorrection | undefined>;
}

export interface ActResult {
  status: 'done' | 'blocked' | 'handoff' | 'budget-exhausted';
  summary?: string;
  actions: RecordedAction[];
  effect?: EffectSignature;
  start?: StartFingerprint;
  modelCalls: number;
  /** Set when the provider already knows how to classify the step. */
  determinism?: Determinism;
  /** Set when the actor stopped to ask a human. */
  handoff?: HandoffRequest;
  error?: { code: string; message: string; retryable?: boolean };
  /** Evidence the provider produced while acting. */
  evidence?: EvidenceRef[];
}

/**
 * One implementation of "turn an intent into driver actions".
 *
 * Providers are registered by id (`e2e`, `playwright`, `cua`, `fake`, `model`) and
 * selected per run or per step, so a project can start with one and swap it later.
 */
export interface ActActor {
  id: string;
  version: string;
  capabilities: ActCapabilities;
  act(request: ActRequest): Promise<ActResult>;
}

/** The registry a runtime resolves an actor from. */
export interface ActActorRegistry {
  register(actor: ActActor): void;
  get(id: string): ActActor | undefined;
  list(): Array<{ id: string; version: string; capabilities: ActCapabilities }>;
  /** The actor used when a step does not name one. */
  default(): ActActor | undefined;
  setDefault(id: string): void;
}
