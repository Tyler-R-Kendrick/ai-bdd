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
  if (options.adapter === 'sqlite') return new SqliteDatabase(options.file);
  const database = new PostgresDatabase(options);
  try {
    return await database.initialize();
  } catch (error) {
    await database.close();
    throw error;
  }
}
