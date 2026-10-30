import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User } from '../../shared/domain.ts';
import { HttpError } from '../store.ts';
import type { UploadAdmission } from './uploads.ts';
/** Uses the application's same session/bearer authorization and origin check. */
export async function registerHostingRoutes(
  app: FastifyInstance,
  options: {
    uploads?: UploadAdmission;
    user: (request: FastifyRequest) => Promise<User>;
    assertOrigin: (request: FastifyRequest) => void;
  },
) {
  app.get('/api/hosting/uploads', async (request) => {
    await options.user(request);
    return {
      adapter: options.uploads ? 'direct-private-blob' : 'multipart',
      maximumSizeInBytes: options.uploads
        ? 100 * 1024 * 1024
        : 10 * 1024 * 1024,
    };
  });
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/uploads',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      options.assertOrigin(request);
      const user = await options.user(request);
      if (!options.uploads)
        throw new HttpError(404, 'Direct uploads are unavailable');
      return options.uploads.grant(user, request.params.id, request.body);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/hosting/uploads/:id/complete',
    async (request) => {
      options.assertOrigin(request);
      const user = await options.user(request);
      if (!options.uploads)
        throw new HttpError(404, 'Direct uploads are unavailable');
      return options.uploads.complete(user, request.params.id);
    },
  );
}
