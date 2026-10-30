import { ownedFreeGatewayMetadata } from './free-gateway-fixture.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { Store, HttpError } from '../server/store.ts';
import {
  openDatabase,
  postgresPoolConfig,
} from '../server/persistence/index.ts';
import { Auth } from '../server/auth.ts';
import { Collaboration } from '../server/collaboration.ts';
import { createDurableJobRuntime } from '../server/runtime/jobs.ts';
import { Agent } from '../server/agent.ts';
import { MachineService } from '../server/integrations/machines.ts';
import { InvestigationService } from '../server/integrations/investigations.ts';
import { DiskObjectStore } from '../server/hosting/disk-objects.ts';
import {
  FindingsReviews,
  registerFindingsReviewRoutes,
} from '../server/integrations/findings-review.ts';
import { DecisionModels } from '../server/decisions/models.ts';
import { decisionProfileSchema } from '../shared/decision-profile.ts';
import { docText } from '../shared/domain.ts';
import type { FindingsProposal } from '../shared/findings-review.ts';
import type { InvestigationResult } from '../shared/investigations.ts';
import { documentImplementationReadiness } from '../server/document-readiness.ts';
import { testSettings } from './helpers.ts';
import { registerDocumentReview } from '../server/document-review.ts';
import { RemotePlanner } from '../server/integrations/remote-planner.ts';
import { findingsExportRows } from '../server/integrations/findings-export.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const pg = process.env.STUDIO_TEST_POSTGRES_URL;
const original =
  'Compare the two queue implementations before choosing the production boundary.';
const report: InvestigationResult = {
  title: 'Bounded queue measurement',
  report: 'The fixture measured variant B at 22 ms and variant A at 41 ms.',
  method: 'Twenty synthetic local requests per variant.',
  limitations: 'Local fixture timings do not establish production latency.',
  datasets: [],
  views: [],
  evidence: [
    { name: 'Observed output', text: 'variant A: 41 ms; variant B: 22 ms' },
  ],
  images: [],
};
const generated = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  },
  warnings: [],
});

for (const adapter of ['sqlite', 'postgres'] as const)
  describe.skipIf(adapter === 'postgres' && !pg)(
    adapter +
      ' completed findings review using actual native decision HTTP and generative SDK',
    () => {
      async function fixture() {
        vi.stubEnv('AI_GATEWAY_API_KEY', 'explicit-findings-fixture-key');
        const dir = await mkdtemp(join(tmpdir(), 'studio-findings-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const schema = 'findings_' + randomUUID().replaceAll('-', '');
        const store = await Store.open(
          adapter === 'sqlite'
            ? ':memory:'
            : await openDatabase({ adapter, url: pg!, schema }),
        );
        cleanup.push(async () => {
          await store.close();
          if (adapter === 'postgres') {
            const pool = new Pool(postgresPoolConfig({ url: pg! }));
            try {
              await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
            } finally {
              await pool.end();
            }
          }
        });
        const user = await store.createUser(
            randomUUID() + '@test.invalid',
            'Findings owner',
            null,
          ),
          other = await store.createUser(
            randomUUID() + '@test.invalid',
            'Other writer',
            null,
          ),
          viewer = await store.createUser(
            randomUUID() + '@test.invalid',
            'Viewer',
            null,
          );
        const project = await store.createProject(
          user,
          'Measured design',
          '',
          'https://github.com/example/findings',
        );
        await store.exec(
          'INSERT INTO memberships VALUES(?,?,?)',
          project.id,
          other.id,
          'editor',
        );
        await store.exec(
          'INSERT INTO memberships VALUES(?,?,?)',
          project.id,
          viewer.id,
          'viewer',
        );
        const id = project.mainArtifactId,
          blockId = randomUUID();
        const proposal: FindingsProposal = {
          summary:
            'Incorporate the local observation while retaining its limits and the human production choice.',
          edits: [
            {
              blockId,
              original,
              replacement:
                'Local measurements found variant B at 22 ms versus A at 41 ms; production latency remains unverified.',
              evidence: 'variant B at 22 ms and variant A at 41 ms',
            },
          ],
          questions: [
            {
              question:
                'Which production queue boundary should the team choose?',
              options: ['Variant A', 'Variant B'],
              context:
                'The measurement is local evidence; a human must choose the production boundary.',
            },
          ],
        };
        const requests: any[] = [],
          native: any[] = [];
        let answer: number | 'refused' | 'error' = 0.95,
          beforeGeneration: (() => Promise<void>) | undefined,
          beforeDecision: (() => Promise<void>) | undefined;
        const server = createServer(async (req, res) => {
          let text = '';
          for await (const chunk of req) text += chunk;
          const body = JSON.parse(text);
          res.setHeader('content-type', 'application/json');
          if (req.url === '/native/decisions') {
            native.push(body);
            await beforeDecision?.();
            if (answer === 'error') {
              res.statusCode = 503;
              res.end(JSON.stringify({ error: 'Explicit fixture outage' }));
              return;
            }
            res.end(
              JSON.stringify({
                model: body.model,
                answers: body.questions.map((q: any) =>
                  answer === 'refused'
                    ? { name: q.name, type: 'refusal' }
                    : { name: q.name, type: 'predicate', probability: answer },
                ),
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
              }),
            );
            return;
          }
          requests.push({
            ...body,
            fixtureModel: req.headers['ai-language-model-id'],
          });
          await beforeGeneration?.();
          res.end(JSON.stringify(generated(proposal)));
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
        const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
        const settings = {
          ...testSettings(dir),
          model: 'fixture/model',
          integrations: { gatewayBaseUrl: endpoint, gatewayMetadataFetch: ownedFreeGatewayMetadata(), remotePlanner: true },
        };
        const auth = new Auth(store, settings),
          collab = new Collaboration(store, auth);
        await collab.initialize();
        cleanup.push(() => collab.close());
        const runtime = await createDurableJobRuntime({
          store,
          dispatcher: {
            provider: 'explicit-manual-fixture',
            publish: async () => ({ provider: 'explicit-manual-fixture' }),
          },
        });
        cleanup.push(() => runtime.close());
        const models = new DecisionModels({
          store,
          settings: {
            production: false,
            timeoutMs: 5000,
            defaultProfile: decisionProfileSchema.parse({
              provider: 'openai-decisions',
              model: 'fixture/decision',
            }),
            openai: {
              baseUrl: endpoint + '/native',
              apiKey: 'fixture-native-key',
              models: ['fixture/decision', 'fixture/other'],
            },
          },
        });
        await models.ready;
        cleanup.push(() => models.close());
        let locked = false;
        store.artifactWriteGuard = async () => {
          if (!store.db.inTransaction())
            throw new Error(
              'The real source guard requires a project transaction',
            );
          if (locked)
            throw new HttpError(409, 'Implementation source is locked');
        };
        const agent = new Agent(store, settings, collab, {
          runtime,
          implementationLocked: async () => locked,
          decisions: models,
        });
        await agent.initialize();
        await agent.profiles.view(user, id, {
          harness: 'vercel-fx',
          provider: 'ai-gateway',
          model: 'fixture/model',
        });
        await collab.replace(
          id,
          user,
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: blockId },
                  content: [{ type: 'text', text: original }],
                },
              ],
            },
          },
          (await store.artifact(id, user.id)).version,
        );
        const machines = new MachineService(store, collab);
        await machines.initialize();
        const paired = await machines.pair(
          (
            await machines.pairing(
              user,
              project.id,
              'Owned fixture workstation',
            )
          ).code,
        );
        const machine = await store.one(
          'SELECT * FROM studio_machines WHERE id=?',
          paired.id,
        );
        const investigations = new InvestigationService({
          store,
          auth,
          machines,
          objects: new DiskObjectStore(join(dir, 'objects')),
          implementationLocked: async () => locked,
        });
        await investigations.ready;
        await investigations.registerCheckout(machine, {
          repository: 'https://github.com/example/findings',
          sourceCommit: 'a'.repeat(40),
          branch: 'main',
        });
        const record = await investigations.propose(user, id, {
          version: (await store.artifact(id, user.id)).version,
          brief: 'Measure the queue alternatives',
          requiredReason: 'Choose using measured findings',
        });
        await investigations.run(user, record.id);
        const claim = await investigations.claim(machine);
        await investigations.complete(machine, record.id, {
          leaseToken: claim.leaseToken!,
          generation: claim.work!.generation,
          result: report,
        });
        const service = new FindingsReviews({
          store,
          runtime,
          collab,
          models,
          generation: {
            captureProfile: async (u, id) => {
              const profile = await agent.captureProfile(u, id);
              agent.profiles.assertAvailable(profile);
              return profile;
            },
            modelForProfile: (p, key) => agent.modelForProfile(p, key),
          },
          allowed: (u, id) => agent.canParticipate(u, id),
          quietMs: 0,
        });
        await service.initialize();
        store.sourceObserver = (u, previous, current) =>
          service.observe(u, previous, current);
        const app = Fastify();
        await app.register(websocket);
        cleanup.push(() => app.close());
        const remote = new RemotePlanner({
          store,
          settings,
          authenticate: async () => user,
          claim: (u, id) => agent.claimPlanner(u, id),
          allowed: (u, id) => agent.canParticipate(u, id),
          pollMs: 10,
        });
        await remote.initialize();
        cleanup.push(() => remote.close());
        remote.register(app);
        service.options.remote = remote;
        await registerDocumentReview(app, { store, auth, collab });
        app.setErrorHandler((e, _req, reply) =>
          reply
            .code(
              e instanceof z.ZodError ? 400 : ((e as any).statusCode ?? 500),
            )
            .send({ error: (e as Error).message }),
        );
        registerFindingsReviewRoutes(
          app,
          {
            user: async (req: any) =>
              store.publicUser(req.headers['x-fixture-user'] ?? user.id),
            assertOrigin: (req: any) => {
              if (req.headers.origin !== settings.origin)
                throw new HttpError(403, 'Origin required');
            },
          } as Auth,
          service,
        );
        const execute = (jobId: string) =>
          runtime.executeJob(jobId, {
            messageId: 'fixture-' + jobId,
            deliveryCount: 1,
          });
        const latest = async () => await store.artifact(id, user.id);
        const review = async () => {
          await agent.claimPlanner(user, id);
          const job = await service.start(user, record.id);
          await execute(job.id);
          return (await service.view(user, record.id)).reviews[0]!;
        };
        return {
          store,
          user,
          other,
          viewer,
          project,
          id,
          record,
          service,
          agent,
          runtime,
          models,
          collab,
          app,
          remote,
          settings,
          proposal,
          requests,
          native,
          execute,
          latest,
          review,
          setAnswer: (value: typeof answer) => {
            answer = value;
          },
          beforeGeneration: (fn?: () => Promise<void>) => {
            beforeGeneration = fn;
          },
          beforeDecision: (fn?: () => Promise<void>) => {
            beforeDecision = fn;
          },
          lock: () => {
            locked = true;
          },
        };
      }
      it('freezes both profiles and exact evidence, publishes only a proposal, then human application atomically updates JSON/Yjs and leaves human choices unresolved', async () => {
        const w = await fixture(),
          before = await w.latest();
        await w.agent.claimPlanner(w.user, w.id);
        const job = await w.service.start(w.user, w.record.id);
        await w.models.profile(w.user, w.id, {
          provider: 'openai-decisions',
          model: 'fixture/other',
          minimumConfidence: 0.7,
          policyVersion: 'decision-policy-v1',
        });
        await w.execute(job.id);
        const result = (await w.service.view(w.user, w.record.id)).reviews[0]!;
        expect(result.proposal).toEqual(w.proposal);
        expect(w.native[0].model).toBe('fixture/decision');
        expect(w.requests[0].fixtureModel).toBe('fixture/model');
        expect((await w.runtime.get(job.id))?.snapshot).toMatchObject({
          generationProfile: { harness: 'vercel-fx', model: 'fixture/model' },
        });
        expect(JSON.stringify(w.requests)).toContain(report.limitations);
        expect(await w.latest()).toEqual(before);
        expect(
          (
            await w.store.one(
              'SELECT required_reason FROM studio_investigations WHERE id=?',
              w.record.id,
            )
          ).required_reason,
        ).toBeTruthy();
        await w.service.accept(w.user, w.record.id, result.id, before.version);
        const applied = await w.latest();
        expect(applied.version).toBe(before.version + 1);
        expect(docText(applied.content.doc)).toContain(
          'production latency remains unverified',
        );
        expect(
          applied.content.doc.content.some(
            (n: any) => n.type === 'questionnaireBlock',
          ),
        ).toBe(true);
        expect(await w.store.state(w.id)).toBeTruthy();
        expect(
          (
            await w.store.one(
              'SELECT required_reason FROM studio_investigations WHERE id=?',
              w.record.id,
            )
          ).required_reason,
        ).toBeNull();
        expect(
          (
            await w.store.tx(async () => {
              await w.store.lock('project:' + w.project.id);
              return documentImplementationReadiness(w.store, applied);
            })
          ).ready,
        ).toBe(false);
        expect(
          (await w.store.decisions(w.id)).some((d) => d.status === 'accepted'),
        ).toBe(false);
        expect(
          (await w.service.view(w.user, w.record.id)).reviews[0]?.acceptedBy,
        ).toBe(w.user.id);
        await w.service.accept(w.user, w.record.id, result.id, before.version);
        expect((await w.latest()).version).toBe(applied.version);
      });
      it('keeps automatic completion review pending without an owner, then creates one proposal under the existing owner without executing local work', async () => {
        const w = await fixture();
        await w.service.tick();
        expect(
          (await w.service.view(w.user, w.record.id)).pending?.error,
        ).toContain('existing Planner owner');
        expect(await w.agent.ownership(w.user, w.id)).toBeNull();
        expect(w.requests).toHaveLength(0);
        await w.agent.claimPlanner(w.user, w.id);
        await w.store.exec('UPDATE studio_findings_candidates SET due_at=0');
        await Promise.all([w.service.tick(), w.service.tick()]);
        const rows = await w.store.all(
          "SELECT id FROM studio_durable_jobs WHERE kind='investigation.findings-review'",
        );
        expect(rows).toHaveLength(1);
        await w.execute(rows[0].id);
        await w.service.tick();
        expect(
          (await w.service.view(w.user, w.record.id)).reviews[0]?.automatic,
        ).toBe(true);
        expect(
          await w.store.all(
            "SELECT id FROM studio_investigations WHERE status IN ('queued','running')",
          ),
        ).toHaveLength(0);
      });
      it('debounces saved passage changes and refuses paused, changed-owner, locked, or viewer-driven review publication', async () => {
        const w = await fixture();
        await w.agent.claimPlanner(w.user, w.id);
        await w.agent.policy(w.user, w.id, { mode: 'manual', paused: true });
        await expect(w.service.start(w.user, w.record.id)).rejects.toThrow(
          'unpaused',
        );
        await w.agent.policy(w.user, w.id, { mode: 'manual', paused: false });
        await expect(w.service.start(w.other, w.record.id)).rejects.toThrow(
          'existing Planner owner',
        );
        await expect(w.service.start(w.viewer, w.record.id)).rejects.toThrow();
        const job = await w.service.start(w.user, w.record.id);
        await w.agent.ownership(w.user, w.id, true);
        await w.execute(job.id);
        expect((await w.runtime.get(job.id))?.status).not.toBe('completed');
        expect(w.requests).toHaveLength(0);
        await w.agent.claimPlanner(w.user, w.id);
        w.lock();
        await expect(w.service.start(w.user, w.record.id)).rejects.toThrow();
      });
      it('waits for settled source, binds the latest saved passage, and preserves the captured harness after selection changes', async () => {
        const w = await fixture();
        await w.agent.claimPlanner(w.user, w.id);
        w.service.options.quietMs = 2000;
        const before = await w.latest(),
          next = structuredClone(before.content);
        next.doc.content[0].content[0].text +=
          ' Keep the explicit operational limitation.';
        await w.collab.replace(w.id, w.user, next, before.version);
        await w.service.tick();
        expect(
          (await w.service.view(w.user, w.record.id)).reviews,
        ).toHaveLength(0);
        await w.store.exec('UPDATE studio_findings_candidates SET due_at=0');
        w.proposal.edits[0]!.original = docText(
          (await w.latest()).content.doc.content[0],
        );
        await w.service.tick();
        const job = await w.store.one(
          "SELECT id FROM studio_durable_jobs WHERE kind='investigation.findings-review'",
        );
        await w.agent.profiles.view(w.user, w.id, {
          harness: 't3-code',
          provider: 'project-default',
          model: 'project-default',
        });
        await w.execute(job.id);
        expect(
          (await w.service.view(w.user, w.record.id)).reviews[0]?.proposal,
        ).toEqual(w.proposal);
        expect(w.requests[0].fixtureModel).toBe('fixture/model');
      });
      it('waits for the selected remote owner attachment and receives a schema-checked proposal over the actual authenticated WebSocket without Gateway fallback', async () => {
        const w = await fixture();
        await w.agent.profiles.view(w.user, w.id, {
          harness: 'remote-planner',
          provider: 'operator-acp',
          model: 'remote',
        });
        await w.agent.claimPlanner(w.user, w.id);
        await expect(w.service.start(w.user, w.record.id)).rejects.toThrow(
          'attached remote Planner',
        );
        await w.app.listen({ host: '127.0.0.1', port: 0 });
        const socket = new WebSocket(
          w.app.listeningOrigin.replace('http:', 'ws:') +
            '/api/planner/connect',
          'studio.planner.v1',
        );
        cleanup.push(async () => socket.terminate());
        const frames: any[] = [];
        socket.on('message', (bytes) =>
          frames.push(JSON.parse(bytes.toString())),
        );
        await once(socket, 'open');
        socket.send(
          JSON.stringify({ type: 'attach', version: 1, artifactId: w.id }),
        );
        const until = async (check: () => boolean) => {
          const deadline = Date.now() + 3000;
          while (!check()) {
            if (Date.now() > deadline)
              throw new Error('Remote findings fixture timed out');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        await until(() => frames.some((frame) => frame.type === 'attached'));
        const job = await w.service.start(w.user, w.record.id),
          running = w.execute(job.id);
        await until(() => frames.some((frame) => frame.type === 'turn'));
        const turn = frames.find((frame) => frame.type === 'turn');
        expect(turn.input.context).toContain(report.limitations);
        expect(turn.input.brief).toContain('Return ONLY JSON');
        socket.send(
          JSON.stringify({
            type: 'result',
            requestId: turn.requestId,
            output: { text: JSON.stringify(w.proposal), content: null },
          }),
        );
        await running;
        expect(
          (await w.service.view(w.user, w.record.id)).reviews[0]?.proposal,
        ).toEqual(w.proposal);
        expect(w.requests).toHaveLength(0);
      });
      it('retains a frozen job across runtime replacement, exports attributed review history, and checks access before every export row', async () => {
        const w = await fixture();
        await w.agent.claimPlanner(w.user, w.id);
        const admitted = await w.service.start(w.user, w.record.id);
        await w.runtime.close();
        const restarted = await createDurableJobRuntime({
          store: w.store,
          dispatcher: {
            provider: 'explicit-restart-fixture',
            publish: async () => ({ provider: 'explicit-restart-fixture' }),
          },
        });
        cleanup.push(() => restarted.close());
        const service = new FindingsReviews({
          ...w.service.options,
          runtime: restarted,
        });
        await service.initialize();
        await restarted.executeJob(admitted.id, {
          messageId: 'redelivered-after-restart',
          deliveryCount: 2,
        });
        expect(
          (await service.view(w.user, w.record.id)).reviews[0]?.proposal,
        ).toEqual(w.proposal);
        const rows = [];
        for await (const row of findingsExportRows(w.store, w.id, async () => {
          await w.store.artifact(w.id, w.user.id);
        }))
          rows.push(row);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.value).toMatchObject({
          requestedBy: w.user.id,
          evidenceHash: w.record.resultHash ?? expect.any(String),
          snapshot: { generationProfile: { harness: 'vercel-fx' } },
        });
        expect(JSON.stringify(rows)).toContain(report.limitations);
        expect(JSON.stringify(rows)).not.toContain('fixture-native-key');
        let checks = 0;
        const interrupted = findingsExportRows(w.store, w.id, async () => {
          if (++checks >= 3)
            throw new HttpError(403, 'Export membership revoked');
        });
        await expect(interrupted.next()).rejects.toThrow('membership revoked');
      });
      it('lets a person acknowledge text-only findings with an exact source/evidence rationale and no invented model edit, preserving source and idempotency', async () => {
        const w = await fixture(),
          before = await w.latest(),
          state = await w.store.state(w.id),
          record = await w.store.one(
            'SELECT result_hash FROM studio_investigations WHERE id=?',
            w.record.id,
          );
        const input = {
          requestId: randomUUID(),
          version: before.version,
          resultHash: record.result_hash,
          rationale:
            'The measured local observation is already consistent with this plan; no source change is justified.',
        };
        await expect(
          w.service.acknowledge(w.viewer, w.record.id, input),
        ).rejects.toThrow();
        await expect(
          w.service.acknowledge(w.user, w.record.id, {
            ...input,
            resultHash: 'f'.repeat(64),
          }),
        ).rejects.toThrow('changed');
        await w.service.acknowledge(w.user, w.record.id, input);
        expect(await w.latest()).toEqual(before);
        expect(await w.store.state(w.id)).toEqual(state);
        expect(w.requests).toHaveLength(0);
        expect(w.native).toHaveLength(0);
        expect(
          (await w.service.view(w.user, w.record.id)).acknowledgements[0],
        ).toMatchObject({
          authorId: w.user.id,
          rationale: input.rationale,
          resultHash: input.resultHash,
        });
        expect(
          (
            await w.store.one(
              'SELECT required_reason FROM studio_investigations WHERE id=?',
              w.record.id,
            )
          ).required_reason,
        ).toBeNull();
        await w.store.touchArtifactSource(w.user, w.id);
        await w.service.acknowledge(w.user, w.record.id, input);
        await expect(
          w.service.acknowledge(w.user, w.record.id, {
            ...input,
            rationale:
              'A different statement cannot reuse this receipt identifier.',
          }),
        ).rejects.toThrow('different');
        const exported = [];
        for await (const row of findingsExportRows(w.store, w.id, async () => {
          await w.store.artifact(w.id, w.user.id);
        }))
          exported.push(row);
        expect(exported).toHaveLength(1);
        expect(exported[0]?.kind).toBe('findings-acknowledgement');
      });
      it('retains an archived findings wait without scheduling work and resumes it only after restoration and an existing owner', async () => {
        const w = await fixture();
        await w.service.tick();
        await w.store.exec('UPDATE studio_findings_candidates SET due_at=0');
        await w.store.exec('UPDATE artifacts SET archived=1 WHERE id=?', w.id);
        await w.service.tick();
        expect((await w.service.view(w.user, w.record.id)).pending?.dueAt).toBe(
          0,
        );
        expect(
          (await w.service.view(w.user, w.record.id)).reviews,
        ).toHaveLength(0);
        expect(w.native).toHaveLength(0);
        await w.store.exec('UPDATE artifacts SET archived=0 WHERE id=?', w.id);
        await w.agent.claimPlanner(w.user, w.id);
        await w.service.tick();
        expect(
          (await w.service.view(w.user, w.record.id)).reviews,
        ).toHaveLength(1);
      });
      if (adapter === 'postgres')
        it('coalesces independent PostgreSQL instances and publishes one proposal under one shared project/source lock', async () => {
          const w = await fixture();
          await w.agent.claimPlanner(w.user, w.id);
          // Reuse the exact database schema through a second actual connection pool.
          const schema = (await w.store.one('SELECT current_schema() AS name'))
            .name;
          const peer = await Store.open(
            await openDatabase({ adapter: 'postgres', url: pg!, schema }),
          );
          cleanup.push(() => peer.close());
          const runtime = await createDurableJobRuntime({
            store: peer,
            dispatcher: {
              provider: 'independent-findings-instance',
              publish: async () => ({
                provider: 'independent-findings-instance',
              }),
            },
          });
          cleanup.push(() => runtime.close());
          const collab = new Collaboration(peer, new Auth(peer, w.settings));
          await collab.initialize();
          cleanup.push(() => collab.close());
          const agent = new Agent(peer, w.settings, collab, { runtime });
          await agent.initialize();
          const service = new FindingsReviews({
            ...w.service.options,
            store: peer,
            runtime,
            collab,
            models: {
              captureProfile: (u, id) => w.models.captureProfile(u, id),
              capabilities: (p) => w.models.capabilities(p),
              decide: (input) => w.models.decide(input),
            },
            generation: {
              captureProfile: (u, id) => agent.captureProfile(u, id),
              modelForProfile: (p, key) => agent.modelForProfile(p, key),
            },
            allowed: (u, id) => agent.canParticipate(u, id),
          });
          await service.initialize();
          const [first, second] = await Promise.all([
            w.service.start(w.user, w.record.id, randomUUID(), true),
            service.start(w.user, w.record.id, randomUUID(), true),
          ]);
          expect(second.id).toBe(first.id);
          await Promise.all([
            w.execute(first.id),
            runtime.executeJob(second.id, {
              messageId: 'second-instance',
              deliveryCount: 2,
            }),
          ]);
          expect(w.requests).toHaveLength(1);
          expect(
            (await w.service.view(w.user, w.record.id)).reviews,
          ).toHaveLength(1);
        });
      it.each([0.05, 0.6, 'refused', 'error'] as const)(
        'preserves native negative/abstention/refusal/error %s without generating edits or clearing requirements',
        async (answer) => {
          const w = await fixture();
          w.setAnswer(answer);
          const result = await w.review();
          expect(result.proposal).toBeNull();
          expect(w.requests).toHaveLength(0);
          expect(result.eligibility?.status).toBe(
            answer === 'refused'
              ? 'refused'
              : answer === 'error'
                ? 'error'
                : answer === 0.6
                  ? 'abstained'
                  : 'answered',
          );
          expect(
            (
              await w.store.one(
                'SELECT required_reason FROM studio_investigations WHERE id=?',
                w.record.id,
              )
            ).required_reason,
          ).toBeTruthy();
        },
      );
      it('fences changed accepted decisions/source, rejects invented evidence quotes, and never silently truncates an oversized context', async () => {
        const w = await fixture();
        await w.agent.claimPlanner(w.user, w.id);
        let release!: () => void, entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        w.beforeGeneration(async () => {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
        const job = await w.service.start(w.user, w.record.id),
          running = w.execute(job.id);
        await started;
        await w.store.tx(async () => {
          await w.store.lock('project:' + w.project.id);
          await w.store.exec(
            'INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?)',
            randomUUID(),
            w.id,
            'Human choice',
            'Human context',
            'Use variant A',
            'Retain measured limits',
            'accepted',
            1,
            w.user.name,
            new Date().toISOString(),
          );
          await w.store.touchArtifactSource(w.user, w.id);
        });
        release();
        await running;
        expect((await w.runtime.get(job.id))?.status).not.toBe('completed');
        w.beforeGeneration();
        w.proposal.edits[0]!.evidence = 'An invented production test passed';
        const invented = await w.service.start(w.user, w.record.id);
        await w.execute(invented.id);
        expect((await w.runtime.get(invented.id))?.status).not.toBe(
          'completed',
        );
        const current = await w.latest();
        await w.collab.replace(
          w.id,
          w.user,
          {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'large unabridged source '.repeat(5000),
                    },
                  ],
                },
              ],
            },
          },
          current.version,
        );
        await expect(
          w.service.start(w.user, w.record.id),
        ).rejects.toMatchObject({ statusCode: 413 });
      });
      it('allows only browser-human mutations with Origin and fresh write access, rejects stale apply, and rolls source/requirement back together', async () => {
        const w = await fixture(),
          ready = await w.review(),
          version = (await w.latest()).version;
        const base = `/api/investigations/${w.record.id}/findings`;
        expect(
          (
            await w.app.inject({
              method: 'POST',
              url: base,
              headers: {
                origin: testSettings('/tmp').origin,
                authorization: 'Bearer model-token',
              },
              payload: { requestId: randomUUID() },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await w.app.inject({
              method: 'POST',
              url: base,
              payload: { requestId: randomUUID() },
            })
          ).statusCode,
        ).toBe(403);
        await expect(
          w.service.accept(w.viewer, w.record.id, ready.id, version),
        ).rejects.toThrow();
        w.service.options.onAccepted = async () => {
          throw new Error('Explicit atomic publication failure');
        };
        await expect(
          w.service.accept(w.user, w.record.id, ready.id, version),
        ).rejects.toThrow('atomic publication');
        expect((await w.latest()).version).toBe(version);
        expect(
          (
            await w.store.one(
              'SELECT required_reason FROM studio_investigations WHERE id=?',
              w.record.id,
            )
          ).required_reason,
        ).toBeTruthy();
        w.service.options.onAccepted = undefined;
        await w.store.touchArtifactSource(w.user, w.id);
        await expect(
          w.service.accept(w.user, w.record.id, ready.id, version),
        ).rejects.toThrow('changed');
        const read = await w.app.inject({
          url: base,
          headers: { 'x-fixture-user': w.viewer.id },
        });
        expect(read.statusCode).toBe(200);
        expect(read.json().reviews[0].stale).toBe(true);
      });
    },
  );
