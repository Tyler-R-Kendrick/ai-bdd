import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { JsonValue } from '@ai-bdd/contracts';
import { TOOL_DEFINITIONS, type ToolShortName } from '@ai-bdd/contracts';
import { callTool, type ToolBackend } from './tools.js';

export interface HttpMirrorOptions {
  backend: ToolBackend;
  token: string;
  host?: string;
  port?: number;
  /** Called for `aibdd_run`, which the daemon resolves with its runtime factory. */
  runSpecs?: (input: unknown, traceparent?: string) => Promise<JsonValue>;
}

export interface HttpMirror {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * The HTTP JSON mirror: `POST /v1/<tool>` with the same body and the same result
 * as the MCP tool of the same name (R-K12a). Plugins use this surface because a
 * keep-alive POST is cheaper than an MCP round trip per step.
 */
export async function startHttpMirror(options: HttpMirrorOptions): Promise<HttpMirror> {
  const server = createServer((request, response) => {
    void handle(request, response, options);
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, options: HttpMirrorOptions): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const traceparent = firstHeader(request.headers.traceparent);

  if (request.method === 'GET' && url.pathname === '/__health') {
    return send(response, 200, { ok: true }, traceparent);
  }
  if (request.method !== 'POST' || !url.pathname.startsWith('/v1/')) {
    return send(response, 404, { error: { code: 'INVALID_ARGUMENT', message: `no route for ${request.method} ${url.pathname}`, retryable: false } }, traceparent);
  }

  const short = url.pathname.slice('/v1/'.length) as ToolShortName;
  const definition = TOOL_DEFINITIONS.find((tool) => tool.short === short);
  if (!definition) {
    return send(response, 404, { error: { code: 'INVALID_ARGUMENT', message: `unknown tool ${short}`, retryable: false } }, traceparent);
  }

  // Health is the only endpoint that does not need the bearer token: it is how a
  // client discovers the protocol version before reading daemon.json.
  if (short !== 'health') {
    const auth = firstHeader(request.headers.authorization);
    if (auth !== `Bearer ${options.token}`) {
      return send(
        response,
        401,
        { error: { code: 'DAEMON_UNAUTHORIZED', message: 'missing or invalid bearer token', retryable: false } },
        traceparent,
      );
    }
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(request)) || '{}') as unknown;
  } catch (error) {
    return send(response, 400, { error: { code: 'INVALID_ARGUMENT', message: `invalid JSON: ${String(error)}`, retryable: false } }, traceparent);
  }

  if (short === 'run') {
    if (!options.runSpecs) {
      return send(response, 400, { error: { code: 'INVALID_ARGUMENT', message: 'aibdd_run is not available in this daemon', retryable: false } }, traceparent);
    }
    try {
      const value = await options.runSpecs(body, traceparent);
      return send(response, 200, value, traceparent);
    } catch (error) {
      const payload = error as { code?: string; message?: string };
      return send(response, 500, { error: { code: payload.code ?? 'INTERNAL', message: payload.message ?? String(error), retryable: false } }, traceparent);
    }
  }

  const result = await callTool(short, body, options.backend);
  if (!result.ok) {
    const code = result.error?.code ?? 'INTERNAL';
    const status = code === 'INVALID_ARGUMENT' ? 400 : code === 'NO_SESSION' || code === 'DAEMON_UNAUTHORIZED' ? 401 : 500;
    return send(response, status, { error: result.error }, traceparent);
  }
  return send(response, 200, result.value ?? null, traceparent);
}

function send(response: ServerResponse, status: number, body: unknown, traceparent?: string): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
  };
  if (traceparent) headers.traceparent = traceparent;
  response.writeHead(status, headers);
  response.end(payload);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export type { Server };
