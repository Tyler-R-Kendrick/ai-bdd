import type { Observation } from './driver.js';
import type { Diagnostic } from './primitives.js';
import type { ScenarioResult, StepResult } from './results.js';

/** Events emitted by the runtime, consumed by reporters and the CLI. */
export type RunEvent =
  | { type: 'run:start'; runId: string; at: string; specs: string[]; driver?: string }
  | { type: 'spec:parsed'; uri: string; dialect: 'gauge' | 'gherkin'; scenarios: number; diagnostics: Diagnostic[] }
  | { type: 'scenario:start'; scenarioId: string; name: string; tags: string[]; at: string }
  | { type: 'scenario:end'; scenarioId: string; result: ScenarioResult; at: string }
  | { type: 'step:start'; scenarioId: string; stepId: string; text: string; kind: string; at: string }
  | { type: 'step:end'; scenarioId: string; result: StepResult; at: string }
  | { type: 'observation'; stepId: string; observation: Observation; settled: boolean; at: string }
  | { type: 'judge'; stepId: string; score: number; verdict: string; samples: number; at: string }
  | { type: 'cache'; stepId: string; mode: string; key?: string; at: string }
  | { type: 'resolution'; stepId: string; resolutionType: string; lockStatus?: string; at: string }
  | { type: 'diagnostic'; diagnostic: Diagnostic; at: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; at: string }
  | { type: 'run:end'; runId: string; exitCode: number; at: string };

export type RunEventType = RunEvent['type'];
