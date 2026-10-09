import type { JsonValue } from '@ai-bdd/contracts';
import { TOOL_DEFINITIONS, type ToolShortName } from '@ai-bdd/contracts';
import { McpServer } from '@modelcontextprotocol/server';
import { stdioTransport } from './transport.js';
import { callTool, type ToolBackend } from './tools.js';

export interface McpSurfaceOptions {
  backend: ToolBackend;
  /** Called for `aibdd_run`. */
  runSpecs?: (input: unknown, traceparent?: string) => Promise<JsonValue>;
  version?: string;
}

/**
 * Registers the tool table on an MCP server.
 *
 * The JSON Schema handed to MCP comes from the same zod schema the HTTP mirror
 * validates against, and a test asserts the registered schema is byte-identical
 * to the checked-in file, so the two surfaces cannot drift (AC8).
 */
export function createMcpServer(options: McpSurfaceOptions): McpServer {
  const server = new McpServer({ name: 'ai-bdd', version: options.version ?? '0.1.0' });

  for (const definition of TOOL_DEFINITIONS) {
    // The tool table is dynamic, so the SDK's generic call signature is widened
    // here; the runtime shape is enforced by the zod schemas on both sides.
    const handler = async (input: unknown, ctx: unknown): Promise<unknown> => {
      const traceparent = (ctx as { _meta?: { traceparent?: string } } | undefined)?._meta?.traceparent;
      if (definition.short === 'run' && options.runSpecs) {
        const value = await options.runSpecs(input, traceparent);
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
      }
      const result = await callTool(definition.short, input, options.backend);
      if (!result.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result.error) }] };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.value ?? null) }],
        structuredContent: (result.value ?? {}) as Record<string, unknown>,
      };
    };
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.input,
        outputSchema: definition.output,
      } as never,
      handler as never,
    );
  }

  return server;
}

/** MCP over stdio, for agents and IDEs (`ai-bdd serve --stdio`). */
export async function serveStdioMcp(options: McpSurfaceOptions): Promise<{ close(): Promise<void> }> {
  const server = createMcpServer(options);
  const transport = await stdioTransport();
  await server.connect(transport as never);
  return { close: () => server.close() };
}

export { createMcpServer as createServer };
