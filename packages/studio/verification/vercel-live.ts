import { randomUUID } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type LiveConfig = {
  origin: string;
  allowWrites: boolean;
  devLoopback: boolean;
  timeoutMs: number;
  responseBytes: number;
  email?: string;
  githubUserId?: string;
  githubSessionsFile?: string;
  oidc?: { host: string; token: string };
};
type Check = {
  id: string;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
};
export type LiveReport = {
  schemaVersion: 1;
  target: string;
  mode: 'hosted-https' | 'dev-loopback-protocol';
  scope: 'public-read-only' | 'authenticated-persistence';
  status: 'passed' | 'failed';
  counts: { passed: number; failed: number; skipped: number };
  checks: Check[];
  identity?: {
    provider: 'github';
    sessionSource: 'operator-browser-export';
    externalOAuthExchangePerformed: false;
  };
  services?: {
    database: { reportedState: string; sqlProbeObserved: boolean };
    objects: { reportedState: string; operationsVerified: false };
    jobs: { reportedState: string; deliveryVerified: false };
    media: { reportedState: string; executionVerified: false };
  };
  synthetic?: { projectId: string; artifactId: string; retained: true };
};
class CheckFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new CheckFailure(reason);
}
function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const number = value === undefined ? fallback : Number(value);
  requireValue(
    Number.isSafeInteger(number) && number >= min && number <= max,
    'invalid-request-bound',
  );
  return number;
}
/** Credentials are explicit environment inputs. No runtime credential discovery or protected-deployment bypass. */
export function liveConfigFromEnv(env: NodeJS.ProcessEnv): LiveConfig {
  let url: URL;
  try {
    url = new URL(env.STUDIO_LIVE_ORIGIN ?? '');
  } catch {
    throw new CheckFailure('exact-origin-required');
  }
  const devLoopback = env.STUDIO_LIVE_DEV_LOOPBACK === '1';
  requireValue(
    !devLoopback || env.NODE_ENV !== 'production',
    'loopback-mode-disabled-in-production',
  );
  requireValue(
    url.origin === env.STUDIO_LIVE_ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (devLoopback &&
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))),
    'exact-https-origin-required',
  );
  requireValue(
    !env.STUDIO_LIVE_ALLOW_WRITES || env.STUDIO_LIVE_ALLOW_WRITES === '1',
    'invalid-write-gate',
  );
  requireValue(
    !env.STUDIO_LIVE_DEV_LOOPBACK || devLoopback,
    'invalid-loopback-gate',
  );
  requireValue(env.STUDIO_LIVE_PASSWORD === undefined, 'password-authentication-disabled');
  const email = env.STUDIO_LIVE_EMAIL,
    githubUserId = env.STUDIO_LIVE_GITHUB_USER_ID,
    githubSessionsFile = env.STUDIO_LIVE_GITHUB_SESSIONS_FILE;
  requireValue(!(email !== undefined && githubUserId !== undefined), 'choose-one-github-identity-reference');
  requireValue(
    (email === undefined && githubUserId === undefined) === (githubSessionsFile === undefined),
    'github-session-reference-and-identity-required',
  );
  if (email !== undefined || githubUserId !== undefined || githubSessionsFile !== undefined)
    requireValue(
      (githubUserId !== undefined
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(githubUserId)
        : email && /^\S+@\S+\.\S+$/.test(email) && email.length <= 254 && !/[\r\n]/.test(email)) &&
        githubSessionsFile && isAbsolute(githubSessionsFile) &&
        githubSessionsFile.length <= 4096 && !/[\r\n\0]/.test(githubSessionsFile),
      'invalid-github-session-reference',
    );
  const allowWrites = env.STUDIO_LIVE_ALLOW_WRITES === '1';
  requireValue(
    !allowWrites || ((email || githubUserId) && githubSessionsFile),
    'write-gate-requires-github-sessions',
  );
  const token = env.STUDIO_LIVE_OIDC_TOKEN,
    host = env.STUDIO_LIVE_OIDC_HOST;
  requireValue(
    (token === undefined) === (host === undefined),
    'oidc-token-and-exact-host-required',
  );
  if (token !== undefined)
    requireValue(
      host === url.host &&
        token.length > 0 &&
        token.length <= 32768 &&
        /^[\x21-\x7e]+$/.test(token),
      'oidc-exact-host-binding-required',
    );
  return {
    origin: url.origin,
    allowWrites,
    devLoopback,
    email,
    githubUserId,
    githubSessionsFile,
    timeoutMs: boundedInteger(env.STUDIO_LIVE_TIMEOUT_MS, 15000, 100, 30000),
    responseBytes: boundedInteger(
      env.STUDIO_LIVE_RESPONSE_BYTES,
      8 * 1024 * 1024,
      1024,
      16 * 1024 * 1024,
    ),
    ...(token && host ? { oidc: { host, token } } : {}),
  };
}
/**
 * Exact-origin browser cookie exports are an operator-selected credential input.
 * The application independently requires GitHub-issued session provenance. This
 * loader never creates a session or treats export metadata as live OAuth proof.
 */
export function readLiveGitHubSessions(path: string, origin: string, count: 1): Promise<[string]>;
export function readLiveGitHubSessions(path: string, origin: string, count?: 2): Promise<[string, string]>;
export async function readLiveGitHubSessions(path: string, origin: string, count: 1 | 2 = 2): Promise<string[]> {
  requireValue(count === 1 || count === 2, 'invalid-github-session-count');
  requireValue(isAbsolute(path), 'invalid-github-session-reference');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size <= 32768 && (stat.mode & 0o077) === 0, 'private-github-session-file-required');
    const buffer = Buffer.alloc(32769), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireValue(bytesRead <= 32768, 'github-session-file-too-large');
    const value = object(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    requireValue(value.schemaVersion === 1 && value.provider === 'github' && value.origin === origin && Array.isArray(value.sessions) && value.sessions.length === count, 'github-session-origin-or-provider-mismatch');
    const host = new URL(origin).hostname, now = Date.now() / 1000;
    const sessions = value.sessions.map((entry: unknown) => {
      const cookie = object(entry);
      requireValue(cookie.name === 'studio_session' && typeof cookie.value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cookie.value) && cookie.domain === host && cookie.path === '/' && cookie.secure === true && cookie.httpOnly === true && cookie.sameSite === 'Strict' && Number.isFinite(cookie.expires) && cookie.expires > now && cookie.expires <= now + 8 * 86400, 'unsafe-github-session-cookie-export');
      return 'studio_session=' + cookie.value;
    });
    requireValue(count === 1 || sessions[0] !== sessions[1], 'fresh-session-not-issued');
    return sessions;
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure('github-session-file-unavailable-or-invalid');
  } finally {
    await file?.close();
  }
}
function securityHeaders(headers: Headers, https: boolean) {
  requireValue(
    headers.get('x-content-type-options')?.toLowerCase() === 'nosniff',
    'missing-nosniff',
  );
  requireValue(
    ['deny', 'sameorigin'].includes(
      headers.get('x-frame-options')?.toLowerCase() ?? '',
    ),
    'missing-frame-protection',
  );
  requireValue(
    headers.get('referrer-policy')?.toLowerCase() === 'no-referrer',
    'missing-referrer-policy',
  );
  requireValue(
    headers.get('cross-origin-opener-policy') === 'same-origin' &&
      headers.get('cross-origin-resource-policy') === 'same-origin',
    'missing-origin-isolation',
  );
  if (https) {
    const age = /(?:^|;)\s*max-age=(\d+)/i.exec(
      headers.get('strict-transport-security') ?? '',
    )?.[1];
    requireValue(age && Number(age) >= 31536000, 'missing-hsts');
  }
  const csp = new Map(
    (headers.get('content-security-policy') ?? '').split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name?.toLowerCase(), values];
    }),
  );
  requireValue(
    csp.get('default-src')?.includes("'self'") &&
      csp.get('script-src')?.includes("'self'") &&
      !csp
        .get('script-src')
        ?.some((value) =>
          ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:', 'http:'].includes(
            value,
          ),
        ),
    'unsafe-or-missing-csp',
  );
  for (const [directive, source] of [
    ['object-src', "'none'"],
    ['frame-ancestors', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
  ])
    requireValue(
      csp.get(directive!)?.length === 1 && csp.get(directive!)?.[0] === source,
      'unsafe-or-missing-csp',
    );
}
function attributes(tag: string) {
  return Object.fromEntries(
    Array.from(
      tag.matchAll(
        /([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      ),
      (match) => [
        match[1]!.toLowerCase(),
        match[2] ?? match[3] ?? match[4] ?? '',
      ],
    ),
  );
}
function assetsFromHtml(html: string, origin: string) {
  requireValue(
    /<div\b[^>]*\bid\s*=\s*["']root["']/i.test(html),
    'spa-root-missing',
  );
  const assets: { path: string; kind: 'js' | 'css' }[] = [];
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    let src: string | undefined, kind: 'js' | 'css';
    if (match[1]!.toLowerCase() === 'script' && attrs.src) {
      requireValue(attrs.type === 'module', 'unexpected-bootstrap-script');
      src = attrs.src;
      kind = 'js';
    } else if (
      match[1]!.toLowerCase() === 'link' &&
      attrs.rel?.split(/\s+/).includes('stylesheet')
    ) {
      src = attrs.href;
      kind = 'css';
    } else continue;
    requireValue(
      src && src.length < 2000 && !src.includes('&'),
      'invalid-asset-reference',
    );
    let url: URL;
    try {
      url = new URL(src, origin);
    } catch {
      throw new CheckFailure('invalid-asset-reference');
    }
    requireValue(
      url.origin === origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/assets\/[A-Za-z0-9_./-]+\.(?:js|css)$/.test(url.pathname) &&
        url.pathname.endsWith('.' + kind),
      'asset-origin-or-path-rejected',
    );
    if (!assets.some((asset) => asset.path === url.pathname))
      assets.push({ path: url.pathname, kind });
  }
  requireValue(
    assets.length <= 8 &&
      assets.some((asset) => asset.kind === 'js') &&
      assets.some((asset) => asset.kind === 'css'),
    'built-spa-assets-missing-or-unbounded',
  );
  return assets;
}
function object(value: unknown): Record<string, any> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid-json-object',
  );
  return value as Record<string, any>;
}
function safeId(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value),
    'invalid-resource-id',
  );
}
function documentText(node: any, depth = 0): string {
  requireValue(
    depth <= 20 && node && typeof node === 'object',
    'invalid-persisted-document',
  );
  if (node.type === 'text')
    return typeof node.text === 'string' ? node.text : '';
  return Array.isArray(node.content)
    ? node.content.map((child: any) => documentText(child, depth + 1)).join('')
    : '';
}

/** Exact-origin HTTP acceptance. It never invokes authoring/decision models or media jobs. */
export async function runVercelLive(config: LiveConfig): Promise<LiveReport> {
  // Revalidate the public function's inputs too; callers cannot skip the CLI's credential/origin fence.
  config = liveConfigFromEnv({
    NODE_ENV: process.env.NODE_ENV,
    STUDIO_LIVE_ORIGIN: config.origin,
    STUDIO_LIVE_ALLOW_WRITES: config.allowWrites ? '1' : undefined,
    STUDIO_LIVE_DEV_LOOPBACK: config.devLoopback ? '1' : undefined,
    STUDIO_LIVE_TIMEOUT_MS: String(config.timeoutMs),
    STUDIO_LIVE_RESPONSE_BYTES: String(config.responseBytes),
    STUDIO_LIVE_EMAIL: config.email,
    STUDIO_LIVE_GITHUB_USER_ID: config.githubUserId,
    STUDIO_LIVE_GITHUB_SESSIONS_FILE: config.githubSessionsFile,
    STUDIO_LIVE_OIDC_HOST: config.oidc?.host,
    STUDIO_LIVE_OIDC_TOKEN: config.oidc?.token,
  });
  const checks: Check[] = [];
  const report: LiveReport = {
    schemaVersion: 1,
    target: config.origin,
    mode: config.devLoopback ? 'dev-loopback-protocol' : 'hosted-https',
    scope: config.allowWrites
      ? 'authenticated-persistence'
      : 'public-read-only',
    status: 'failed',
    counts: { passed: 0, failed: 0, skipped: 0 },
    checks,
    ...(config.allowWrites ? { identity: {
      provider: 'github' as const,
      sessionSource: 'operator-browser-export' as const,
      externalOAuthExchangePerformed: false as const,
    } } : {}),
  };
  const overall = AbortSignal.timeout(120000);
  async function request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      maxBytes?: number;
    } = {},
  ) {
    requireValue(
      path.startsWith('/') && !path.startsWith('//'),
      'request-path-rejected',
    );
    const url = new URL(path, config.origin);
    requireValue(url.origin === config.origin, 'request-origin-rejected');
    const method = options.method ?? 'GET';
    requireValue(method === 'GET' || config.allowWrites, 'write-gate-required');
    const headers: Record<string, string> = {
      Accept: 'application/json, text/html, text/javascript, text/css',
    };
    if (config.oidc) {
      requireValue(
        url.host === config.oidc.host,
        'oidc-exact-host-binding-required',
      );
      headers['x-vercel-trusted-oidc-idp-token'] = config.oidc.token;
    }
    if (options.cookie) headers.Cookie = options.cookie;
    if (method !== 'GET') headers.Origin = config.origin;
    if (options.body !== undefined)
      headers['Content-Type'] = 'application/json';
    const signal = AbortSignal.any([
      overall,
      AbortSignal.timeout(config.timeoutMs),
    ]);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        redirect: 'manual',
        signal,
        cache: 'no-store',
      });
    } catch {
      throw new CheckFailure(
        signal.aborted ? 'request-timeout' : 'request-failed',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CheckFailure('redirect-rejected');
    }
    const maxBytes = Math.min(
      options.maxBytes ?? config.responseBytes,
      config.responseBytes,
    );
    let text = '',
      size = 0;
    const reader = response.body?.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          requireValue(size <= maxBytes, 'response-too-large');
          text += decoder.decode(part.value, { stream: true });
        }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof CheckFailure) throw error;
      throw new CheckFailure(
        signal.aborted ? 'request-timeout' : 'invalid-response-body',
      );
    } finally {
      await reader?.cancel().catch(() => {});
    }
    return {
      response,
      text,
      json: () => {
        requireValue(
          response.headers.get('content-type')?.split(';')[0]?.trim() ===
            'application/json',
          'unexpected-json-content-type',
        );
        try {
          return JSON.parse(text);
        } catch (error) {
          if (error instanceof CheckFailure) throw error;
          throw new CheckFailure('invalid-json');
        }
      },
    };
  }
  async function check(id: string, operation: () => Promise<void>) {
    try {
      await operation();
      checks.push({ id, status: 'passed' });
      return true;
    } catch (error) {
      checks.push({
        id,
        status: 'failed',
        reason: error instanceof CheckFailure ? error.reason : 'check-failed',
      });
      return false;
    }
  }
  let assets: ReturnType<typeof assetsFromHtml> = [];
  await check('root-spa', async () => {
    const result = await request('/', { maxBytes: 1024 * 1024 });
    requireValue(result.response.status === 200, 'root-not-200');
    requireValue(
      result.response.headers.get('content-type')?.split(';')[0]?.trim() ===
        'text/html',
      'root-not-html',
    );
    securityHeaders(
      result.response.headers,
      config.origin.startsWith('https:'),
    );
    assets = assetsFromHtml(result.text, config.origin);
  });
  if (!assets.length)
    checks.push({
      id: 'spa-assets',
      status: 'skipped',
      reason: 'valid-root-required',
    });
  else
    await check('spa-assets', async () => {
      for (const asset of assets) {
        const result = await request(asset.path);
        requireValue(
          result.response.status === 200 &&
            result.text.length > 0 &&
            !/^\s*(?:<!doctype|<html)/i.test(result.text),
          'asset-not-served',
        );
        requireValue(
          asset.kind === 'js'
            ? /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(
                result.response.headers.get('content-type') ?? '',
              )
            : /^text\/css(?:;|$)/i.test(
                result.response.headers.get('content-type') ?? '',
              ),
          'asset-content-type-mismatch',
        );
        securityHeaders(
          result.response.headers,
          config.origin.startsWith('https:'),
        );
      }
    });
  await check('health', async () => {
    const result = await request('/api/health', { maxBytes: 65536 });
    requireValue(
      result.response.status === 200 && object(result.json()).ok === true,
      'health-not-ok',
    );
  });
  await check('vercel-sql-readiness', async () => {
    const result = await request('/api/hosting/readiness', { maxBytes: 65536 });
    const body = object(result.json()),
      services = object(body.services),
      database = object(services.database);
    requireValue(
      result.response.status === 200 &&
        body.ready === true &&
        body.draining === false &&
        body.provider === 'vercel' &&
        body.database === 'postgres' &&
        body.objects === 'vercel-blob' &&
        body.jobs === 'vercel-queue' &&
        database.state === 'verified',
      'vercel-sql-not-ready',
    );
    const reported = (service: unknown) => {
      const state = object(service).state;
      return ['configured', 'verified', 'unavailable'].includes(state)
        ? state
        : 'unknown';
    };
    report.services = {
      database: { reportedState: 'verified', sqlProbeObserved: true },
      objects: {
        reportedState: reported(services.objects),
        operationsVerified: false,
      },
      jobs: { reportedState: reported(services.jobs), deliveryVerified: false },
      media: {
        reportedState: reported(services.media),
        executionVerified: false,
      },
    };
  });
  await check('setup-disabled-demo-off', async () => {
    const result = await request('/api/auth/status', { maxBytes: 65536 }),
      body = object(result.json());
    requireValue(
      result.response.status === 200 &&
        body.setup === false &&
        body.demo === false && body.github === true && body.password === false && body.oidc === false,
      'github-only-authentication-required',
    );
  });
  await check('unauthenticated-api-denied', async () => {
    const result = await request('/api/projects', { maxBytes: 65536 });
    requireValue(
      result.response.status === 401 &&
        typeof object(result.json()).error === 'string',
      'unauthenticated-api-not-401',
    );
  });
  const cookies: string[] = [];
  if (!config.allowWrites)
    for (const id of [
      'password-setup-demo-route-denials',
      'authenticated-github-session',
      'persisted-document-fresh-session',
    ])
      checks.push({
        id,
        status: 'skipped',
        reason: 'explicit-write-gate-required',
      });
  else if (checks.some((check) => check.status === 'failed'))
    checks.push({
      id: 'authenticated-write-checks',
      status: 'skipped',
      reason: 'public-checks-must-pass-first',
    });
  else {
    const routesSafe = await check('password-setup-demo-route-denials', async () => {
      requireValue(
        (await request('/api/auth/setup', { method: 'POST', body: {} }))
          .response.status === 403,
        'setup-route-not-disabled',
      );
      requireValue(
        (await request('/api/auth/demo', { method: 'POST', body: {} })).response
          .status === 403,
        'demo-route-not-disabled',
      );
      const password = await request('/api/auth/login', { method: 'POST', body: { email: 'disabled-password@example.test', password: 'disabled-password-proof' }, maxBytes: 65536 });
      requireValue(password.response.status === 403 && !password.response.headers.get('set-cookie'), 'password-login-not-disabled');
    });
    let suppliedSessions: [string, string] | undefined, nextSession = 0;
    async function login() {
      if (!suppliedSessions) {
        suppliedSessions = await readLiveGitHubSessions(config.githubSessionsFile!, config.origin);
        cookies.push(...suppliedSessions);
      }
      const cookie = suppliedSessions[nextSession++];
      requireValue(cookie, 'two-distinct-github-sessions-required');
      const me = await request('/api/me', { cookie, maxBytes: 65536 });
      requireValue(me.response.status === 200, 'github-session-not-authenticated');
      const user = object(me.json());
      safeId(user.id);
      requireValue(config.githubUserId
        ? user.id === config.githubUserId
        : typeof user.email === 'string' && user.email.toLowerCase() === config.email!.toLowerCase(), 'github-session-identity-mismatch');
      requireValue(me.response.headers.get('cache-control')?.includes('no-store'), 'session-cache-not-private');
      return { cookie, userId: user.id as string };
    }
    let first: Awaited<ReturnType<typeof login>> | undefined;
    if (routesSafe)
      await check('authenticated-github-session', async () => {
        first = await login();
      });
    else
      checks.push({
        id: 'authenticated-github-session',
        status: 'skipped',
        reason: 'disabled-setup-demo-routes-required',
      });
    if (first)
      await check('persisted-document-fresh-session', async () => {
        const marker = 'Hosted acceptance ' + randomUUID();
        const created = await request('/api/projects', {
          method: 'POST',
          cookie: first!.cookie,
          body: {
            title: marker,
            description:
              'Private synthetic hosted acceptance; retained for operator review.',
            repository: '',
          },
          maxBytes: 65536,
        });
        requireValue(
          created.response.status === 201,
          'synthetic-project-create-failed',
        );
        const project = object(created.json());
        safeId(project.id);
        safeId(project.mainArtifactId);
        report.synthetic = {
          projectId: project.id,
          artifactId: project.mainArtifactId,
          retained: true,
        };
        const document = await request(
          `/api/projects/${project.id}/artifacts`,
          {
            method: 'POST',
            cookie: first!.cookie,
            body: { kind: 'document', title: marker + ' document' },
            maxBytes: 65536,
          },
        );
        requireValue(
          document.response.status === 201,
          'synthetic-document-create-failed',
        );
        const artifact = object(document.json());
        safeId(artifact.id);
        report.synthetic = {
          projectId: project.id,
          artifactId: artifact.id,
          retained: true,
        };
        const saved = await request(`/api/artifacts/${artifact.id}`, {
          method: 'PATCH',
          cookie: first!.cookie,
          body: {
            version: artifact.version,
            content: {
              doc: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: marker }],
                  },
                ],
              },
            },
          },
          maxBytes: 1024 * 1024,
        });
        const savedArtifact = object(saved.json());
        requireValue(
          saved.response.status === 200 &&
            savedArtifact.id === artifact.id &&
            Number.isSafeInteger(savedArtifact.version) &&
            savedArtifact.version > artifact.version,
          'canonical-document-save-failed',
        );
        const second = await login();
        requireValue(
          second.userId === first!.userId,
          'fresh-session-user-changed',
        );
        const projects = await request('/api/projects', {
          cookie: second.cookie,
          maxBytes: 1024 * 1024,
        });
        const listed = projects.json();
        requireValue(
          projects.response.status === 200 &&
            Array.isArray(listed) &&
            listed.some(
              (value) => value.id === project.id && value.role === 'owner',
            ),
          'persisted-project-owner-not-readable',
        );
        const reloaded = await request(`/api/artifacts/${artifact.id}`, {
          cookie: second.cookie,
          maxBytes: 1024 * 1024,
        });
        const body = object(reloaded.json()),
          value = object(body.artifact);
        requireValue(
          reloaded.response.status === 200 &&
            value.id === artifact.id &&
            value.projectId === project.id &&
            value.kind === 'document' &&
            value.version === savedArtifact.version &&
            documentText(object(value.content).doc) === marker &&
            JSON.stringify(value.content) ===
              JSON.stringify(savedArtifact.content),
          'persisted-document-content-mismatch',
        );
        requireValue(
          Array.isArray(body.decisions) &&
            body.decisions.length >= 1 &&
            Array.isArray(body.threads) &&
            body.threads.length >= 1,
          'artifact-adr-or-chat-missing',
        );
      });
    else
      checks.push({
        id: 'persisted-document-fresh-session',
        status: 'skipped',
        reason: 'authenticated-github-session-required',
      });
    if (cookies.length)
      await check('session-cleanup', async () => {
        for (const cookie of cookies) {
          requireValue(
            (await request('/api/auth/logout', { method: 'POST', cookie }))
              .response.status === 200,
            'session-logout-failed',
          );
          requireValue(
            (await request('/api/me', { cookie, maxBytes: 65536 })).response
              .status === 401,
            'session-revocation-not-observed',
          );
        }
      });
  }
  for (const result of checks) report.counts[result.status]++;
  report.status = report.counts.failed === 0 ? 'passed' : 'failed';
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await runVercelLive(liveConfigFromEnv(process.env));
    console.log(JSON.stringify(report));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'failed',
        reason:
          error instanceof CheckFailure
            ? error.reason
            : 'acceptance-run-failed',
      }),
    );
    process.exitCode = 1;
  }
}
