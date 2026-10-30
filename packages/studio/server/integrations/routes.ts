import type { FastifyInstance } from 'fastify';
import { setImmediate } from 'node:timers/promises';
import type { User } from '../../shared/domain.ts';
import { z } from 'zod';
import type { Auth, Settings } from '../auth.ts';
import { Store, HttpError } from '../store.ts';
import type { Agent } from '../agent.ts';
import type { Collaboration } from '../collaboration.ts';
import { agentPolicySchema, designModes } from '../../shared/integrations.ts';
import type { IntegrationSettings } from './settings.ts';
import { OpenDesignService } from './open-design.ts';
import { MachineService } from './machines.ts';
export type IntegrationRouteDependencies = {
  auth: Auth;
  store: Store;
  agent: Agent;
  collab: Collaboration;
  settings: Settings & {
    integrations?: IntegrationSettings;
  };
};
const id = z.string().uuid();
const fields = z
  .record(z.string().max(100), z.json())
  .refine(
    (value) => JSON.stringify(value).length <= 30000,
    'Design fields are too large',
  );
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export async function registerIntegrationRoutes(
  app: FastifyInstance,
  dependencies: IntegrationRouteDependencies,
) {
  const { auth, store, agent, collab, settings } = dependencies;
  const integrations = settings.integrations ?? {};
  const design = new OpenDesignService(store, integrations),
    machines = new MachineService(store, collab);
  await design.initialize();
  await machines.initialize();
  app.get<{
    Params: {
      id: string;
    };
  }>('/api/artifacts/:id/integrations', async (request) => {
    const user = await auth.user(request),
      artifact = await store.artifact(request.params.id, user.id);
    return {
      capabilities: {
        model: !!settings.model || !!settings.integrations?.remotePlanner,
        research: {
          provider: integrations.searchUrl ? 'gateway' : 'wikipedia',
          configured: true,
        },
        repository: !!(
          await store.one(
            'SELECT repository FROM projects WHERE id=?',
            artifact.projectId,
          )
        )?.repository,
        openDesign: {
          configured: !!integrations.openDesign,
          modeRequiresExplicitSelection: true,
        },
        machines: true,
      },
      policy: await agent.policy(user, artifact.id),
      jobs: await agent.jobs(user, artifact.id),
      design: await design.list(user, artifact.id),
      work: await machines.list(user, artifact.id),
      machines: await machines.machines(user, artifact.projectId),
    };
  });
  app.get<{
    Params: {
      id: string;
    };
  }>('/api/artifacts/:id/integrations/jobs', async (request) => ({
    jobs: await agent.jobs(await auth.user(request), request.params.id),
  }));
  app.get<{
    Params: {
      id: string;
    };
  }>(
    '/api/artifacts/:id/integrations/policy',
    async (request) =>
      await agent.policy(await auth.user(request), request.params.id),
  );
  app.put<{
    Params: {
      id: string;
    };
  }>(
    '/api/artifacts/:id/integrations/policy',
    async (request) =>
      await agent.policy(
        await auth.user(request),
        request.params.id,
        agentPolicySchema.parse(request.body),
      ),
  );
  app.post<{
    Params: {
      id: string;
      jobId: string;
    };
  }>('/api/artifacts/:id/integrations/jobs/:jobId/cancel', async (request) => {
    const user = await auth.user(request),
      artifact = await store.artifact(request.params.id, user.id, 'write');
    const job = await store.one(
      'SELECT id,status FROM studio_agent_jobs WHERE id=? AND artifact_id=?',
      id.parse(request.params.jobId),
      artifact.id,
    );
    if (!job) throw new HttpError(404, 'Agent request not found');
    await agent.cancel(user, artifact.id, job.id);
    return { ok: true };
  });
  app.get<{
    Params: {
      id: string;
    };
  }>(
    '/api/artifacts/:id/open-design/schema',
    async (request) =>
      await design.schema(await auth.user(request), request.params.id),
  );
  app.post<{
    Params: {
      id: string;
    };
  }>('/api/artifacts/:id/open-design/brief', async (request) => {
    const body = z
      .object({
        mode: z.enum(designModes),
        locale: z.string().max(30),
        fields,
        skip: z.boolean().default(false),
      })
      .strict()
      .parse(request.body);
    return await design.begin(
      await auth.user(request),
      request.params.id,
      body.mode,
      body.locale,
      body.fields,
      body.skip,
    );
  });
  app.post<{
    Params: {
      id: string;
      flowId: string;
    };
  }>('/api/artifacts/:id/open-design/:flowId/confirm', async (request) => {
    const body = z.object({ answers: fields }).strict().parse(request.body);
    return await design.confirm(
      await auth.user(request),
      request.params.id,
      id.parse(request.params.flowId),
      body.answers,
    );
  });
  app.post<{
    Params: {
      id: string;
      flowId: string;
    };
  }>('/api/artifacts/:id/open-design/:flowId/inspect', async (request) => {
    const body = z
      .object({
        action: z.enum([
          'login-status',
          'start-login',
          'agents',
          'profiles',
          'projects',
        ]),
      })
      .strict()
      .parse(request.body);
    return await design.inspect(
      await auth.user(request),
      request.params.id,
      id.parse(request.params.flowId),
      body.action,
    );
  });
  app.post<{
    Params: {
      id: string;
      flowId: string;
    };
  }>('/api/artifacts/:id/open-design/:flowId/start', async (request) => {
    const body = z
      .object({
        projectId: z.string().min(1).max(300),
        prompt: z.string().min(1).max(20000),
        byokProfile: z.string().min(1).max(200).optional(),
        resume: z.boolean().default(false),
      })
      .strict()
      .parse(request.body);
    return await design.start(
      await auth.user(request),
      request.params.id,
      id.parse(request.params.flowId),
      body,
      body.resume,
    );
  });
  app.post<{
    Params: {
      id: string;
      flowId: string;
    };
  }>(
    '/api/artifacts/:id/open-design/:flowId/poll',
    async (request) =>
      await design.poll(
        await auth.user(request),
        request.params.id,
        id.parse(request.params.flowId),
      ),
  );
  app.post<{
    Params: {
      id: string;
      flowId: string;
    };
  }>(
    '/api/artifacts/:id/open-design/:flowId/cancel',
    async (request) =>
      await design.cancel(
        await auth.user(request),
        request.params.id,
        id.parse(request.params.flowId),
      ),
  );
  app.post<{
    Params: {
      projectId: string;
    };
  }>('/api/projects/:projectId/machines/pairing', async (request) => {
    const body = z
      .object({ label: z.string().trim().min(1).max(120) })
      .strict()
      .parse(request.body);
    return await machines.pairing(
      await auth.user(request),
      id.parse(request.params.projectId),
      body.label,
    );
  });
  app.post(
    '/api/machines/pair',
    async (request) =>
      await machines.pair(
        z.object({ code: secret }).strict().parse(request.body).code,
      ),
  );
  app.delete<{
    Params: {
      projectId: string;
      machineId: string;
    };
  }>('/api/projects/:projectId/machines/:machineId', async (request) => {
    await machines.revoke(
      await auth.user(request),
      id.parse(request.params.projectId),
      id.parse(request.params.machineId),
    );
    return { ok: true };
  });
  app.post<{
    Params: {
      machineId: string;
    };
  }>('/api/machines/:machineId/heartbeat', async (request) => {
    const body = z
      .object({ workId: id.optional(), leaseToken: secret.optional() })
      .strict()
      .parse(request.body ?? {});
    return await machines.heartbeat(
      await machines.authenticate(request, id.parse(request.params.machineId)),
      body.workId,
      body.leaseToken,
    );
  });
  app.post<{
    Params: {
      machineId: string;
    };
  }>(
    '/api/machines/:machineId/claim',
    async (request) =>
      await machines.claim(
        await machines.authenticate(
          request,
          id.parse(request.params.machineId),
        ),
      ),
  );
  app.post<{
    Params: {
      machineId: string;
      workId: string;
    };
  }>('/api/machines/:machineId/work/:workId/complete', async (request) => {
    const body = z
      .object({
        leaseToken: secret,
        summary: z.string().trim().min(1).max(20000),
        content: z.record(z.string(), z.json()).optional(),
        pullRequestUrl: z
          .string()
          .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[0-9]+$/)
          .optional(),
      })
      .strict()
      .parse(request.body);
    return await machines.complete(
      await machines.authenticate(request, id.parse(request.params.machineId)),
      id.parse(request.params.workId),
      body.leaseToken,
      body,
    );
  });
  app.post<{
    Params: {
      machineId: string;
      workId: string;
    };
  }>('/api/machines/:machineId/work/:workId/fail', async (request) => {
    const body = z.object({ leaseToken: secret }).strict().parse(request.body);
    return await machines.fail(
      await machines.authenticate(request, id.parse(request.params.machineId)),
      id.parse(request.params.workId),
      body.leaseToken,
    );
  });
  app.post<{
    Params: {
      id: string;
    };
  }>('/api/artifacts/:id/machine-work', async (request) => {
    const body = z
      .object({
        version: z.number().int().positive(),
        kind: z.enum(['implementation', 'investigation']),
        brief: z.string().trim().min(1).max(20000),
      })
      .strict()
      .parse(request.body);
    return await machines.queue(
      await auth.user(request),
      request.params.id,
      body,
    );
  });
  app.post<{
    Params: {
      id: string;
      workId: string;
    };
  }>(
    '/api/artifacts/:id/machine-work/:workId/review',
    async (request) =>
      await machines.review(
        await auth.user(request),
        request.params.id,
        id.parse(request.params.workId),
        z.object({ accept: z.boolean() }).strict().parse(request.body).accept,
      ),
  );
  app.post<{
    Params: {
      id: string;
      workId: string;
    };
  }>(
    '/api/artifacts/:id/machine-work/:workId/cancel',
    async (request) =>
      await machines.cancel(
        await auth.user(request),
        request.params.id,
        id.parse(request.params.workId),
      ),
  );
  return { design, machines };
}
/** Stream public lifecycle history without credentials or signed envelopes. Cursors pin the export's row bounds. */
export async function* integrationExportRows(
  store: Store,
  user: User,
  artifactId: string,
) {
  await store.artifact(artifactId, user.id);
  const policy = await store.one(
    'SELECT mode,paused FROM studio_agent_policy WHERE artifact_id=?',
    artifactId,
  );
  yield {
    kind: 'agentPolicy',
    value: policy
      ? { mode: policy.mode, paused: !!policy.paused }
      : { mode: 'manual', paused: false },
  };
  const tables = [
    {
      name: 'studio_agent_jobs',
      kind: 'agentJob',
      columns:
        'rowid AS sequence,id,thread_id AS threadId,intent,brief,artifact_version AS artifactVersion,status,child_artifact_id AS childArtifactId,error,sources,created_at AS createdAt,finished_at AS finishedAt',
    },
    {
      name: 'studio_machine_work',
      kind: 'machineWork',
      columns:
        'rowid AS sequence,id,artifact_version AS artifactVersion,kind,brief,status,result,error,created_at AS createdAt,updated_at AS updatedAt',
    },
    {
      name: 'studio_design_flows',
      kind: 'designWorkflow',
      columns: 'rowid AS sequence,state',
    },
  ] as const;
  const cutoffs = await Promise.all(
    tables.map(async (table) =>
      Number(
        (
          await store.one(
            `SELECT coalesce(max(rowid),0) AS n FROM ${table.name} WHERE artifact_id=?`,
            artifactId,
          )
        ).n,
      ),
    ),
  );
  for (const [index, table] of tables.entries()) {
    let cursor = 0;
    while (true) {
      await store.artifact(artifactId, user.id);
      const rows = await store.all(
        `SELECT ${table.columns} FROM ${table.name} WHERE artifact_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 10`,
        artifactId,
        cursor,
        cutoffs[index],
      );
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.sequence;
        delete row.sequence;
        if (table.kind === 'agentJob') row.sources = JSON.parse(row.sources);
        if (table.kind === 'machineWork')
          row.result = row.result ? JSON.parse(row.result) : null;
        if (table.kind === 'designWorkflow') {
          const flow = JSON.parse(row.state);
          yield {
            kind: table.kind,
            value: {
              id: flow.id,
              mode: flow.mode,
              status: flow.status,
              createdAt: flow.createdAt,
              updatedAt: flow.updatedAt,
              studioUrl: flow.result?.studioUrl,
              previewUrl: flow.result?.previewUrl,
            },
          };
        } else yield { kind: table.kind, value: row };
      }
      await setImmediate();
    }
  }
}
