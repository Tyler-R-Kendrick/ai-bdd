import { assertCronSecret } from '../server/hosting/internal-auth.ts';
import {
  bindingConfigFromEnv,
  forwardInternal,
} from '../server/hosting/binding.ts';
export default {
  async fetch(request: Request) {
    if (request.method !== 'GET')
      return new Response(null, { status: 405, headers: { allow: 'GET' } });
    try {
      assertCronSecret(
        process.env.CRON_SECRET,
        request.headers.get('authorization'),
      );
    } catch {
      return Response.json(
        { error: 'Maintenance authorization failed' },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      );
    }
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (!deploymentId)
      return Response.json(
        { error: 'Deployment identity is unavailable' },
        { status: 503 },
      );
    await forwardInternal(
      bindingConfigFromEnv(process.env),
      '/internal/maintenance/activate',
      { deploymentId },
      request.signal,
    );
    return Response.json(
      { accepted: true },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
};
