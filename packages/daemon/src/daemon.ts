import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { JsonValue } from '@ai-bdd/contracts';
import { createSessionManager, type SessionManager } from '@ai-bdd/runtime';
import { startHttpMirror, type HttpMirror } from './http.js';
import { serveStdioMcp } from './mcp.js';
import { callTool, type ToolBackend } from './tools.js';

export interface DaemonOptions {
  /** Session manager (or anything implementing the tool backend). */
  backend?: ToolBackend;
  sessionManager?: SessionManager;
  host?: string;
  port?: number;
  /** Fixed token, mainly for tests. */
  token?: string;
  /** Serve MCP over stdio instead of HTTP. */
  stdio?: boolean;
  /** Serve the HTTP JSON mirror (and MCP over Streamable HTTP). */
  http?: boolean;
  projectRoot: string;
  /** Runs specs natively for `aibdd_run`. */
  runSpecs?: (input: unknown, traceparent?: string) => Promise<JsonValue>;
  version?: string;
}

export interface DaemonHandle {
  url?: string;
  port?: number;
  token: string;
  sessionManager?: SessionManager;
  close(): Promise<void>;
}

/**
 * Starts the orchestrator daemon.
 *
 * The token is written to `.ai-bdd/daemon.json` with mode 0600, which is how a
 * language plugin discovers the URL and the bearer token it must send.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const backend: ToolBackend = options.backend ?? (options.sessionManager as unknown as ToolBackend);
  if (!backend) throw new Error('startDaemon requires a backend or a sessionManager');

  const closers: Array<() => Promise<void>> = [];
  let mirror: HttpMirror | undefined;
  let url: string | undefined;

  if (options.stdio && !options.http) {
    const handle = await serveStdioMcp({
      backend,
      ...(options.runSpecs ? { runSpecs: options.runSpecs } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    });
    closers.push(() => handle.close());
  } else {
    mirror = await startHttpMirror({
      backend,
      token,
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 0,
      ...(options.runSpecs ? { runSpecs: options.runSpecs } : {}),
    });
    url = mirror.url;
    closers.push(() => mirror!.close());
  }

  const daemonJson = join(options.projectRoot, '.ai-bdd', 'daemon.json');
  writeDaemonJson(daemonJson, { url: url ?? 'stdio', token, protocol: 1, pid: process.pid });

  return {
    ...(url !== undefined ? { url } : {}),
    ...(mirror !== undefined && mirror.port !== undefined ? { port: mirror.port } : {}),
    token,
    ...(options.sessionManager ? { sessionManager: options.sessionManager } : {}),
    async close(): Promise<void> {
      for (const close of closers.reverse()) await close().catch(() => undefined);
      await options.sessionManager?.closeAll();
    },
  };
}

/** Boots a daemon from a resolved project: config + models + drivers + sessions. */
export async function startProjectDaemon(options: {
  config: Parameters<typeof createSessionManager>[0]['config'];
  models: Parameters<typeof createSessionManager>[0]['models'];
  drivers: Parameters<typeof createSessionManager>[0]['drivers'];
  host?: string;
  port?: number;
  token?: string;
  stdio?: boolean;
}): Promise<DaemonHandle> {
  const sessionManager = createSessionManager({
    config: options.config,
    models: options.models,
    drivers: options.drivers,
    reapOrphans: true,
  });
  return startDaemon({
    sessionManager,
    projectRoot: options.config.projectRoot,
    host: options.host ?? options.config.daemon.host,
    port: options.port ?? options.config.daemon.port,
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
    http: true,
  });
}

function writeDaemonJson(path: string, payload: Record<string, JsonValue | number>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on filesystems that do not support modes
  }
}

export { callTool };
