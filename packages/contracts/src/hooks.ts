import type { Observation } from './driver.js';

export interface VisualGateContext {
  stepId: string;
  scenarioId: string;
  before: Observation;
  after: Observation;
  /** Screenshot bytes, when the driver produced pixels. */
  beforePng?: Uint8Array;
  afterPng?: Uint8Array;
}

export interface VisualGateDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Hook interface for an external visual-diff gate (G15). The gate itself is
 * out of scope: ai-bdd ships a no-op implementation and tests the contract.
 */
export interface VisualGate {
  name: string;
  check(ctx: VisualGateContext): Promise<VisualGateDecision>;
}

export interface Hooks {
  visualGate?: VisualGate;
}
