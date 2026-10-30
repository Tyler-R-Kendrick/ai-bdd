// Trusted local-only fixture: killed after SQL admission, before any response/publication.
import { Store } from '../../server/store.ts';
import { openDatabase } from '../../server/persistence/index.ts';
import { createDurableJobRuntime } from '../../server/runtime/jobs.ts';
try {
  const input = JSON.parse(process.env.STUDIO_TARGETED_ADMISSION_FIXTURE ?? '{}');
  if (!['sqlite', 'postgres'].includes(input.adapter)) throw new Error('A fixture adapter is required');
  if (input.adapter === 'postgres' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(input.url).hostname))
    throw new Error('Only local PostgreSQL fixtures are permitted');
  const store = await Store.open(input.adapter === 'sqlite' ? input.file : await openDatabase({ adapter: 'postgres', url: input.url, schema: input.schema }));
  const runtime = await createDurableJobRuntime({
    store,
    dispatcher: { provider: 'fixture-never-published-before-response', publish: async () => { throw new Error('Publication before response is forbidden in this fixture'); } },
  });
  runtime.register(input.job.kind, async () => null);
  await runtime.deferDispatch(() => runtime.enqueue(input.job), {
    onAdmitted: (ids) => process.stdout.write(JSON.stringify({ stage: 'committed-before-response', ids }) + '\n'),
  });
  setInterval(() => {}, 10000);
} catch {
  process.stderr.write('Deferred admission fixture failed\n');
  process.exit(1);
}
