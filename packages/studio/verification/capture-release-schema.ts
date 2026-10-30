/** Capture actual application migration output against an operator-supplied local test database only. */
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/persistence/index.ts';
import { createApp } from '../server/app.ts';
const input = createInterface({ input: process.stdin, terminal: false });
process.stdout.write('READY_FOR_LOCAL_SCHEMA_INPUT\n');
const iterator = input[Symbol.asyncIterator]();
const line = await iterator.next();
let temporary = '';
try {
  const config = JSON.parse(line.value),
    uri = new URL(config.url);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) ||
    !/^release_smoke_[a-z0-9_]+$/.test(config.schema)
  )
    throw new Error('A new isolated local schema is required');
  temporary = await mkdtemp(join(tmpdir(), 'studio-neon-schema-'));
  const database = await openDatabase({
    adapter: 'postgres',
    url: config.url,
    schema: config.schema,
    max: 2,
  });
  const studio = await createApp(
    {
      origin: 'http://127.0.0.1:8901',
      production: false,
      demo: false,
      dataDir: temporary,
      integrations: {},
    },
    { database, logger: false },
  );
  const rows = await studio.store.all(
    'SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() ORDER BY table_name',
  );
  await studio.app.close();
  process.stdout.write(
    JSON.stringify({
      schema: config.schema,
      tables: rows.length,
      localAppMigrations: true,
    }) + '\n',
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      failed: true,
      code: (error as any)?.code ?? 'unspecified',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  input.close();
  process.stdin.pause();
}
