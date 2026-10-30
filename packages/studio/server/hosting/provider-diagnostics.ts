const errorClasses = [
  'Error',
  'TypeError',
  'AbortError',
  'TimeoutError',
  'VercelOidcTokenError',
  'AccessTokenMissingError',
  'RefreshAccessTokenFailedError',
  'BadRequestError',
  'UnauthorizedError',
  'ForbiddenError',
  'TooManyRequestsError',
  'InternalServerError',
  'PayloadTooLargeError',
  'ConsumerDiscoveryError',
  'ConsumerRegistryNotConfiguredError',
] as const;
const errorCodes = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ERR_INVALID_URL',
] as const;
const statuses = [
  400, 401, 403, 404, 408, 409, 413, 425, 429, 500, 502, 503, 504,
];
const statusByClass: Partial<Record<(typeof errorClasses)[number], number>> =
  {
    BadRequestError: 400,
    UnauthorizedError: 401,
    ForbiddenError: 403,
    PayloadTooLargeError: 413,
    TooManyRequestsError: 429,
    InternalServerError: 500,
  };
export type ProviderFailureDiagnostic = {
  event: 'studio_provider_dispatch_failed';
  provider: 'vercel-queue';
  operation: 'job-publish' | 'maintenance-publish';
  errorClass: (typeof errorClasses)[number] | 'Unknown';
  status: number | null;
  code: (typeof errorCodes)[number] | null;
  tokenEnvPresent: boolean;
  tokenFileEnvPresent: boolean;
  /** The SDK-compatible request context contains an OIDC token; its value is never returned. */
  contextAvailable: boolean;
};
export type ProviderFailureReporter = (
  diagnostic: ProviderFailureDiagnostic,
) => void;

function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
function contextAvailable() {
  try {
    const provider = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@vercel/request-context')
    ];
    const get = property(provider, 'get');
    if (typeof get !== 'function') return false;
    return Boolean(
      property(
        property(get.call(provider), 'headers'),
        'x-vercel-oidc-token',
      ),
    );
  } catch {
    return false;
  }
}
/** Finite failure metadata only. Never inspect messages, bodies, headers, token files, or nested payloads. */
export function providerFailureDiagnostic(
  operation: ProviderFailureDiagnostic['operation'],
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ProviderFailureDiagnostic {
  const name = property(error, 'name');
  const errorClass =
    errorClasses.find((known) => known === name) ?? 'Unknown';
  const rawStatus =
    property(error, 'status') ?? property(error, 'statusCode');
  const code =
    property(error, 'code') ?? property(property(error, 'cause'), 'code');
  return {
    event: 'studio_provider_dispatch_failed',
    provider: 'vercel-queue',
    operation,
    errorClass,
    status:
      typeof rawStatus === 'number' && statuses.includes(rawStatus)
        ? rawStatus
        : ((errorClass !== 'Unknown'
            ? statusByClass[errorClass]
            : undefined) ?? null),
    code: errorCodes.find((known) => known === code) ?? null,
    tokenEnvPresent: Boolean(env.VERCEL_OIDC_TOKEN),
    tokenFileEnvPresent: Boolean(env.VERCEL_OIDC_TOKEN_FILE),
    contextAvailable: contextAvailable(),
  };
}
export function reportProviderFailure(
  report: ProviderFailureReporter | undefined,
  operation: ProviderFailureDiagnostic['operation'],
  error: unknown,
) {
  if (!report) return;
  try {
    report(providerFailureDiagnostic(operation, error));
  } catch {
    // Observability must not replace or acknowledge the original provider failure.
  }
}
