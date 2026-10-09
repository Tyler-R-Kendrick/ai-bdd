import type { CacheOutcome, PredicateResult } from './programs.js';
import type { JudgeVerdict } from './judge.js';
import type { EvidenceKind } from './evidence.js';
import type { Diagnostic, KindSource, SourceLocation, Status, StepKind } from './primitives.js';
import type { Resolution } from './resolution.js';
import type { AiBddErrorPayload } from './errors.js';
import type { CostSummary } from './models.js';

export interface EvidenceRef {
  evidenceId: string;
  kind: EvidenceKind;
  sha256?: string;
  path?: string;
}

export interface CheckOutcome {
  programKey?: string;
  results: PredicateResult[];
  status: 'passed' | 'failed' | 'skipped';
  invariant?: boolean;
  judgeOnly?: boolean;
  generated?: boolean;
  attempts?: number;
}

export interface HealingInfo {
  reason: string;
  replayedActions: number;
  totalActions: number;
}

export interface StepResult {
  stepId: string;
  text: string;
  kind: StepKind;
  kindSource: KindSource;
  phase?: 'context' | 'scenario' | 'teardown';
  status: Status;
  resolution: Resolution;
  cache?: CacheOutcome;
  check?: CheckOutcome;
  judge?: JudgeVerdict;
  healing?: HealingInfo;
  evidence: EvidenceRef[];
  durationMs: number;
  traceId?: string;
  traceparent?: string;
  modelCalls?: number;
  error?: AiBddErrorPayload;
  notes?: string[];
  location?: SourceLocation;
  conceptChain?: string[];
}

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  specName: string;
  uri: string;
  tags: string[];
  dataRow?: string[];
  status: Status;
  steps: StepResult[];
  durationMs: number;
  traceId?: string;
  driver?: string;
  error?: AiBddErrorPayload;
}

export interface RunStats {
  scenarios: number;
  passed: number;
  failed: number;
  healed: number;
  skipped: number;
  steps: number;
  judgeOnly: number;
  semanticResolutions: number;
  actReplays: number;
  heals: number;
  modelCalls: number;
}

export interface LockSummary {
  added: number;
  changed: number;
  revalidated: number;
  unchanged: number;
  ambiguous: number;
}

export interface RunReport {
  runId: string;
  version: string;
  startedAt: string;
  finishedAt: string;
  status: Status;
  driver?: string;
  scenarios: ScenarioResult[];
  stats: RunStats;
  cost?: CostSummary;
  lock?: LockSummary;
  diagnostics: Diagnostic[];
  exitCode: number;
  frozen?: boolean;
  strictCache?: boolean;
  runDir?: string;
  rootHash?: string;
}
