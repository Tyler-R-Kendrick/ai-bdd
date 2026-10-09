import type { JsonValue } from '@ai-bdd/contracts';

export interface OpenSessionResult {
  sessionId: string;
  /** The catalog of tools the session can run. */
  catalog: string[];
  /** The first observation, as text, when the server returns one. */
  observation?: string;
  url?: string;
}

/**
 * The narrow MCP surface the driver needs. The real implementation wraps
 * `@modelcontextprotocol/client`; tests inject a recorded transcript, so CI
 * needs no e2e install (section 11.2).
 */
export interface McpCaller {
  /** The session tool catalog, read from the `tools` MCP tool. */
  listCatalog(sessionId: string): Promise<string[]>;
  openSession(input: { target?: string; config?: string }): Promise<OpenSessionResult>;
  call(sessionId: string, tool: string, args: JsonValue): Promise<JsonValue>;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Extracts the text payload of an MCP tool result. */
export function toolResultText(result: McpToolResult): string {
  return (result.content ?? [])
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

/** Parses a JSON tool result, falling back to the raw text. */
export function toolResultJson(result: McpToolResult): JsonValue {
  const text = toolResultText(result);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/** Reads an error code out of an e2e error message or payload. */
export function extractErrorCode(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const match = /\b(PIXEL_TAINTED|POLICY_DENIED|SESSION_OPEN|CONFIG_IN_USE|ENGINE_IN_USE|NO_SESSION)\b/u.exec(text);
  return match?.[1];
}
