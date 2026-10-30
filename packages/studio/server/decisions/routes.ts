import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decisionProfileSchema } from '../../shared/decision-profile.ts';
import type { Auth } from '../auth.ts';
import { HttpError } from '../store.ts';
import type { DecisionModels } from './models.ts';
export function registerDecisionRoutes(
  app: FastifyInstance,
  dependencies: { auth: Auth; models: DecisionModels },
) {
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/decision/profile',
    async (req) =>
      dependencies.models.profile(
        await dependencies.auth.user(req),
        req.params.id,
      ),
  );
  app.put<{ Params: { id: string } }>(
    '/api/artifacts/:id/decision/profile',
    async (req) =>
      dependencies.models.profile(
        await dependencies.auth.user(req),
        req.params.id,
        decisionProfileSchema.parse(req.body),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/decision/evaluations',
    async (req) => ({
      evaluations: await dependencies.models.history(
        await dependencies.auth.user(req),
        req.params.id,
      ),
    }),
  );
  app.get<{ Params: { id: string; evaluationId: string } }>(
    '/api/artifacts/:id/decision/evaluations/:evaluationId',
    async (req) => {
      const user = await dependencies.auth.user(req);
      await dependencies.models.options.store.artifact(
        req.params.id,
        user.id,
      );
      const row = await dependencies.models.options.store.one(
        'SELECT artifact_id FROM studio_decision_calls WHERE id=?',
        z.string().uuid().parse(req.params.evaluationId),
      );
      if (!row || row.artifact_id !== req.params.id)
        throw new HttpError(404, 'Decision evaluation not found');
      return dependencies.models.readEvaluation(
        user,
        req.params.evaluationId,
      );
    },
  );
}
