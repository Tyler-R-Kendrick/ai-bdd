import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { extractErrorCode, mapE2eError, type McpCaller, type OpenSessionResult } from '../../src/index.js';

interface TranscriptEntry {
  tool: string;
  args?: Record<string, JsonValue>;
  result?: JsonValue;
  isError?: boolean;
  errorCode?: string;
  synthetic?: boolean;
}

export function loadTranscript(path?: string): TranscriptEntry[] {
  const file = path ?? fileURLToPath(new URL('../fixtures/e2e-mcp-0.19.0.jsonl', import.meta.url));
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry)
    .filter((entry) => entry.tool !== undefined && entry.synthetic !== true);
}

/**
 * Replays a recorded `e2e mcp` transcript. Used by the unit tests so CI needs no
 * e2e install; the live test is opt-in (AI_BDD_LIVE_E2E=1).
 */
export class ReplayCaller implements McpCaller {
  private readonly entries: TranscriptEntry[];
  private readonly consumed = new Set<number>();
  readonly calls: Array<{ tool: string; args: JsonValue }> = [];
  closed = false;

  constructor(entries: TranscriptEntry[] = loadTranscript()) {
    this.entries = entries;
  }

  private take(tool: string): TranscriptEntry {
    const index = this.entries.findIndex((entry, position) => entry.tool === tool && !this.consumed.has(position));
    if (index === -1) throw new AiBddError('DRIVER_INCOMPATIBLE', `the transcript has no ${tool} response`);
    this.consumed.add(index);
    return this.entries[index]!;
  }

  async listCatalog(): Promise<string[]> {
    const entry = this.entries.find((candidate) => candidate.tool === 'tools/list');
    const tools = (entry?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    return tools.map((tool) => tool.name);
  }

  async openSession(input: { target?: string; config?: string }): Promise<OpenSessionResult> {
    this.calls.push({ tool: 'open_session', args: { ...input } });
    const entry = this.take('open_session');
    const result = entry.result as Record<string, JsonValue>;
    return {
      sessionId: String(result.session_id),
      catalog: (result.tools as JsonValue[]).map(String),
      observation: typeof result.observation === 'string' ? result.observation : undefined,
      url: typeof result.url === 'string' ? result.url : undefined,
    } as OpenSessionResult;
  }

  async call(sessionId: string, tool: string, args: JsonValue): Promise<JsonValue> {
    this.calls.push({ tool, args });
    const entry = this.take(tool);
    if (entry.isError) {
      const code = mapE2eError(entry.errorCode ?? extractErrorCode(entry.result)) ?? 'DRIVER_UNAVAILABLE';
      throw new AiBddError(code, String(entry.result));
    }
    return entry.result ?? null;
  }

  async closeSession(): Promise<void> {
    this.calls.push({ tool: 'close_session', args: {} });
    this.take('close_session');
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
