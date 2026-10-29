import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlDatabase, SqlValue, SqlRunResult } from './types.ts';
import { normalizePostgresRow, postgresQuery, postgresSchema } from './sql.ts';
export type PostgresOptions = {
  url: string;
  schema?: string;
  max?: number;
  pool?: Pool;
  tls?: { ca?: string; cert?: string; key?: string };
};
export function postgresPoolConfig(options: PostgresOptions): PoolConfig {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error('Invalid PostgreSQL connection settings');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('A PostgreSQL connection URL is required');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    mode = url.searchParams.get('sslmode');
  if (mode === 'disable' && !local)
    throw new Error(
      'Remote PostgreSQL connections require certificate-verified TLS',
    );
  for (const field of ['sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'])
    if (url.searchParams.has(field))
      throw new Error(
        'Configure PostgreSQL TLS certificates through the TLS adapter options, not connection-string file paths',
      );
  url.searchParams.delete('sslmode');
  return {
    connectionString: url.toString(),
    max: options.max ?? 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    allowExitOnIdle: true,
    ssl:
      local && (!mode || mode === 'disable')
        ? false
        : { ...options.tls, rejectUnauthorized: true },
  };
}
export class PostgresDatabase implements SqlDatabase {
  readonly dialect = 'postgres' as const;
  readonly pool: Pool;
  readonly context = new AsyncLocalStorage<{
    database: PostgresDatabase;
    client: PoolClient;
  }>();
  private readonly ownsPool: boolean;
  private readonly positionalColumns = new Map<string, string[]>();
  private closing = false;
  constructor(readonly options: PostgresOptions) {
    if (options.schema && !/^[a-z][a-z0-9_]{0,60}$/.test(options.schema))
      throw new Error('Invalid PostgreSQL schema namespace');
    if (
      options.pool &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(options.url).hostname,
      )
    ) {
      const ssl = options.pool.options.ssl;
      if (!ssl || (typeof ssl === 'object' && ssl.rejectUnauthorized === false))
        throw new Error(
          'Injected remote PostgreSQL pools must enforce certificate-verified TLS',
        );
    }
    if (
      options.max !== undefined &&
      (!Number.isInteger(options.max) || options.max < 1 || options.max > 20)
    )
      throw new Error('PostgreSQL pool size must be between1 and20');
    this.pool = options.pool ?? new Pool(postgresPoolConfig(options));
    this.ownsPool = !options.pool;
    // pg removes failed idle connections; active operations reject normally instead of crashing the process.
    this.pool.on('error', () => {});
  }
  async initialize() {
    if (this.options.schema)
      await this.pool.query(
        'CREATE SCHEMA IF NOT EXISTS "' + this.options.schema + '"',
      );
    return this;
  }
  private async client<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const active = this.context.getStore();
    if (active?.database === this) return work(active.client);
    if (this.closing) throw new Error('The database is closing');
    const client = await this.pool.connect();
    try {
      await client.query(
        'SET search_path TO "' + (this.options.schema ?? 'public') + '"',
      );
      return await work(client);
    } finally {
      client.release();
    }
  }
  private async query(sql: string, params: readonly SqlValue[] = []) {
    return this.client(async (client) => {
      const result = await client.query(
        postgresQuery(sql, this.positionalColumns),
        params.map((value) =>
          value instanceof Uint8Array
            ? Buffer.from(value)
            : typeof value === 'boolean'
              ? Number(value)
              : value,
        ),
      );
      return {
        ...result,
        rows: result.rows.map((row) =>
          normalizePostgresRow(row, sql, result.fields),
        ),
      };
    });
  }
  async one<T = any>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | undefined> {
    return (await this.query(sql, params)).rows[0] as T | undefined;
  }
  async all<T = any>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }
  async run(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlRunResult> {
    return { changes: (await this.query(sql, params)).rowCount ?? 0 };
  }
  async exec(sql: string) {
    const translated = postgresSchema(sql, this.positionalColumns);
    await this.client(async (client) => {
      await client.query(translated);
    });
  }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.database === this) return work();
    return this.client(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await this.context.run({ database: this, client }, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  async lock(key: string) {
    const active = this.context.getStore();
    if (active?.database !== this)
      throw new Error('Database locks require an active transaction');
    await active.client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [key],
    );
  }
  async close() {
    this.closing = true;
    if (this.ownsPool) await this.pool.end();
  }
}
