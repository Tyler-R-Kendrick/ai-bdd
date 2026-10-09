import type { JsonValue } from '@ai-bdd/contracts';

/** The narrow MCP surface a Cua driver needs. */
export interface McpCaller {
  listTools(): Promise<string[]>;
  call(tool: string, args: JsonValue): Promise<JsonValue>;
  close(): Promise<void>;
}
