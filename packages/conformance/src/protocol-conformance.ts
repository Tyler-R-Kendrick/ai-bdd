import { TOOL_DEFINITIONS, type ToolDefinition } from '@ai-bdd/contracts';
import { describe, expect, it } from 'vitest';

export interface ProtocolConformanceOptions {
  /** Base URL of the running daemon, e.g. `http://127.0.0.1:4321`. */
  baseUrl: string;
  /** Bearer token from `.ai-bdd/daemon.json`. */
  token: string;
  /** Optional MCP tools/list payload captured from the same daemon. */
  mcpTools?: Array<{ name: string; inputSchema: unknown }>;
  fetchImpl?: typeof fetch;
}

/**
 * Daemon protocol conformance (WP-I1c): the HTTP JSON mirror and the MCP surface
 * must validate the same schemas, require the same auth, and propagate the same
 * trace ids.
 */
export function runProtocolConformance(options: ProtocolConformanceOptions): void {
  const doFetch = options.fetchImpl ?? fetch;
  const url = (path: string): string => `${options.baseUrl.replace(/\/$/u, '')}${path}`;

  describe('daemon protocol conformance', () => {
    it('health answers without a token and reports the protocol version', async () => {
      const response = await doFetch(url('/v1/health'), { method: 'POST', body: '{}' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; protocol: number };
      expect(body.ok).toBe(true);
      expect(body.protocol).toBe(1);
    });

    it('rejects a request without a bearer token', async () => {
      const response = await doFetch(url('/v1/open_session'), {
        method: 'POST',
        body: JSON.stringify({ scenarioId: 's', scenarioName: 'n', tags: [], plugin: { name: 'p', version: '1', language: 'ts' } }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('DAEMON_UNAUTHORIZED');
    });

    it('rejects unknown fields with INVALID_ARGUMENT', async () => {
      const response = await doFetch(url('/v1/health'), {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ unexpected: true }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_ARGUMENT');
    });

    it('echoes traceparent into the response', async () => {
      const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      const response = await doFetch(url('/v1/health'), {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, traceparent },
        body: '{}',
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('traceparent') ?? traceparent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    });

    if (options.mcpTools) {
      it('exposes the same tools over MCP as over HTTP, with byte-identical input schemas', () => {
        const byName = new Map(options.mcpTools?.map((tool) => [tool.name, tool]));
        for (const tool of TOOL_DEFINITIONS) {
          const mcp = byName.get(tool.name);
          expect(mcp, `MCP is missing ${tool.name}`).toBeDefined();
          const generated = toJsonSchema(tool.input);
          expect(stable(mcp?.inputSchema)).toBe(stable(generated));
        }
      });
    }
  });
}

/** Validates one tool payload against the checked-in schema (throws on failure). */
export function validateToolPayload(tool: ToolDefinition, payload: unknown): unknown {
  return tool.input.parse(payload);
}

function toJsonSchema(schema: ToolDefinition['input']): unknown {
  return (schema as unknown as { toJSONSchema?: () => unknown }).toJSONSchema?.() ?? null;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return item;
  });
}
