import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.ts';
import { openDatabase } from '../server/persistence/index.ts';
import { DurableJobCoordinator } from '../server/runtime/jobs.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { DesignReviews } from '../server/decisions/design-review.ts';
import { documentImplementationReadiness } from '../server/document-readiness.ts';
import { ImplementationGraphs } from '../server/integrations/implementation.ts';
import Fastify from 'fastify';
import { registerDocumentReview } from '../server/document-review.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !pg)(
    adapter + ' source-linked semantic design review',
    () => {
      async function fixture() {
        const requests: any[] = [];
        let gate: (() => Promise<void>) | undefined;
        const server = createServer(async (req, res) => {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          requests.push(body);
          await gate?.();
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              model: body.model,
              usage: { input_tokens: 14, output_tokens: 7, total_tokens: 21 },
              answers: body.questions.map((q: any) =>
                q.type === 'score'
                  ? {
                      name: q.name,
                      type: 'score',
                      score: 1.8,
                      confidence: 0.9,
                      probabilities: q.levels.map((l: any, i: number) => ({
                        value: i,
                        label: l.label,
                        probability: [0.05, 0.1, 0.85][i],
                      })),
                    }
                  : q.type === 'choice'
                    ? {
                        name: q.name,
                        type: 'choice',
                        choice: 'keep_current',
                        confidence: 0.9,
                        probabilities: q.choices.map((c: any, i: number) => ({
                          value: c.value,
                          probability:
                            i === 0 ? 0.9 : 0.1 / (q.choices.length - 1),
                        })),
                      }
                    : {
                        name: q.name,
                        type: 'predicate',
                        probability: q.name.endsWith('.evidence')
                          ? 0.5
                          : 0.95,
                      },
              ),
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
        const schema = 'review_' + randomUUID().replaceAll('-', '');
        const store = await Store.open(
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({ adapter: 'postgres', url: pg!, schema }),
        );
        cleanup.push(async () => {
          if (adapter === 'postgres')
            await store.db.exec('DROP SCHEMA "' + schema + '" CASCADE');
          await store.close();
        });
        const user = await store.createUser(
            randomUUID() + '@example.test',
            'Design owner',
            null,
          ),
          project = await store.createProject(user, 'Grounded design', '');
        const initial = await store.artifact(project.mainArtifactId, user.id);
        const artifact = await store.updateArtifact(
          user,
          initial.id,
          initial.version,
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: randomUUID() },
                  content: [
                    {
                      type: 'text',
                      text: 'Implement a saved shopping cart whose item count persists after reload.',
                    },
                  ],
                },
                {
                  type: 'paragraph',
                  attrs: { id: randomUUID() },
                  content: [
                    {
                      type: 'text',
                      text: 'PRIVATE UNSELECTED PASSAGE must never be included in this evaluation.',
                    },
                  ],
                },
                {
                  type: 'questionnaireBlock',
                  attrs: {
                    id: randomUUID(),
                    data: {
                      title: 'Choose storage',
                      description: 'An unanswered human prerequisite.',
                      questions: [
                        {
                          id: randomUUID(),
                          question: 'Which storage policy?',
                          options: [
                            { id: 'session', label: 'Session' },
                            { id: 'durable', label: 'Durable' },
                          ],
                          allowText: true,
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        );
        await store.exec(
          "UPDATE decisions SET status='accepted',decision='Cart changes persist after an explicit save.' WHERE artifact_id=?",
          artifact.id,
        );
        const graphs = new ImplementationGraphs({ store });
        await graphs.initialize();
        const app = Fastify();
        cleanup.push(() => app.close());
        await registerDocumentReview(app, {
          store,
          auth: { user: () => user },
          collab: {
            notify: () => {},
            replace: (id, actor, content, version, onPersist) =>
              store.updateArtifact(
                actor,
                id,
                version,
                content,
                undefined,
                onPersist,
              ),
          },
        });
        const runtime = new DurableJobCoordinator({
          store,
          dispatcher: {
            provider: 'review-test-dispatch',
            publish: async () => ({ provider: 'review-test-dispatch' }),
          },
        });
        await runtime.ready;
        cleanup.push(() => runtime.close());
        const models = new DecisionModels({
          store,
          settings: {
            production: false,
            timeoutMs: 4000,
            defaultProfile: decisionProfileSchema.parse({
              provider: 'openai-decisions',
              model: 'gpt-6-luna',
              minimumConfidence: 0.7,
            }),
            openai: {
              baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
              apiKey: 'synthetic-native-decision-contract-key',
              models: ['gpt-6-luna', 'fixture-new-model'],
            },
          },
        });
        await models.ready;
        cleanup.push(() => models.close());
        const service = new DesignReviews({
          store,
          runtime,
          models,
          harnesses: async () => [
            { id: 't3-code', label: 'Preferred T3 authoring harness' },
            {
              id: 'vercel-fx',
              label: 'Explicit alternative generative harness',
            },
          ],
        });
        await service.initialize();
        const blockId = (await service.view(user, artifact.id)).passages[0]!
          .id;
        const start = (requestId = randomUUID()) =>
          service.start(user, artifact.id, {
            requestId,
            blockIds: [blockId],
          });
        const execute = (id: string) =>
          runtime.executeJob(id, {
            messageId: 'review-' + id,
            deliveryCount: 1,
          });
        return {
          store,
          user,
          project,
          artifact,
          runtime,
          models,
          service,
          requests,
          start,
          execute,
          blockId,
          graphs,
          setGate: (value: () => Promise<void>) => {
            gate = value;
          },
        };
      }
      it('freezes independent model and exact selected context, replays once, retains uncertainty and never clears a human prerequisite', async () => {
        const w = await fixture(),
          before = await w.store.artifact(w.artifact.id, w.user.id),
          requestId = randomUUID();
        const first = await w.start(requestId);
        expect((await w.start(requestId)).id).toBe(first.id);
        await w.models.profile(
          w.user,
          w.artifact.id,
          decisionProfileSchema.parse({
            provider: 'openai-decisions',
            model: 'fixture-new-model',
            minimumConfidence: 0.99,
          }),
        );
        await w.execute(first.id);
        await w.execute(first.id);
        expect(w.requests).toHaveLength(1);
        expect(w.requests[0].model).toBe('gpt-6-luna');
        expect(JSON.stringify(w.requests[0])).not.toContain(
          'PRIVATE UNSELECTED',
        );
        const view = await w.service.view(w.user, w.artifact.id),
          result = view.jobs[0]!.result!;
        expect(view.jobs[0]!.status).toBe('completed');
        expect(view.jobs[0]!.stale).toBe(false);
        expect(result.coverage).toMatchObject({ selected: 1, available: 2 });
        expect(
          result.evaluation.answers.find(
            (a) => a.questionId === 'p0.evidence',
          ),
        ).toMatchObject({
          status: 'abstained',
          value: null,
          probability: 0.5,
          confidence: null,
        });
        expect(
          result.evaluation.answers.find(
            (a) => a.questionId === 'p0.testability',
          ),
        ).toMatchObject({ status: 'answered', value: 1.8, confidence: 0.9 });
        expect(
          (await w.store.artifact(w.artifact.id, w.user.id)).content,
        ).toEqual(before.content);
        await w.store.tx(async () => {
          const readiness = await documentImplementationReadiness(
            w.store,
            await w.store.artifact(w.artifact.id, w.user.id),
          );
          expect(readiness.ready).toBe(false);
          expect(
            readiness.blockers.some((b) => b.kind === 'questionnaire'),
          ).toBe(true);
        });
        expect((await w.graphs.read(w.user, w.artifact.id)).graph).toBeNull();
      });
      it('fences accepted-ADR changes during actual HTTP inference and never publishes stale advice', async () => {
        const w = await fixture();
        let release!: () => void, entered!: () => void;
        const waiting = new Promise<void>((r) => {
            release = r;
          }),
          started = new Promise<void>((r) => {
            entered = r;
          });
        w.setGate(async () => {
          entered();
          await waiting;
        });
        const job = await w.start(),
          running = w.execute(job.id);
        await started;
        await w.store.exec(
          "UPDATE decisions SET version=version+1,decision=decision||' changed' WHERE artifact_id=? AND status='accepted'",
          w.artifact.id,
        );
        release();
        await running;
        const row = await w.runtime.get(job.id);
        expect(row?.status).toBe('failed');
        expect(row?.result).toBeNull();
      });
      it('marks historical advice stale and rejects revoked/viewer reads or writes', async () => {
        const w = await fixture(),
          job = await w.start();
        await w.execute(job.id);
        const outsider = await w.store.createUser(
          randomUUID() + '@example.test',
          'Outsider',
          null,
        );
        await expect(
          w.service.view(outsider, w.artifact.id),
        ).rejects.toThrow();
        await w.store.exec(
          "INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'viewer')",
          w.project.id,
          outsider.id,
        );
        await expect(
          w.service.start(outsider, w.artifact.id, {
            requestId: randomUUID(),
            blockIds: [w.blockId],
          }),
        ).rejects.toThrow();
        const a = await w.store.artifact(w.artifact.id, w.user.id);
        await w.store.updateArtifact(
          w.user,
          a.id,
          a.version,
          a.content,
          'Updated human title',
        );
        expect((await w.service.view(w.user, a.id)).jobs[0]!.stale).toBe(
          true,
        );
        await w.store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          w.project.id,
          outsider.id,
        );
        await expect(
          w.service.view(outsider, w.artifact.id),
        ).rejects.toThrow();
      });
      it('refuses missing or duplicate passages and active overlapping work, cancels before any vendor call', async () => {
        const w = await fixture();
        await expect(
          w.service.start(w.user, w.artifact.id, {
            requestId: randomUUID(),
            blockIds: [w.blockId, w.blockId],
          }),
        ).rejects.toThrow('once');
        await expect(
          w.service.start(w.user, w.artifact.id, {
            requestId: randomUUID(),
            blockIds: ['unknown'],
          }),
        ).rejects.toThrow('changed');
        const job = await w.start();
        await expect(w.start()).rejects.toThrow('already active');
        await w.service.cancel(w.user, w.artifact.id, job.id);
        await w.execute(job.id);
        expect((await w.runtime.get(job.id))?.status).toBe('cancelled');
        expect(w.requests).toHaveLength(0);
      });
    },
  );
