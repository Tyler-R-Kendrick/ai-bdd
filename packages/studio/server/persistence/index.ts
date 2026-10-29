export type { SqlDatabase, SqlValue, SqlRunResult } from './types.ts';
export { SqliteDatabase } from './sqlite.ts';
export {
  PostgresDatabase,
  postgresPoolConfig,
  type PostgresOptions,
} from './postgres.ts';
import { SqliteDatabase } from './sqlite.ts';
import { PostgresDatabase, type PostgresOptions } from './postgres.ts';
export type DatabaseOptions =
  | { adapter: 'sqlite'; file: string }
  | ({ adapter: 'postgres' } & PostgresOptions);
export async function openDatabase(options: DatabaseOptions) {
  return options.adapter === 'sqlite'
    ? new SqliteDatabase(options.file)
    : await new PostgresDatabase(options).initialize();
}
