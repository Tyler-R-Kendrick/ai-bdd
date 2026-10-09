import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonValue } from '@ai-bdd/contracts';

export interface DaemonClientOptions {
  projectRoot?: string;
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface DaemonConnection {
  url: string;
  token: string;
}

export class DaemonError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(payload: { code?: string; message?: string; retryable?: boolean }) {
    super(payload.message ?? 'the ai-bdd daemon reported an error');
    this.name = 'DaemonError';
    this.code = payload.code ?? 'INTERNAL';
    this.retryable = payload.retryable ?? false;
  }
}

/**
 * The daemon client every language plugin needs: read `.ai-bdd/daemon.json` (or
 * take an explicit URL and token), POST to the JSON mirror, and surface the
 * AiBddError payload as a typed exception.
 */
export class DaemonClient {
  private connection: DaemonConnection | undefined;
  private readonly options: DaemonClientOptions;
  private readonly projectRoot: string;

  constructor(options: DaemonClientOptions = {}) {
    this.options = options;
    this.projectRoot = options.projectRoot ?? process.cwd();
  }

  async discover(): Promise<DaemonConnection> {
    if (this.connection) return this.connection;
    if (this.options.url) {
      this.connection = { url: this.options.url, token: this.options.token ?? '' };
      return this.connection;
    }
    const path = join(this.projectRoot, '.ai-bdd', 'daemon.json');
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { url: string; token: string };
      this.connection = { url: parsed.url, token: parsed.token };
      return this.connection;
    }
    throw new DaemonError({
      code: 'DAEMON_UNAUTHORIZED',
      message: `no daemon is running: ${path} does not exist (start one with ai-bdd serve --http)`,
    });
  }

  setConnection(connection: DaemonConnection): void {
    this.connection = connection;
  }

  available(): boolean {
    return this.options.url !== undefined || existsSync(join(this.projectRoot, '.ai-bdd', 'daemon.json'));
  }

  async call<T = JsonValue>(tool: string, body: unknown, traceparent?: string): Promise<T> {
    const connection = await this.discover();
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(`${connection.url.replace(/\/$/u, '')}/v1/${tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(connection.token.length > 0 ? { authorization: `Bearer ${connection.token}` } : {}),
        ...(traceparent !== undefined ? { traceparent } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string; retryable?: boolean } } & Record<string, unknown>;
    if (!response.ok) throw new DaemonError(payload.error ?? { code: 'INTERNAL', message: `HTTP ${response.status}` });
    return payload as T;
  }
}
