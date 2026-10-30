import { getVercelOidcToken } from '@vercel/oidc';
import {
  createIdentityLeaseHandler,
  identityScopeFromEnv,
  IdentityLeaseError,
} from '../server/hosting/identity-lease.ts';
let handler: ReturnType<typeof createIdentityLeaseHandler> | undefined;
export default {
  async fetch(request: Request) {
    try {
      handler ??= createIdentityLeaseHandler({
        scope: identityScopeFromEnv(process.env),
        secret: process.env.STUDIO_JOB_SECRET ?? '',
        getToken: async (nativeRequest) => {
          try {
            return await getVercelOidcToken();
          } catch {
            const token = nativeRequest.headers.get('x-vercel-oidc-token');
            if (!token) throw new IdentityLeaseError('unavailable');
            return token;
          }
        },
      });
      return await handler(request);
    } catch {
      return Response.json(
        { error: 'identity-lease-unavailable' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
  },
};
