import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDatabase, SqlValue, SqlRunResult } from './types.ts';

export class SqliteDatabase implements SqlDatabase {
  readonly dialect = 'sqlite' as const;
  readonly connection: DatabaseSync;
  readonly context = new AsyncLocalStorage<{ database: SqliteDatabase }>();
  private pending: Promise<void> = Promise.resolve();
  private closing = false;
  constructor(readonly file: string) {
    if (file !== ':memory:')
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(file);
    try {
      this.connection.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;',
      );
      this.connection.exec(
        'PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;',
      );
    } catch (error) {
      this.connection.close();
      throw new Error(
        'Could not acquire the local SQLite writer lock; use one process per local data volume',
        { cause: error },
      );
    }
  }
  private schedule<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.context.getStore()?.database === this)
      return Promise.resolve().then(work);
    if (this.closing)
      return Promise.reject(new Error('The database is closing'));
    const result = this.pending.then(work);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private params(values: readonly SqlValue[]) {
    return values.map((value) =>
      typeof value === 'boolean' ? Number(value) : value,
    );
  }
  one<T = any>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | undefined> {
    return this.schedule(
      () =>
        this.connection.prepare(sql).get(...this.params(params)) as
          | T
          | undefined,
    );
  }
  all<T = any>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.schedule(
      () => this.connection.prepare(sql).all(...this.params(params)) as T[],
    );
  }
  run(sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> {
    return this.schedule(() => {
      const result = this.connection.prepare(sql).run(...this.params(params));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    });
  }
  exec(sql: string): Promise<void> {
    return this.schedule(() => this.connection.exec(sql));
  }
  transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.database === this) return work();
    return this.schedule(() =>
      this.context.run({ database: this }, async () => {
        this.connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await work();
          this.connection.exec('COMMIT');
          return result;
        } catch (error) {
          this.connection.exec('ROLLBACK');
          throw error;
        }
      }),
    );
  }
  async lock(_key: string) {
    if (this.context.getStore()?.database !== this)
      throw new Error('Database locks require an active transaction');
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await this.pending;
    this.connection.close();
  }
}
