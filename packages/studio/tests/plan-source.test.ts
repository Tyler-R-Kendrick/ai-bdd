import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../server/app.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { readPlanSource } from '../server/plan-source.ts';
import { hash } from '../server/store.ts';
import { canonicalPlanSource } from '../shared/plan-source.ts';
import { documentBlockDefaults } from '../shared/document-blocks.ts';
import { implementationPointer } from '../shared/implementation.ts';
import { client, setup, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const definition = {
  tasks: [
    {
      id: 'choice',
      title: 'Implement the accepted approach',
      description: 'Preserve the attributed human choice.',
      acceptanceCriteria: ['The accepted behavior is observable.'],
    },
  ],
  edges: [],
};
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !pg)(
    adapter + ' attributed semantic plan source',
    () => {
      async function fixture() {
        vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-human-choice-sdk-fixture');
        const requests: any[] = [];
        let gate: (() => Promise<void>) | undefined;
        const server = createServer(async (req, res) => {
          let raw = '';
          for await (const part of req) raw += part;
          requests.push(JSON.parse(raw));
          await gate?.();
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              content: [{ type: 'text', text: JSON.stringify(definition) }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 20,
                  noCache: 20,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
              },
              warnings: [],
            }),
          );
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
        const schema = 'plan_source_' + randomUUID().replaceAll('-', '');
        const studio = await createApp(
          {
            ...testSettings('/tmp/studio-accepted-plan-source'),
            model: 'fixture/graph',
            integrations: {
              gatewayBaseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
            },
          },
          adapter === 'sqlite'
            ? { db: ':memory:' }
            : {
                database: await openDatabase({
                  adapter: 'postgres',
                  url: pg!,
                  schema,
                }),
              },
        );
        cleanup.push(async () => {
          await studio.app.close();
          if (adapter === 'postgres') {
            const pool = new Pool({ connectionString: pg! });
            try {
              await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
            } finally {
              await pool.end();
            }
          }
        });
        const { user, cookie } = await setup(studio.app),
          request = client(studio.app, cookie),
          project = await studio.store.createProject(
            user,
            'Decided plan',
            '',
            'https://github.com/example/decided-plan',
          ),
          id = project.mainArtifactId;
        let artifact = await studio.store.artifact(id, user.id);
        artifact = await studio.store.updateArtifact(
          user,
          id,
          artifact.version,
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'intent' },
                  content: [
                    {
                      type: 'text',
                      text: 'Implement the explicitly selected durable integration approach.',
                    },
                  ],
                },
                {
                  type: 'questionnaireBlock',
                  attrs: {
                    id: 'choice',
                    data: structuredClone(
                      documentBlockDefaults.questionnaireBlock,
                    ),
                  },
                },
              ],
            },
          },
        );
        await studio.agent.profiles.view(user, id, {
          harness: 'vercel-fx',
          provider: 'ai-gateway',
          model: 'fixture/graph',
        });
        const state = () => studio.store.artifact(id, user.id);
        const input = {
          version: artifact.version,
          questionId: 'approach',
          optionId: 'b',
          answer:
            'Use the blue durable queue, never the red synchronous integration.',
        };
        const originalState = Buffer.from((await studio.store.state(id))!);
        const answer = await request(
          'POST',
          `/api/artifacts/${id}/document/questionnaires/choice/answers`,
          input,
        );
        expect(answer.statusCode, answer.body).toBe(201);
        expect((await state()).version).toBe(artifact.version + 1);
        const retry = await request(
          'POST',
          `/api/artifacts/${id}/document/questionnaires/choice/answers`,
          input,
        );
        expect(retry.statusCode, retry.body).toBe(200);
        expect(retry.json()).toEqual(answer.json());
        expect((await state()).version).toBe(artifact.version + 1);
        const accepted = await request(
          'POST',
          `/api/artifacts/${id}/document/answers/${answer.json().id}/accept-decision`,
          { version: (await state()).version },
        );
        expect(accepted.statusCode, accepted.body).toBe(201);
        expect((await state()).version).toBe(artifact.version + 2);
        expect((await state()).content).toEqual(artifact.content);
        expect(Buffer.from((await studio.store.state(id))!)).toEqual(
          originalState,
        );
        return {
          studio,
          user,
          project,
          id,
          request,
          state,
          requests,
          input,
          answer: answer.json(),
          decisionId: accepted.json().decisionId,
          gate: (callback: () => Promise<void>) => {
            gate = callback;
          },
        };
      }
      it('feeds the selected attributed human choice to the actual SDK draft and sealed machine context', async () => {
        const w = await fixture(),
          source = await readPlanSource(w.studio.store, await w.state());
        expect(source.acceptedDecisions).toHaveLength(1);
        expect(source.acceptedDecisions![0]).toMatchObject({
          id: w.decisionId,
          decision: expect.stringContaining('blue durable queue'),
          author: w.user.name,
          status: 'accepted',
          version: 1,
        });
        const drafted = await w.request(
          'POST',
          `/api/artifacts/${w.id}/implementation/draft`,
          { requestId: randomUUID() },
        );
        expect(drafted.statusCode, drafted.body).toBe(200);
        await vi.waitFor(
          async () =>
            expect(
              (await w.studio.runtime.get(drafted.json().id))?.status,
            ).toBe('completed'),
          { timeout: 5000 },
        );
        expect(w.requests).toHaveLength(1);
        expect(JSON.stringify(w.requests[0])).toContain('blue durable queue');
        expect(JSON.stringify(w.requests[0])).toContain('Approach B');
        expect(JSON.stringify(w.requests[0])).toContain(w.user.name);
        const frozen = (await w.studio.runtime.get(drafted.json().id))!
          .snapshot as any;
        expect(frozen.source).toEqual(source);
        expect(frozen.sourceSha256).toBe(hash(JSON.stringify(source)));
        const paired = await w.studio.integrations.machines.pair(
            (
              await w.studio.integrations.machines.pairing(
                w.user,
                w.project.id,
                'Human owned builder',
              )
            ).code,
          ),
          machine = await w.studio.store.one(
            'SELECT * FROM studio_machines WHERE id=?',
            paired.id,
          );
        await w.studio.investigations!.registerCheckout(machine, {
          repository: w.project.repository,
          sourceCommit: 'a'.repeat(40),
          branch: 'feature/accepted-choice',
        });
        const graph = (await w.studio.graphs.read(w.user, w.id)).graph!;
        await w.studio.implementationMachines.queue(w.user, w.id, {
          expected: implementationPointer(graph),
          machineId: machine.id,
        });
        const claimed = await w.studio.implementationMachines.claim(machine);
        expect(claimed.work!.source).toEqual(source);
        expect(claimed.work!.sourceSha256).toBe(hash(JSON.stringify(source)));
        const decision = (await w.studio.store.decisions(w.id)).find(
          (d) => d.id === w.decisionId,
        )!;
        const blocked = await w.request(
          'PUT',
          `/api/artifacts/${w.id}/decisions/${decision.id}`,
          {
            title: decision.title,
            context: decision.context,
            decision: 'Switch to the red queue during a claimed build',
            consequences: decision.consequences,
            status: 'accepted',
            version: decision.version,
          },
        );
        expect(blocked.statusCode, blocked.body).toBe(409);
        expect((await w.state()).version).toBe(graph.planRevision);
      });
      it('invalidates an in-flight draft and an old approval when an accepted choice changes without changing document JSON', async () => {
        const w = await fixture();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        w.gate(() => held);
        const before = await w.state(),
          draft = await w.request(
            'POST',
            `/api/artifacts/${w.id}/implementation/draft`,
            { requestId: randomUUID() },
          );
        await vi.waitFor(() => expect(w.requests).toHaveLength(1));
        const graph = await w.studio.graphs.edit(
          { user: w.user, kind: 'human' },
          w.id,
          { expected: null, planRevision: before.version, definition },
        );
        const decision = (await w.studio.store.decisions(w.id)).find(
          (d) => d.id === w.decisionId,
        )!;
        const updated = await w.request(
          'PUT',
          `/api/artifacts/${w.id}/decisions/${decision.id}`,
          {
            title: decision.title,
            context: decision.context,
            decision: 'Human now selects the green queue explicitly',
            consequences: decision.consequences,
            status: 'accepted',
            version: decision.version,
          },
        );
        expect(updated.statusCode, updated.body).toBe(200);
        expect((await w.state()).version).toBe(before.version + 1);
        expect((await w.state()).content).toEqual(before.content);
        release();
        await vi.waitFor(
          async () =>
            expect((await w.studio.runtime.get(draft.json().id))?.status).toBe(
              'failed',
            ),
          { timeout: 5000 },
        );
        await expect(
          w.studio.graphs.approve(
            { user: w.user, kind: 'human' },
            w.id,
            implementationPointer(graph),
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (await w.studio.graphs.read(w.user, w.id)).graph!.definition,
        ).toEqual(definition);
      });
      it('preserves explicit ADR statuses and removes a superseded human choice from current source', async () => {
        const w = await fixture(),
          before = await w.state(),
          decision = (await w.studio.store.decisions(w.id)).find(
            (d) => d.id === w.decisionId,
          )!;
        const result = await w.request(
          'PUT',
          `/api/artifacts/${w.id}/decisions/${decision.id}`,
          {
            title: decision.title,
            context: decision.context,
            decision: decision.decision,
            consequences: decision.consequences,
            status: 'superseded',
            version: decision.version,
          },
        );
        expect(result.statusCode, result.body).toBe(200);
        expect((await w.state()).version).toBe(before.version + 1);
        const source = await readPlanSource(w.studio.store, await w.state());
        expect(source).not.toHaveProperty('acceptedDecisions');
        expect(JSON.stringify(source)).toBe(JSON.stringify(before.content));
        expect(
          (await w.studio.store.decisions(w.id)).find(
            (d) => d.id === decision.id,
          ),
        ).toMatchObject({
          status: 'superseded',
          version: decision.version + 1,
        });
      });
      it('rolls an ADR change and its semantic revision back together when source publication fails', async () => {
        const w = await fixture(),
          before = await w.state(),
          decision = (await w.studio.store.decisions(w.id)).find(
            (d) => d.id === w.decisionId,
          )!,
          observer = w.studio.store.sourceObserver;
        w.studio.store.sourceObserver = async () => {
          throw new Error('Explicit source observer rollback fixture');
        };
        try {
          const result = await w.request(
            'PUT',
            `/api/artifacts/${w.id}/decisions/${decision.id}`,
            {
              title: decision.title,
              context: decision.context,
              decision: 'Must not survive failed semantic publication',
              consequences: decision.consequences,
              status: 'accepted',
              version: decision.version,
            },
          );
          expect(result.statusCode).toBe(500);
        } finally {
          w.studio.store.sourceObserver = observer;
        }
        expect((await w.state()).version).toBe(before.version);
        expect(
          (await w.studio.store.decisions(w.id)).find(
            (d) => d.id === decision.id,
          ),
        ).toEqual(decision);
        expect(
          await w.studio.store.one(
            'SELECT version FROM revisions WHERE artifact_id=? AND version=?',
            w.id,
            before.version + 1,
          ),
        ).toBeUndefined();
      });
      it('rejects complete oversized decision context instead of silently truncating the accepted choice', async () => {
        const w = await fixture(),
          decision = (await w.studio.store.decisions(w.id)).find(
            (d) => d.id === w.decisionId,
          )!;
        const updated = await w.request(
          'PUT',
          `/api/artifacts/${w.id}/decisions/${decision.id}`,
          {
            title: decision.title,
            context: 'x'.repeat(20000),
            decision: 'y'.repeat(20000),
            consequences: 'z'.repeat(20000),
            status: 'accepted',
            version: decision.version,
          },
        );
        expect(updated.statusCode, updated.body).toBe(200);
        const current = await w.state();
        await w.studio.store.updateArtifact(w.user, w.id, current.version, {
          doc: {
            ...current.content.doc,
            content: [
              ...current.content.doc.content,
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'q'.repeat(15000) }],
              },
            ],
          },
        });
        const result = await w.request(
          'POST',
          `/api/artifacts/${w.id}/implementation/draft`,
          { requestId: randomUUID() },
        );
        expect(result.statusCode, result.body).toBe(413);
        expect(w.requests).toHaveLength(0);
      });
    },
  );
it('preserves legacy source serialization with no accepted decisions and orders accepted records deterministically', () => {
  const content = { doc: { type: 'doc', content: [] } },
    decision: any = {
      id: 'b',
      title: 'Human choice',
      context: 'Given',
      decision: 'Selected',
      consequences: 'Tradeoff',
      version: 3,
      author: 'Person',
      status: 'accepted',
    };
  expect(JSON.stringify(canonicalPlanSource(content, []))).toBe(
    JSON.stringify(content),
  );
  expect(
    canonicalPlanSource(content, [{ ...decision, status: 'proposed' }]),
  ).toEqual(content);
  expect(
    canonicalPlanSource(content, [
      decision,
      { ...decision, id: 'a' },
    ]).acceptedDecisions!.map((d) => d.id),
  ).toEqual(['a', 'b']);
  expect(content).not.toHaveProperty('acceptedDecisions');
});
