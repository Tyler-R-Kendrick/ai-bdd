import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { JsonValue } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { mapCuaError } from './tools.js';
import type { McpCaller } from './mcp.js';

export interface CuaMcpClientOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CuaToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/**
 * The MCP stdio client for `cua-driver mcp`.
 *
 * Typed contract tools are called through MCP `tools/call`; an error result is
 * mapped onto an AiBddError through the Cua code table so the runtime can classify
 * it (POLICY_DENIED, PIXEL_TAINTED, SESSION_LIMIT, ...).
 */
export class CuaMcpClient implements McpCaller {
  private client: Client | undefined;
  private readonly options: CuaMcpClientOptions;

  constructor(options: CuaMcpClientOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: this.options.command ?? 'cua-driver',
      args: this.options.args ?? ['mcp'],
      env: { ...process.env, ...(this.options.env ?? {}) } as Record<string, string>,
    });
    const client = new Client({ name: 'ai-bdd', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new AiBddError('DRIVER_UNAVAILABLE', `could not start \`${this.options.command ?? 'cua-driver'}\``, {
        details: { cause: String(error) },
      });
    }
    this.client = client;
  }

  async listTools(): Promise<string[]> {
    await this.connect();
    const listed = await this.client!.listTools();
    return listed.tools.map((tool) => tool.name);
  }

  async call(tool: string, args: JsonValue): Promise<JsonValue> {
    await this.connect();
    const result = (await this.client!.callTool({
      name: tool,
      arguments: args as Record<string, unknown>,
    })) as CuaToolResult;
    const text = (result.content ?? []).map((part) => part.text ?? '').join('\n').trim();
    if (result.isError) {
      const code = mapCuaError(/\b([A-Z_]{4,})\b/u.exec(text)?.[1]) ?? 'DRIVER_UNAVAILABLE';
      throw new AiBddError(code, text);
    }
    if (result.structuredContent !== undefined) return result.structuredContent as JsonValue;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }
}
