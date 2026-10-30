import { z } from 'zod';
export const IDENTITY_PATH = '/internal/identity/lease';
export const IDENTITY_RESPONSE_CONTEXT = '/internal/identity/lease/response';
export const IDENTITY_MAX_BYTES = 8192;
export const IDENTITY_LEASE_MS = 300_000;
export const IDENTITY_CLOCK_SKEW_MS = 5000;
const deployment = z.string().regex(/^dpl_[A-Za-z0-9_-]{1,146}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const environment = z.enum(['production', 'preview', 'development']);
export const identityRequestSchema = z
  .object({ schemaVersion: z.literal(1), nonce, deploymentId: deployment })
  .strict();
export const identityResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    nonce,
    deploymentId: deployment,
    ownerId: z.string().min(1).max(150),
    projectId: z.string().min(1).max(150),
    environment,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    token: z
      .string()
      .min(1)
      .max(7000)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  })
  .strict();
export type IdentityScope = Readonly<{
  ownerId: string;
  ownerSlug: string;
  projectId: string;
  projectName: string;
  environment: z.infer<typeof environment>;
  deploymentId: string;
  issuer: string;
  audience: string;
}>;
export type IdentityLeaseFailureCode =
  | 'configuration'
  | 'authorization'
  | 'body-limit'
  | 'request'
  | 'deployment'
  | 'transport'
  | 'response'
  | 'verification'
  | 'expired'
  | 'unavailable';
export class IdentityLeaseError extends Error {
  constructor(readonly code: IdentityLeaseFailureCode) {
    super('Provider identity lease is unavailable.');
    this.name = 'IdentityLeaseError';
  }
}
export function checkedIdentityScope(value: IdentityScope): IdentityScope {
  if (
    !/^(team|user)_[A-Za-z0-9]+$/.test(value.ownerId) ||
    !/^[a-z0-9][a-z0-9-]{0,100}$/.test(value.ownerSlug) ||
    !/^prj_[A-Za-z0-9]+$/.test(value.projectId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.projectName) ||
    !deployment.safeParse(value.deploymentId).success ||
    !environment.safeParse(value.environment).success ||
    ![
      'https://oidc.vercel.com',
      'https://oidc.vercel.com/' + value.ownerSlug,
    ].includes(value.issuer) ||
    value.audience !== 'https://vercel.com/' + value.ownerSlug
  )
    throw new IdentityLeaseError('configuration');
  return Object.freeze({ ...value });
}
export function identityScopeFromEnv(env: NodeJS.ProcessEnv): IdentityScope {
  return checkedIdentityScope({
    ownerId: env.STUDIO_IDENTITY_OWNER_ID ?? '',
    ownerSlug: env.STUDIO_IDENTITY_OWNER_SLUG ?? '',
    projectId: env.VERCEL_PROJECT_ID ?? '',
    projectName: env.STUDIO_IDENTITY_PROJECT_NAME ?? '',
    environment: (env.VERCEL_ENV ?? '') as IdentityScope['environment'],
    deploymentId: env.VERCEL_DEPLOYMENT_ID ?? '',
    issuer: env.STUDIO_IDENTITY_ISSUER ?? '',
    audience: env.STUDIO_IDENTITY_AUDIENCE ?? '',
  });
}
export async function boundedIdentityText(
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!body) throw new IdentityLeaseError('response');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > IDENTITY_MAX_BYTES)
        throw new IdentityLeaseError('body-limit');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof IdentityLeaseError) throw error;
    throw new IdentityLeaseError('response');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
