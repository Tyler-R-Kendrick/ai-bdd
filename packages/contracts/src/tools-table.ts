import type { z } from 'zod';
import {
  CloseSessionInputSchema,
  CloseSessionOutputSchema,
  GetEvidenceInputSchema,
  GetEvidenceOutputSchema,
  HealthInputSchema,
  HealthOutputSchema,
  OpenSessionInputSchema,
  OpenSessionOutputSchema,
  RegisterBindingsInputSchema,
  RegisterBindingsOutputSchema,
  ReportBindingResultInputSchema,
  ReportBindingResultOutputSchema,
  ResolveStepInputSchema,
  ResolveStepOutputSchema,
  RunInputSchema,
  RunOutputSchema,
  RunStepInputSchema,
  RunStepOutputSchema,
} from './tools-schemas.js';
import { TOOL_SHORT_NAMES, type ToolShortName } from './tools.js';

export interface ToolDefinition {
  short: ToolShortName;
  /** MCP tool name: `aibdd_<short>` (F-M2). */
  name: string;
  /** HTTP JSON mirror path. */
  path: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
}

/**
 * One table drives the MCP server, the HTTP mirror and the checked-in JSON
 * Schemas, so the surfaces cannot diverge (R-K12a, AC8).
 */
export const TOOL_TABLE: Record<ToolShortName, ToolDefinition> = {
  health: {
    short: 'health',
    name: 'aibdd_health',
    path: '/v1/health',
    description: 'Report daemon version, protocol version and driver self-check status.',
    input: HealthInputSchema,
    output: HealthOutputSchema,
  },
  open_session: {
    short: 'open_session',
    name: 'aibdd_open_session',
    description: 'Open one driver session for one scenario instance.',
    path: '/v1/open_session',
    input: OpenSessionInputSchema,
    output: OpenSessionOutputSchema,
  },
  register_bindings: {
    short: 'register_bindings',
    name: 'aibdd_register_bindings',
    description: 'Register bindings published by a language plugin.',
    path: '/v1/register_bindings',
    input: RegisterBindingsInputSchema,
    output: RegisterBindingsOutputSchema,
  },
  resolve_step: {
    short: 'resolve_step',
    name: 'aibdd_resolve_step',
    description: 'Resolve a step to a binding, a semantic match, or the agent.',
    path: '/v1/resolve_step',
    input: ResolveStepInputSchema,
    output: ResolveStepOutputSchema,
  },
  run_step: {
    short: 'run_step',
    name: 'aibdd_run_step',
    description: 'Run a step through the daemon (act loop, checks and judge).',
    path: '/v1/run_step',
    input: RunStepInputSchema,
    output: RunStepOutputSchema,
  },
  report_binding_result: {
    short: 'report_binding_result',
    name: 'aibdd_report_binding_result',
    description: 'Report the outcome of a locally executed binding.',
    path: '/v1/report_binding_result',
    input: ReportBindingResultInputSchema,
    output: ReportBindingResultOutputSchema,
  },
  get_evidence: {
    short: 'get_evidence',
    name: 'aibdd_get_evidence',
    description: 'Fetch one evidence record and its artifact path.',
    path: '/v1/get_evidence',
    input: GetEvidenceInputSchema,
    output: GetEvidenceOutputSchema,
  },
  close_session: {
    short: 'close_session',
    name: 'aibdd_close_session',
    description: 'Close a session and return the scenario result.',
    path: '/v1/close_session',
    input: CloseSessionInputSchema,
    output: CloseSessionOutputSchema,
  },
  run: {
    short: 'run',
    name: 'aibdd_run',
    description: 'Run specs natively inside the daemon.',
    path: '/v1/run',
    input: RunInputSchema,
    output: RunOutputSchema,
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_SHORT_NAMES.map((short) => TOOL_TABLE[short]);
