import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { Auth } from '../auth.ts';
import type { ImplementationGraphs } from './implementation.ts';
import {
  implementationEditSchema,
  implementationPointerSchema,
  implementationClaimSchema,
  implementationReportSchema,
  type ImplementationActor,
} from '../../shared/implementation.ts';

/** Attribution comes from the authenticated transport, never editable request fields. */
export async function implementationActor(
  auth: Auth,
  request: FastifyRequest,
): Promise<ImplementationActor> {
  const user = await auth.user(request);
  const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  return bearer
    ? {
        user,
        kind: 'agent',
        agentId: 'api:' + createHash('sha256').update(bearer).digest('hex'),
      }
    : { user, kind: 'human' };
}

export async function registerImplementationRoutes(
  app: FastifyInstance,
  { auth, graphs }: { auth: Auth; graphs: ImplementationGraphs },
) {
  const base = '/api/artifacts/:id/implementation';
  app.get<{ Params: { id: string } }>(base, async (request) =>
    graphs.read(await auth.user(request), request.params.id),
  );
  app.get<{ Params: { id: string } }>(base + '/history', async (request) =>
    graphs.history(await auth.user(request), request.params.id),
  );
  app.put<{ Params: { id: string } }>(base + '/graph', async (request) =>
    graphs.edit(
      await implementationActor(auth, request),
      request.params.id,
      implementationEditSchema.parse(request.body),
    ),
  );
  app.post<{ Params: { id: string } }>(base + '/approve', async (request) =>
    graphs.approve(
      await implementationActor(auth, request),
      request.params.id,
      implementationPointerSchema.parse(request.body),
    ),
  );
  app.post<{ Params: { id: string } }>(base + '/claim', async (request) =>
    graphs.claim(
      await implementationActor(auth, request),
      request.params.id,
      implementationClaimSchema.parse(request.body),
    ),
  );
  app.post<{ Params: { id: string } }>(base + '/report', async (request) =>
    graphs.report(
      await implementationActor(auth, request),
      request.params.id,
      implementationReportSchema.parse(request.body),
    ),
  );
}
