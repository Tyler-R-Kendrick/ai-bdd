// @ts-nocheck
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AiBddError } from '@ai-bdd/sdk/contracts';

/** A decoded image block of a tool result (screenshots). */
export interface CuaImage { data: Uint8Array; mimeType: string }

/**
 * One tool result of `cua-driver`, normalized. A call has `failed` set when the MCP result is flagged as an error or when
 * the driver *refused* the action (`structuredContent.status === 'refused'`, e.g. a stale element token). `code` is the
 * driver's machine-readable reason (`background_unavailable`, `stale_element_token`, ...) when it gave one.
 */
export interface CuaToolResult {
  failed: boolean;
  code?: string;
  text: string;
  structured: Record<string, unknown>;
  images: CuaImage[];
}

/** The seam to a running `cua-driver`. The product implementation speaks MCP over stdio (`cua-driver mcp`). */
export interface CuaClient {
  /** Names of the tools the connected driver serves. */
  readonly tools: ReadonlySet<string>;
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<CuaToolResult>;
  close(): Promise<void>;
}

export interface CuaLaunch {
  /** Executable that serves MCP on stdio. Default `cua-driver`. */
  command: string;
  /** Arguments. Default `['mcp']`. */
  args: string[];
  /** Extra environment for the driver process (on top of the display, accessibility-bus and locale variables). */
  env: Record<string, string>;
}

export const DEFAULT_CUA_LAUNCH: CuaLaunch = { command: 'cua-driver', args: ['mcp'], env: {} };

const ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'TZ', 'DISPLAY', 'XAUTHORITY',
  'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'GTK_MODULES', 'ACCESSIBILITY_ENABLED', 'NO_AT_BRIDGE', 'SYSTEMROOT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'WINDIR',
]);
const ENV_PREFIXES = ['LC_', 'XDG_', 'CUA_', 'AT_SPI_'];

/**
 * The environment handed to cua-driver and to the apps it drives: what a desktop process needs (display, session bus,
 * accessibility bus, locale, paths) and nothing else. Provider keys and the secrets of a test run stay out.
 */
export function desktopEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (ENV_EXACT.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

const INSTALL_HINT = 'install Cua Driver (https://cua.ai/docs/cua-driver/quickstart) or set the "cuaDriver.command" option';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalize an MCP `CallToolResult` (kept loosely typed: the product's structured output is data, not a contract we own). */
export function normalizeResult(raw: unknown): CuaToolResult {
  const res = isRecord(raw) ? raw : {};
  const structured = isRecord(res['structuredContent']) ? res['structuredContent'] : {};
  const content = Array.isArray(res['content']) ? (res['content'] as unknown[]) : [];
  const texts: string[] = [];
  const images: CuaImage[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') texts.push(block['text']);
    else if (block['type'] === 'image' && typeof block['data'] === 'string') {
      images.push({ data: new Uint8Array(Buffer.from(block['data'], 'base64')), mimeType: typeof block['mimeType'] === 'string' ? block['mimeType'] : 'image/png' });
    }
  }
  const refusal = isRecord(structured['refusal']) ? structured['refusal'] : undefined;
  const refused = structured['status'] === 'refused';
  const failed = res['isError'] === true || refused;
  const codeCandidate = refusal?.['code'] ?? structured['code'];
  const text = texts.join('\n');
  const message = typeof refusal?.['message'] === 'string' ? refusal['message'] : typeof structured['detail'] === 'string' ? structured['detail'] : undefined;
  return {
    failed,
    ...(failed && typeof codeCandidate === 'string' ? { code: codeCandidate } : {}),
    text: failed && message !== undefined && text.length === 0 ? message : text,
    structured,
    images,
  };
}

/** The MCP-over-stdio client for the real `cua-driver`. */
export class McpStdioCuaClient implements CuaClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly stderrTail: string[] = [];
  private closed = false;
  tools: ReadonlySet<string> = new Set();

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  /** Spawn the driver and perform the MCP handshake. Failures are `DRIVER_UNAVAILABLE` with an actionable message. */
  static async connect(launch: CuaLaunch = DEFAULT_CUA_LAUNCH, env: Record<string, string | undefined> = process.env): Promise<McpStdioCuaClient> {
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      env: { ...desktopEnv(env), ...launch.env },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'ai-bdd-driver-cua', version: '0.1.0' }, { capabilities: {} });
    const self = new McpStdioCuaClient(client, transport);
    transport.stderr?.on('data', (chunk: Buffer) => {
      self.stderrTail.push(chunk.toString('utf8'));
      if (self.stderrTail.length > 20) self.stderrTail.shift();
    });
    transport.onclose = () => {
      self.closed = true;
    };
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      self.tools = new Set(listed.tools.map((t) => t.name));
    } catch (err) {
      await client.close().catch(() => undefined);
      const code = (err as { code?: unknown } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'ENOENT' || /ENOENT/.test(msg)) {
        throw new AiBddError('DRIVER_UNAVAILABLE', `cannot start "${launch.command}": not found. ${INSTALL_HINT}.`, { cause: err });
      }
      const tail = self.stderrTail.join('').trim().split('\n').slice(-3).join(' | ');
      throw new AiBddError('DRIVER_UNAVAILABLE', `cannot connect to "${launch.command} ${launch.args.join(' ')}": ${msg.split('\n')[0] ?? msg}${tail.length > 0 ? ` (${tail})` : ''}`, { cause: err });
    }
    return self;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<CuaToolResult> {
    if (this.closed) throw new AiBddError('DRIVER_UNAVAILABLE', 'cua-driver has exited');
    if (!this.tools.has(name)) throw new AiBddError('DRIVER_UNAVAILABLE', `cua-driver does not serve the tool "${name}" (version mismatch? update Cua Driver)`);
    try {
      const raw = await this.client.callTool({ name, arguments: args }, undefined, { timeout: opts.timeoutMs ?? 30_000 });
      return normalizeResult(raw);
    } catch (err) {
      if (this.closed) throw new AiBddError('DRIVER_UNAVAILABLE', 'cua-driver has exited', { cause: err });
      throw new AiBddError('DRIVER_ERROR', `cua-driver ${name} failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? ''}`, { cause: err });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }
}
