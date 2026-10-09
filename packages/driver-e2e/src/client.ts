import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { JsonValue } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { e2eMcpArgs, mapE2eError, normalizeMaxSessions } from './verbs.js';
import { extractErrorCode, toolResultJson, toolResultText, type McpCaller, type McpToolResult, type OpenSessionResult } from './mcp.js';

export interface E2eMcpClientOptions {
  config?: string;
  target?: string;
  maxSessions?: number;
  /** Overrides the spawned command, e.g. `npx e2e`. */
  command?: string;
  commandArgs?: string[];
  env?: Record<string, string>;
}

/**
 * The real MCP client for `e2e mcp` (stdio). One child process is shared by the
 * driver, matching the e2e session model.
 */
export class E2eMcpClient implements McpCaller {
  private client: Client | undefined;
  private readonly options: E2eMcpClientOptions;

  constructor(options: E2eMcpClientOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    normalizeMaxSessions(this.options.maxSessions);
    const command = this.options.command ?? 'npx';
    const args = this.options.commandArgs ?? ['e2e', ...e2eMcpArgs(this.options)];
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', ...(this.options.env ?? {}) } as Record<string, string>,
    });
    const client = new Client({ name: 'ai-bdd', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new AiBddError('DRIVER_UNAVAILABLE', `could not start \`${command} ${args.join(' ')}\``, {
        details: { cause: String(error) },
      });
    }
    this.client = client;
  }

  private require(): Client {
    if (!this.client) throw new AiBddError('DRIVER_UNAVAILABLE', 'the e2e MCP client is not connected');
    return this.client;
  }

  private async callTool(name: string, args: Record<string, JsonValue>): Promise<McpToolResult> {
    const result = (await this.require().callTool({ name, arguments: args })) as McpToolResult;
    if (result.isError) {
      const code = mapE2eError(extractErrorCode(result)) ?? 'DRIVER_UNAVAILABLE';
      throw new AiBddError(code, toolResultText(result) || `${name} failed`);
    }
    return result;
  }

  async listCatalog(sessionId: string): Promise<string[]> {
    const result = await this.callTool('tools', { session_id: sessionId });
    const payload = toolResultJson(result);
    if (Array.isArray(payload)) return payload.map((item) => String((item as { name?: string }).name ?? item));
    if (payload && typeof payload === 'object' && Array.isArray((payload as { tools?: JsonValue }).tools)) {
      return ((payload as { tools: Array<string | { name: string }> }).tools).map((tool) =>
        typeof tool === 'string' ? tool : tool.name,
      );
    }
    return [];
  }

  async openSession(input: { target?: string; config?: string }): Promise<OpenSessionResult> {
    const args: Record<string, JsonValue> = {};
    const target = input.target ?? this.options.target;
    const config = input.config ?? this.options.config;
    if (target) args.target = target;
    if (config) args.config = config;
    const result = await this.callTool('open_session', args);
    const payload = toolResultJson(result);
    if (!payload || typeof payload !== 'object') {
      throw new AiBddError('DRIVER_INCOMPATIBLE', 'open_session did not return a session object');
    }
    const record = payload as Record<string, JsonValue>;
    const sessionId = String(record.session_id ?? record.sessionId ?? '');
    if (sessionId.length === 0) throw new AiBddError('DRIVER_INCOMPATIBLE', 'open_session returned no session id');
    const catalog = Array.isArray(record.tools) ? (record.tools as JsonValue[]).map(String) : [];
    const observation = typeof record.observation === 'string' ? record.observation : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    return {
      sessionId,
      catalog,
      ...(observation !== undefined ? { observation } : {}),
      ...(url !== undefined ? { url } : {}),
    };
  }

  async call(sessionId: string, tool: string, args: JsonValue): Promise<JsonValue> {
    const result = await this.callTool('call', { session_id: sessionId, tool, arguments: args });
    return toolResultJson(result);
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.callTool('close_session', { session_id: sessionId });
    } catch {
      // closing is best effort: the server may already have reaped the session
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = undefined;
    await client.close().catch(() => undefined);
  }
}
