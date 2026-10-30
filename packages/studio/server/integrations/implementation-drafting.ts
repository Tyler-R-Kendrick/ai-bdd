import { readPlanSource } from '../plan-source.ts';
import { planSourceText, type PlanSource } from '../../shared/plan-source.ts';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentProfile } from '../../shared/agent-profile.ts';
import type { Auth } from '../auth.ts';
import { HttpError, hash, type Store } from '../store.ts';
import type { Artifact, User } from '../../shared/domain.ts';
import { docText } from '../../shared/domain.ts';
import {
  implementationDefinitionSchema,
  implementationPointer,
  type ImplementationDefinition,
  type ImplementationPointer,
} from '../../shared/implementation.ts';
import type {
  DurableJobContext,
  DurableJobRuntime,
} from '../runtime/contracts.ts';
import type { ImplementationGraphs } from './implementation.ts';

type Snapshot = {
  user: User;
  artifact: Artifact;
  text: string;
  source?: PlanSource;
  sourceSha256?: string;
  expected: ImplementationPointer | null;
  profile?: AgentProfile;
};
type Options = {
  store: Store;
  runtime: DurableJobRuntime;
  graphs: ImplementationGraphs;
  provider?: (input: {
    artifact: Artifact;
    text: string;
    signal: AbortSignal;
    idempotencyKey: string;
    profile?: AgentProfile;
  }) => Promise<ImplementationDefinition>;
  allowed: (user: User, id: string) => Promise<boolean>;
  onAdmit: (user: User, id: string) => Promise<void>;
  captureProfile?: (user: User, id: string) => Promise<AgentProfile>;
  assertReady?: (artifact: Artifact) => Promise<void>;
  publish?: (projectId: string, artifactId: string) => Promise<void>;
};
/** Drafting never approves or executes a task. Source and graph revisions fence publication. */
export class ImplementationDrafting {
  constructor(readonly options: Options) {}
  async initialize() {
    await this.options.store.tx(async () => {
      await this.options.store.lock('schema:studio.implementation-drafting');
      await this.options.store.db.exec(
        'CREATE TABLE IF NOT EXISTS implementation_draft_requests(artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES studio_durable_jobs(id),PRIMARY KEY(artifact_id,user_id,request_id))',
      );
    });
    this.options.runtime.register('implementation.draft', (ctx) =>
      this.execute(ctx),
    );
  }
  async jobs(user: User, id: string) {
    await this.options.store.artifact(id, user.id);
    return this.options.store.all(
      "SELECT id,status,error,created_at AS createdAt FROM studio_durable_jobs WHERE artifact_id=? AND kind='implementation.draft' ORDER BY created_at DESC,id DESC LIMIT 20",
      id,
    );
  }
  async start(user: User, id: string, requestId = randomUUID() as string) {
    z.string().uuid().parse(requestId);
    const { store, runtime, graphs, provider, allowed, onAdmit, assertReady } =
      this.options;
    if (!provider)
      throw new HttpError(
        503,
        'Connect a model before generating implementation tasks',
      );
    const initial = await store.artifact(id, user.id, 'write');
    const job = await store.tx(async () => {
      await store.lock('project:' + initial.projectId);
      const artifact = await store.artifact(id, user.id, 'write');
      const previous = await store.one(
        'SELECT job_id FROM implementation_draft_requests WHERE artifact_id=? AND user_id=? AND request_id=?',
        id,
        user.id,
        requestId,
      );
      if (previous) return (await runtime.get(previous.job_id))!;
      if (!(await allowed(user, id)))
        throw new HttpError(
          409,
          'Planner participation is paused, owned by another participant, or implementation-locked',
        );
      const active = await store.one(
        "SELECT id FROM studio_durable_jobs WHERE artifact_id=? AND kind='implementation.draft' AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
        id,
      );
      if (active) {
        await store.exec(
          'INSERT INTO implementation_draft_requests VALUES(?,?,?,?)',
          id,
          user.id,
          requestId,
          active.id,
        );
        return (await runtime.get(active.id))!;
      }
      if (!['design', 'document'].includes(artifact.kind))
        throw new HttpError(400, 'Implementation tasks require a document');
      await assertReady?.(artifact);
      await onAdmit(user, id);
      const profile = await this.options.captureProfile?.(user, id);
      const source = await readPlanSource(store, artifact),
        text = planSourceText(source);
      if (!docText(artifact.content.doc).trim())
        throw new HttpError(
          409,
          'Write the plan before generating implementation tasks',
        );
      if (Buffer.byteLength(text) > 70000)
        throw new HttpError(
          413,
          'The plan exceeds the model draft context limit; edit the task graph directly or split the document',
        );
      const current = await graphs.read(user, id),
        expected = current.graph ? implementationPointer(current.graph) : null;
      const snapshot: Snapshot = {
        ...(profile ? { profile } : {}),
        user,
        artifact: { ...artifact, content: {} },
        text,
        source,
        sourceSha256: hash(JSON.stringify(source)),
        expected,
      };
      const admitted = await runtime.enqueue({
        kind: 'implementation.draft',
        projectId: artifact.projectId,
        artifactId: id,
        principalId: user.id,
        artifactVersion: artifact.version,
        snapshot,
        idempotencyKey: 'draft:' + id + ':' + user.id + ':' + requestId,
        maxAttempts: 3,
      });
      await store.exec(
        'INSERT INTO implementation_draft_requests VALUES(?,?,?,?)',
        id,
        user.id,
        requestId,
        admitted.id,
      );
      return admitted;
    });
    await runtime.flushOutbox();
    return { id: job.id, status: job.status };
  }
  private async execute(ctx: DurableJobContext) {
    const s = ctx.snapshot as Snapshot,
      { graphs, provider, allowed, assertReady, publish } = this.options;
    await ctx.assertCurrent({ requireCurrentVersion: true });
    if (!provider || !(await allowed(s.user, s.artifact.id)))
      throw new HttpError(409, 'Planner participation is unavailable');
    const definition = await ctx.step(
      'generate-task-graph',
      async (idempotencyKey) =>
        implementationDefinitionSchema.parse(
          await provider({
            artifact: s.artifact,
            text: s.text,
            signal: ctx.signal,
            idempotencyKey,
            profile: s.profile,
          }),
        ),
    );
    return ctx.commit(
      'publish-draft',
      async () => {
        if (!(await allowed(s.user, s.artifact.id)))
          throw new HttpError(
            409,
            'Planner participation changed while tasks were generated',
          );
        const current = await this.options.store.artifact(
          s.artifact.id,
          s.user.id,
          'write',
        );
        const source = await readPlanSource(this.options.store, current);
        if (
          s.sourceSha256
            ? hash(JSON.stringify(source)) !== s.sourceSha256
            : !!source.acceptedDecisions?.length
        )
          throw new HttpError(
            409,
            'Accepted decisions or source changed; regenerate the task graph from the current plan.',
          );
        await assertReady?.(current);
        const graph = await graphs.editInTransaction(
          { user: s.user, kind: 'agent', agentId: 'studio-planner' },
          s.artifact.id,
          {
            expected: s.expected,
            planRevision: s.artifact.version,
            definition,
          },
        );
        await publish?.(s.artifact.projectId, s.artifact.id);
        return {
          graphVersion: graph.graphVersion,
          draftRevision: graph.draftRevision,
          planRevision: graph.planRevision,
        };
      },
      { requireCurrentVersion: true },
    );
  }
}
export function registerImplementationDraftRoutes(
  app: FastifyInstance,
  auth: Auth,
  service: ImplementationDrafting,
) {
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/implementation/draft',
    async (request) => ({
      jobs: await service.jobs(await auth.user(request), request.params.id),
    }),
  );
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/implementation/draft',
    async (request) =>
      service.start(
        await auth.user(request),
        request.params.id,
        z.object({ requestId: z.string().uuid() }).strict().parse(request.body)
          .requestId,
      ),
  );
}
