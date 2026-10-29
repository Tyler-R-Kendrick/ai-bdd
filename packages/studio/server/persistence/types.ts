export type SqlValue = string | number | bigint | boolean | Uint8Array | null;
export type SqlRunResult = {
  changes: number;
  lastInsertRowid?: number | bigint;
};
/** Trusted application SQL only. Artifact content is always a bound value. */
export interface SqlDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  one<T = any>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | undefined>;
  all<T = any>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** Transaction-scoped lock. Independent requests must not share a transaction context. */
  lock(key: string): Promise<void>;
  close(): Promise<void>;
}
