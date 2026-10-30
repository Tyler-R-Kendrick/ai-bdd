import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function eventually(check: () => Promise<boolean>) {
  const end = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error('Decision recovery did not converge');
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fixture(
  handler?: (body: any, res: any, count: number) => Promise<void> | void,
) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let source = '';
    for await (const part of req) source += part;
    const body = JSON.parse(source);
    calls++;
    res.setHeader('Content-Type', 'application/json');
    if (handler) await handler(body, res, calls);
    else res.end(JSON.stringify(response(body)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const first = await Store.open(
    await openDatabase({ adapter: 'postgres', url: pg!, schema }),
  );
  const second = await Store.open(
    await openDatabase({ adapter: 'postgres', url: pg!, schema }),
  );
  cleanup.push(
    () => first.close(),
    () => second.close(),
  );
  const user = await first.createUser(
      randomUUID() + '@test.invalid',
      'Decision owner',
      null,
    ),
    project = await first.createProject(user, 'Decision recovery', ''),
    artifact = await first.artifact(project.mainArtifactId, user.id);
  const settings = {
    production: false,
    timeoutMs: 5000,
    leaseMs: 600,
    defaultProfile: decisionProfileSchema.parse({
      provider: 'openai-decisions',
      model: 'gpt-6-luna',
    }),
    openai: {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      apiKey: 'explicit-native-fixture',
      models: ['gpt-6-luna'],
    },
  };
  const models = new DecisionModels({ store: first, settings }),
    other = new DecisionModels({ store: second, settings });
  await Promise.all([models.ready, other.ready]);
  cleanup.push(
    () => models.close(),
    () => other.close(),
  );
  const request = {
    user,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    profile: await models.captureProfile(user, artifact.id),
    input: 'A bounded immutable source with one unresolved boundary.',
    purpose: 'conversation-offer' as const,
    questions: [
      {
        id: 'eligible',
        kind: 'boolean' as const,
        instructions: 'Does the source need a human choice?',
      },
    ],
    idempotencyKey: randomUUID(),
  };
  return {
    first,
    second,
    models,
    other,
    request,
    settings,
    schema,
    calls: () => calls,
  };
}
const response = (body: any, p = 0.95) => ({
  model: body.model,
  answers: body.questions.map((q: any) => ({
    type: 'predicate',
    name: q.name,
    probability: p,
  })),
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});
describe.skipIf(!pg)(
  'actual PostgreSQL decision leases, budgets and restart',
  () => {
    it('serializes concurrent duplicate delivery across independent SQL instances into one provider attempt', async () => {
      const w = await fixture();
      const [a, b] = await Promise.all([
        w.models.decide(w.request),
        w.other.decide(w.request),
      ]);
      expect(a.id).toBe(b.id);
      expect(w.calls()).toBe(1);
      expect(
        Number(
          (
            await w.first.one(
              'SELECT COUNT(*) AS n FROM studio_decision_admissions',
            )
          )?.n,
        ),
      ).toBe(1);
    });
    it('fences the old response after lease replacement and retains only the new attempt receipt', async () => {
      let release!: () => void, arrive!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        incoming = new Promise<void>((r) => (arrive = r));
      const w = await fixture(async (body, res, count) => {
        if (count === 1) {
          arrive();
          await gate;
        }
        res.end(JSON.stringify(response(body, count === 1 ? 0.99 : 0.02)));
      });
      const old = w.models.decide(w.request).catch((error) => error);
      await incoming;
      await w.second.exec(
        'UPDATE studio_decision_calls SET lease_expires=?',
        Date.now() - 1,
      );
      const winner = await w.other.decide(w.request);
      release();
      expect((await old).message).toMatch(/lease/);
      expect(winner.answers[0]?.value).toBe(false);
      expect(
        (await w.models.readEvaluation(w.request.user, winner.id))?.answers[0]
          ?.value,
      ).toBe(false);
      expect(
        Number(
          (await w.first.one('SELECT attempts FROM studio_decision_calls'))
            ?.attempts,
        ),
      ).toBe(2);
    });
    it('enforces one principal budget across competing independent service instances before vendor dispatch', async () => {
      const w = await fixture();
      w.settings['budget' as keyof typeof w.settings] = {
        principalPerHour: 1,
        projectPerHour: 1,
        principalConcurrent: 1,
        projectConcurrent: 1,
      } as never;
      const results = await Promise.all([
        w.models.decide(w.request),
        w.other.decide({
          ...w.request,
          idempotencyKey: randomUUID(),
          input: 'A different immutable boundary.',
        }),
      ]);
      expect(results.map((r) => r.answers[0]?.status).sort()).toEqual([
        'answered',
        'error',
      ]);
      expect(
        results.find((r) => r.status === 'error')?.answers[0]?.error,
      ).toBe('budget-exhausted');
      expect(w.calls()).toBe(1);
    });
    it('recovers the same decision intent after an actual worker SIGKILL and rejects no healthy peer startup', async () => {
      const w = await fixture(async (body, res, count) => {
        if (count > 1) res.end(JSON.stringify(response(body)));
      });
      const dir = await mkdtemp(join(tmpdir(), 'studio-decision-death-'));
      cleanup.push(() => rm(dir, { recursive: true, force: true }));
      const file = join(dir, 'worker.mjs');
      await writeFile(
        file,
        `import {Store} from ${JSON.stringify(new URL('../server/store.ts', import.meta.url).href)};\nimport {openDatabase} from ${JSON.stringify(new URL('../server/persistence/index.ts', import.meta.url).href)};\nimport {DecisionModels} from ${JSON.stringify(new URL('../server/decisions/models.ts', import.meta.url).href)};\nconst store=await Store.open(await openDatabase(${JSON.stringify({ adapter: 'postgres', url: pg, schema: w.schema })}));const models=new DecisionModels({store,settings:${JSON.stringify(w.settings)}});await models.decide(${JSON.stringify(w.request)});`,
      );
      const child = spawn(
        process.execPath,
        ['--import', createRequire(import.meta.url).resolve('tsx'), file],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (part) => (stderr += part));
      cleanup.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      });
      await eventually(async () => {
        if (child.exitCode !== null) throw new Error(stderr);
        return w.calls() === 1;
      });
      child.kill('SIGKILL');
      await once(child, 'exit');
      await eventually(
        async () =>
          Number(
            (
              await w.first.one(
                'SELECT lease_expires FROM studio_decision_calls',
              )
            )?.lease_expires,
          ) < Date.now(),
      );
      const recovered = await w.other.decide(w.request);
      expect(recovered.answers[0]?.value).toBe(true);
      expect(w.calls()).toBe(2);
      expect(
        Number(
          (await w.first.one('SELECT attempts FROM studio_decision_calls'))
            ?.attempts,
        ),
      ).toBe(2);
      expect((await w.models.decide(w.request)).id).toBe(recovered.id);
      expect(w.calls()).toBe(2);
    }, 10000);
  },
);
