import type { RepositoryIdentitySettings } from './ports.ts';
export function repositoryIdentitySettingsFromEnv(
  env: NodeJS.ProcessEnv,
): RepositoryIdentitySettings | undefined {
  const clientId = env.STUDIO_GITHUB_CLIENT_ID,
    clientSecret = env.STUDIO_GITHUB_CLIENT_SECRET,
    encryptionKey = env.STUDIO_REPOSITORY_TOKEN_KEY;
  if (!clientId && !clientSecret && !encryptionKey) return undefined;
  if (!clientId || !clientSecret || !encryptionKey)
    throw new Error(
      'GitHub repository identity requires STUDIO_GITHUB_CLIENT_ID, STUDIO_GITHUB_CLIENT_SECRET, and STUDIO_REPOSITORY_TOKEN_KEY',
    );
  const leaseSeconds = Number(env.STUDIO_REPOSITORY_LEASE_SECONDS ?? 30);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
    throw new Error(
      'Repository permission leases must be between 5 and 300 seconds',
    );
  const kind = env.STUDIO_GITHUB_CLIENT_KIND ?? 'github-app';
  if (kind !== 'github-app' && kind !== 'oauth-app')
    throw new Error(
      'STUDIO_GITHUB_CLIENT_KIND must be github-app or oauth-app',
    );
  if (env.NODE_ENV === 'production' && env.STUDIO_GITHUB_ALLOW_LOOPBACK === '1')
    throw new Error(
      'Loopback GitHub protocol endpoints are restricted to development',
    );
  return {
    clientId,
    clientSecret,
    encryptionKey,
    kind,
    leaseSeconds,
    authorizationUrl: env.STUDIO_GITHUB_AUTHORIZATION_URL,
    tokenUrl: env.STUDIO_GITHUB_TOKEN_URL,
    apiBaseUrl: env.STUDIO_GITHUB_API_URL,
    allowLoopback: env.STUDIO_GITHUB_ALLOW_LOOPBACK === '1',
    webhookSecret: env.STUDIO_GITHUB_WEBHOOK_SECRET,
  };
}
