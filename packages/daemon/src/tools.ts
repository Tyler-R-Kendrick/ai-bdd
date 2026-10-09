import type { JsonValue, StepResult } from '@ai-bdd/contracts';
import { AiBddError, TOOL_DEFINITIONS, TOOL_TABLE, type ToolShortName } from '@ai-bdd/contracts';
import type { SessionManager } from '@ai-bdd/runtime';

/** The object every tool call ultimately lands on. `SessionManager` satisfies it. */
export interface ToolBackend {
  health(): Promise<JsonValue>;
  openSession(input: never): Promise<JsonValue>;
  registerBindings(input: never): Promise<JsonValue>;
  resolveStep(input: never): Promise<JsonValue>;
  runStep(input: never): Promise<StepResult>;
  reportBindingResult(input: never): Promise<StepResult>;
  closeSession(input: never): Promise<JsonValue>;
}

export interface ToolCallResult {
  ok: boolean;
  value?: JsonValue;
  error?: { code: string; message: string; retryable: boolean; details?: JsonValue };
}

/**
 * Validates the input against the checked-in schema, calls the backend and
 * validates the output. Both the MCP server and the HTTP mirror go through this
 * one function, which is what makes the two surfaces equivalent (AC8).
 */
export async function callTool(
  short: ToolShortName,
  input: unknown,
  backend: ToolBackend,
  extras: { sessionManager?: SessionManager; projectRoot?: string } = {},
): Promise<ToolCallResult> {
  const definition = TOOL_TABLE[short];
  const parsed = definition.input.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: `${definition.name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
        retryable: false,
      },
    };
  }
  try {
    const value = await invoke(short, parsed.data as never, backend, extras);
    const output = definition.output.safeParse(value);
    if (!output.success) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: `${definition.name} produced an invalid result: ${output.error.issues.map((issue) => issue.message).join('; ')}`,
          retryable: false,
        },
      };
    }
    return { ok: true, value: output.data as JsonValue };
  } catch (error) {
    const payload = AiBddError.payload(error);
    return { ok: false, error: { code: payload.code, message: payload.message, retryable: payload.retryable, ...(payload.details !== undefined ? { details: payload.details } : {}) } };
  }
}

async function invoke(
  short: ToolShortName,
  input: never,
  backend: ToolBackend,
  extras: { sessionManager?: SessionManager; projectRoot?: string },
): Promise<JsonValue> {
  switch (short) {
    case 'health':
      return backend.health();
    case 'open_session':
      return backend.openSession(input);
    case 'register_bindings':
      return backend.registerBindings(input);
    case 'resolve_step':
      return backend.resolveStep(input);
    case 'run_step':
      return backend.runStep(input) as unknown as JsonValue;
    case 'report_binding_result':
      return backend.reportBindingResult(input) as unknown as JsonValue;
    case 'get_evidence': {
      const payload = input as { evidenceId: string };
      const found = extras.sessionManager?.readEvidence(payload.evidenceId);
      if (!found) {
        throw new AiBddError('INVALID_ARGUMENT', `unknown evidence id ${payload.evidenceId}`);
      }
      return { ...(payload as object), absolutePath: found.absolutePath } as unknown as JsonValue;
    }
    case 'close_session':
      return backend.closeSession(input);
    case 'run': {
      // `aibdd_run` runs specs natively; the daemon builds a runtime per call from
      // the same configuration, so an agent can drive a full run over MCP.
      throw new AiBddError('INTERNAL', 'aibdd_run must be handled by the caller (it needs the runtime factory)');
    }
    default:
      throw new AiBddError('INVALID_ARGUMENT', `unknown tool ${short}`);
  }
}

export { TOOL_DEFINITIONS, TOOL_TABLE };
export type { ToolShortName };
