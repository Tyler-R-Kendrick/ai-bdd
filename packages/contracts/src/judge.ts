import type { ImageInput } from './models.js';
import type { JsonValue } from './primitives.js';

/**
 * Judge input. This type deliberately has no field that can carry agent
 * transcripts, tool calls, or action summaries (R-K3a). The unit test
 * `judge-request-isolates-actor-output` enforces the shape.
 */
export interface JudgeRequest {
  criterion: string;
  /** True when an action step preceded this check (section 6.2). */
  actionPreceded: boolean;
  beforeImages: ImageInput[];
  afterImages: ImageInput[];
  beforeTrees: string[];
  afterTrees: string[];
  /** App vocabulary from config.context. */
  context?: string;
  /** Step parameters, so the criterion's placeholders can be resolved. */
  params?: Record<string, JsonValue>;
  driver: string;
  promptVersion?: string;
}

export type JudgeSampleVerdict = 'holds' | 'fails' | 'cannot_tell';

export interface JudgeSample {
  probability: number;
  verdict: JudgeSampleVerdict;
  explanation: string;
  observed: string;
  /** True when the sample was contradictory and replaced by 0.5 (section 8.4). */
  contradictory?: boolean;
}

export type JudgeOutcome = 'pass' | 'fail' | 'inconclusive';

export interface JudgeVerdict {
  score: number;
  verdict: JudgeOutcome;
  samples: JudgeSample[];
  /** max(sample) - min(sample). Above `maxSpread` the verdict is inconclusive. */
  spread: number;
  modelId: string;
  promptVersion: string;
  cacheKey: string;
  reused: boolean;
  reason?: string;
  evidenceIds?: string[];
}

export interface JudgeConfig {
  passThreshold: number;
  failThreshold: number;
  samples: number;
  maxSpread: number;
  vision: boolean;
  maxTreeChars: number;
}

export interface CalibrationLabel {
  judgmentId: string;
  truth: boolean;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  positives: number;
  meanScore: number;
  accuracy: number;
}

export interface CalibrationReport {
  count: number;
  ece: number;
  brier: number;
  bins: CalibrationBin[];
  recommended: { passThreshold: number; failThreshold: number };
}
