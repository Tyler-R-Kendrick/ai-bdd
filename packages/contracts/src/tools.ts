import type { BindingDescriptor } from './bindings.js';
import type { Capabilities } from './driver.js';
import type { DriverConfig } from './config.js';
import type { EvidenceRecord } from './evidence.js';
import type { JsonValue, SourceLocation, StepArg, StepKind, StepOptions } from './primitives.js';
import type { Resolution, ResolutionResult } from './resolution.js';
import type { RunReport, ScenarioResult, StepResult } from './results.js';
import type { AiBddErrorPayload } from './errors.js';

/** The protocol version of the daemon tool contract. */
export const DAEMON_PROTOCOL = 1;

export interface PluginInfo {
  name: string;
  version: string;
  language: string;
}

export interface HealthInput {}
export interface HealthOutput {
  ok: true;
  version: string;
  drivers: Array<{ name: string; ok: boolean; problems: string[] }>;
  protocol: number;
}

export interface OpenSessionInput {
  scenarioId: string;
  scenarioName: string;
  tags: string[];
  driver?: string;
  target?: JsonValue;
  plugin: PluginInfo;
}
export interface OpenSessionOutput {
  sessionId: string;
  traceId: string;
  driver: string;
  capabilities: Capabilities;
}

export interface RegisterBindingsInput {
  sessionId?: string;
  provider: string;
  bindings: BindingDescriptor[];
}
export interface RegisterBindingsOutput {
  bindingSetHash: string;
  accepted: number;
  rejected: Array<{ id: string; reason: string }>;
}

/** The step payload shared by resolve/run/report tools. */
export interface StepPayload {
  text: string;
  keyword?: string;
  kind?: StepKind;
  args?: StepArg[];
  location?: SourceLocation;
  options?: StepOptions;
  /** Stable id assigned by the plugin, used to correlate results. */
  stepId?: string;
  scenarioId?: string;
}

export interface ResolveStepInput {
  sessionId: string;
  step: StepPayload;
}
export interface ResolveStepOutput {
  resolution: Resolution;
  kind: StepKind;
  kindSource: ResolutionResult['kindSource'];
  next: 'invoke-local' | 'run-step' | 'fail';
  error?: AiBddErrorPayload;
}

export interface RunStepInput {
  sessionId: string;
  step: StepPayload;
  resolution?: Resolution;
}
export type RunStepOutput = StepResult;

export interface ReportBindingResultInput {
  sessionId: string;
  stepId?: string;
  step: StepPayload;
  bindingId: string;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: { message: string; stack?: string };
  judgeAfter?: boolean;
}
export type ReportBindingResultOutput = StepResult;

export interface GetEvidenceInput {
  runId?: string;
  evidenceId: string;
}
export type GetEvidenceOutput = EvidenceRecord & { absolutePath: string };

export interface CloseSessionInput {
  sessionId: string;
  status: 'passed' | 'failed' | 'skipped';
}
export interface CloseSessionOutput {
  scenarioResult: ScenarioResult;
}

export interface RunInput {
  globs?: string[];
  tags?: string;
  driver?: string;
  frozen?: boolean;
  driverConfig?: Record<string, DriverConfig>;
  projectRoot?: string;
}
export type RunOutput = RunReport;

export interface ToolIoMap {
  health: { input: HealthInput; output: HealthOutput };
  open_session: { input: OpenSessionInput; output: OpenSessionOutput };
  register_bindings: { input: RegisterBindingsInput; output: RegisterBindingsOutput };
  resolve_step: { input: ResolveStepInput; output: ResolveStepOutput };
  run_step: { input: RunStepInput; output: RunStepOutput };
  report_binding_result: { input: ReportBindingResultInput; output: ReportBindingResultOutput };
  get_evidence: { input: GetEvidenceInput; output: GetEvidenceOutput };
  close_session: { input: CloseSessionInput; output: CloseSessionOutput };
  run: { input: RunInput; output: RunOutput };
}

export type ToolShortName = keyof ToolIoMap;

/** MCP tool names use only [a-z0-9_] (F-M2). */
export function toolName(short: ToolShortName): `aibdd_${ToolShortName}` {
  return `aibdd_${short}`;
}

export const TOOL_SHORT_NAMES = [
  'health',
  'open_session',
  'register_bindings',
  'resolve_step',
  'run_step',
  'report_binding_result',
  'get_evidence',
  'close_session',
  'run',
] as const satisfies readonly ToolShortName[];
