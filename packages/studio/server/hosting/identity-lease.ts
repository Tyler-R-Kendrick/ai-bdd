import { randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { assertInternalRequest, internalHeaders } from './internal-auth.ts';
import {
  boundedIdentityText,
  checkedIdentityScope,
  identityRequestSchema,
  identityResponseSchema,
  IdentityLeaseError,
  IDENTITY_PATH,
  IDENTITY_RESPONSE_CONTEXT,
  IDENTITY_LEASE_MS,
  IDENTITY_CLOCK_SKEW_MS,
  type IdentityScope,
} from './identity-protocol.ts';
export {
  identityScopeFromEnv,
  IdentityLeaseError,
  type IdentityScope,
} from './identity-protocol.ts';
const brand: unique symbol = Symbol('validated-provider-identity');
const validated = new WeakSet<object>();
export type ValidatedIdentityLease = Readonly<{
  [brand]: true;
  token: string;
  expiresAt: number;
  ownerId: string;
  projectId: string;
  environment: IdentityScope['environment'];
  deploymentId: string;
}>;
export function isValidatedIdentityLease(
  value: unknown,
): value is ValidatedIdentityLease {
  return typeof value === 'object' && value !== null && validated.has(value);
}
async function beforeDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new IdentityLeaseError('transport');
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new IdentityLeaseError('transport'));
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject);
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
type Options = {
  scope: IdentityScope;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
};
class IdentityTokenVerifier {
  readonly scope: IdentityScope;
  readonly clock: () => number;
  readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(options: Options) {
    this.scope = checkedIdentityScope(options.scope);
    this.clock = options.clock ?? Date.now;
    const jwksUrl = new URL('https://oidc.vercel.com/.well-known/jwks');
    const fetcher = options.fetch ?? globalThis.fetch;
    this.keys = createRemoteJWKSet(jwksUrl, {
      timeoutDuration: 2000,
      cooldownDuration: 1000,
      cacheMaxAge: 600_000,
      [customFetch]: async (input, init) => {
        if (String(input) !== jwksUrl.href)
          throw new IdentityLeaseError('verification');
        const response = await fetcher(input, {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(2000),
          ]),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new IdentityLeaseError('verification');
        }
        return new Response(await boundedIdentityText(response.body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
  }
  async verify(token: string, validUntil: number) {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.scope.issuer,
        audience: this.scope.audience,
        subject: `owner:${this.scope.ownerSlug}:project:${this.scope.projectName}:environment:${this.scope.environment}`,
        algorithms: ['RS256'],
        typ: 'JWT',
        clockTolerance: IDENTITY_CLOCK_SKEW_MS / 1000,
        currentDate: new Date(this.clock()),
        requiredClaims: [
          'iat',
          'exp',
          'owner',
          'owner_id',
          'project',
          'project_id',
          'environment',
        ],
      });
      if (
        payload.owner !== this.scope.ownerSlug ||
        payload.owner_id !== this.scope.ownerId ||
        payload.project !== this.scope.projectName ||
        payload.project_id !== this.scope.projectId ||
        payload.environment !== this.scope.environment ||
        payload.aud !== this.scope.audience ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat! * 1000 > this.clock() + IDENTITY_CLOCK_SKEW_MS ||
        payload.exp! * 1000 < validUntil + 30_000
      )
        throw new IdentityLeaseError('verification');
    } catch {
      throw new IdentityLeaseError('verification');
    }
  }
}
export type PrivateIdentityLeaseClientOptions = Options & {
  bindingUrl: string;
  secret: string;
};
export class PrivateIdentityLeaseClient {
  readonly #scope: IdentityScope;
  readonly #secret: string;
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: () => number;
  readonly #verifier: IdentityTokenVerifier;
  constructor(options: PrivateIdentityLeaseClientOptions) {
    this.#scope = checkedIdentityScope(options.scope);
    this.#secret = options.secret;
    try {
      const url = new URL(options.bindingUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error();
      this.#url = new URL(IDENTITY_PATH, url);
    } catch {
      throw new IdentityLeaseError('configuration');
    }
    if (options.secret.length < 32)
      throw new IdentityLeaseError('configuration');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#verifier = new IdentityTokenVerifier(options);
  }
  async acquire(): Promise<ValidatedIdentityLease> {
    const start = this.#clock();
    const nonce = randomBytes(32).toString('base64url');
    const body = JSON.stringify({
      schemaVersion: 1,
      nonce,
      deploymentId: this.#scope.deploymentId,
    });
    try {
      const deadline = AbortSignal.timeout(5000);
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: internalHeaders(this.#secret, IDENTITY_PATH, body, start),
        body,
        redirect: 'manual',
        cache: 'no-store',
        signal: deadline,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new IdentityLeaseError('transport');
      }
      const raw = await boundedIdentityText(response.body);
      assertInternalRequest(
        this.#secret,
        IDENTITY_RESPONSE_CONTEXT,
        raw,
        {
          time: response.headers.get('x-studio-time') ?? undefined,
          signature: response.headers.get('x-studio-signature') ?? undefined,
        },
        this.#clock(),
      );
      const item = identityResponseSchema.parse(JSON.parse(raw));
      const now = this.#clock();
      if (
        item.nonce !== nonce ||
        item.deploymentId !== this.#scope.deploymentId ||
        item.ownerId !== this.#scope.ownerId ||
        item.projectId !== this.#scope.projectId ||
        item.environment !== this.#scope.environment ||
        item.issuedAt < start - IDENTITY_CLOCK_SKEW_MS ||
        item.issuedAt > now + IDENTITY_CLOCK_SKEW_MS ||
        item.expiresAt <= now ||
        item.expiresAt - item.issuedAt > IDENTITY_LEASE_MS ||
        item.expiresAt <= item.issuedAt ||
        deadline.aborted
      )
        throw new IdentityLeaseError('response');
      await beforeDeadline(
        this.#verifier.verify(item.token, item.expiresAt),
        deadline,
      );
      if (deadline.aborted || this.#clock() >= item.expiresAt)
        throw new IdentityLeaseError('expired');
      const lease = {
        expiresAt: item.expiresAt,
        ownerId: item.ownerId,
        projectId: item.projectId,
        environment: item.environment,
        deploymentId: item.deploymentId,
      };
      Object.defineProperties(lease, {
        token: { value: item.token, enumerable: false },
        [brand]: { value: true, enumerable: false },
      });
      validated.add(lease);
      return Object.freeze(lease) as ValidatedIdentityLease;
    } catch (error) {
      if (error instanceof IdentityLeaseError) throw error;
      throw new IdentityLeaseError('response');
    }
  }
}
export type IdentityLeaseHandlerOptions = Options & {
  secret: string;
  getToken: (request: Request) => Promise<string>;
};
export function createIdentityLeaseHandler(
  options: IdentityLeaseHandlerOptions,
) {
  const scope = checkedIdentityScope(options.scope);
  if (options.secret.length < 32)
    throw new IdentityLeaseError('configuration');
  const clock = options.clock ?? Date.now;
  const verifier = new IdentityTokenVerifier(options);
  return async (request: Request): Promise<Response> => {
    const fail = (status: number, code: string) =>
      Response.json(
        { error: 'identity-lease-unavailable', code },
        { status, headers: { 'cache-control': 'no-store' } },
      );
    if (request.method !== 'POST')
      return new Response(null, {
        status: 405,
        headers: { allow: 'POST', 'cache-control': 'no-store' },
      });
    if (new URL(request.url).pathname !== IDENTITY_PATH)
      return fail(404, 'request');
    let raw: string;
    try {
      raw = await boundedIdentityText(request.body);
    } catch {
      return fail(413, 'body-limit');
    }
    try {
      assertInternalRequest(
        options.secret,
        IDENTITY_PATH,
        raw,
        {
          time: request.headers.get('x-studio-time') ?? undefined,
          signature: request.headers.get('x-studio-signature') ?? undefined,
        },
        clock(),
      );
    } catch {
      return fail(401, 'authorization');
    }
    const parsed = (() => {
      try {
        return identityRequestSchema.safeParse(JSON.parse(raw));
      } catch {
        return null;
      }
    })();
    if (!parsed?.success) return fail(400, 'request');
    if (parsed.data.deploymentId !== scope.deploymentId)
      return fail(409, 'deployment');
    try {
      // Only an authenticated invocation reaches the official native token acquisition callback.
      const token = await options.getToken(request);
      if (typeof token !== 'string' || token.length > 7000)
        return fail(503, 'body-limit');
      const issuedAt = clock();
      const expiresAt = issuedAt + IDENTITY_LEASE_MS;
      await verifier.verify(token, expiresAt);
      const body = JSON.stringify({
        schemaVersion: 1,
        nonce: parsed.data.nonce,
        deploymentId: scope.deploymentId,
        ownerId: scope.ownerId,
        projectId: scope.projectId,
        environment: scope.environment,
        issuedAt,
        expiresAt,
        token,
      });
      if (Buffer.byteLength(body) > 8192) return fail(503, 'body-limit');
      return new Response(body, {
        status: 200,
        headers: {
          ...internalHeaders(
            options.secret,
            IDENTITY_RESPONSE_CONTEXT,
            body,
            issuedAt,
          ),
          'cache-control': 'no-store',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return fail(503, 'unavailable');
    }
  };
}
