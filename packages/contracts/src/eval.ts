import type { ImageInput } from './models.js';
import type { JsonValue } from './primitives.js';

/**
 * A rubric turns a subjective expectation into a decision.
 *
 * Determinism chooses the path: a step that replays reproducibly is a *test* and its
 * assertion is a `CheckProgram`; a step whose outcome is inherently subjective is an
 * *eval* and its assertion is a rubric scored by a model.
 */
export interface Rubric {
  /** What is being judged, in one sentence (the criterion text). */
  criterion: string;
  /** The ordered levels of the scale, worst to best. */
  scale: RubricLevel[];
  /** The level a verdict must reach to pass. */
  passLevel: string;
  /** The level at or below which a verdict fails. */
  failLevel: string;
  /** How many independent samples to take (default 3). */
  samples?: number;
  /** Extra guidance for the judge, never derived from the acting agent. */
  notes?: string[];
}

export interface RubricLevel {
  /** A short id, e.g. `0`, `1`, `2`. */
  id: string;
  /** What this level means, written so two humans would score the same. */
  anchor: string;
  /** Optional reference score for this level, in [0,1]. */
  score?: number;
}

/**
 * The decision model a judge uses.
 *
 * The name follows the JEV convention the specification refers to: a *structured,
 * anchored decision* rather than a bare number. The model must pick a level from the
 * rubric, state a probability for its own decision, and cite the observation — so a
 * reviewer can see why a verdict came out the way it did.
 */
export interface DecisionModel {
  /** The rubric the decision is made against. */
  rubric: Rubric;
  /** Require the model to name the level, not just a probability. */
  requireLevel: boolean;
  /** Require the model to cite evidence from the observation. */
  requireCitation: boolean;
  /** Treat a missing or unparsable level as `inconclusive` rather than a failure. */
  lenientOnParse?: boolean;
}

export interface EvalSample {
  levelId: string;
  probability: number;
  /** The observation excerpt the model cited. */
  citation: string;
  explanation: string;
  /** True when the model's probability contradicted its own level choice. */
  contradictory?: boolean;
}

export type EvalDecision = 'pass' | 'fail' | 'inconclusive' | 'needs-review';

export interface EvalVerdict {
  decision: EvalDecision;
  /** Mean of the sample scores, in [0,1]. */
  score: number;
  /** The level the majority of samples picked. */
  levelId: string;
  samples: EvalSample[];
  /** max(sample) - min(sample). */
  spread: number;
  modelId: string;
  promptVersion: string;
  cacheKey: string;
  reused: boolean;
  reason?: string;
  evidenceIds?: string[];
  /** True when the samples disagreed about the level, not just the score. */
  levelDisagreement?: boolean;
}

/** What goes into an eval. It has no channel for the acting agent's reasoning. */
export interface EvalRequest {
  hypothesis: string;
  decisionModel: DecisionModel;
  /** The criterion text, when it differs from the rubric criterion. */
  criterion?: string;
  beforeImages: ImageInput[];
  afterImages: ImageInput[];
  beforeTrees: string[];
  afterTrees: string[];
  context?: string;
  params?: Record<string, JsonValue>;
  driver: string;
  promptVersion?: string;
}

/** A human label, for calibration of the decision model. */
export interface EvalLabel {
  evalId: string;
  truth: boolean;
}