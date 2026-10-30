import { afterEach, describe, expect, it } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.ts';
import {
  liveConfigFromEnv,
  runVercelLive,
} from '../verification/vercel-live.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const html =
  '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/live.js"></script><link rel="stylesheet" href="/assets/live.css"></body></html>';
const csp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const readiness = {
  ready: true,
  draining: false,
  provider: 'vercel',
  database: 'postgres',
  objects: 'vercel-blob',
  jobs: 'vercel-queue',
  services: {
    database: { state: 'verified' },
    objects: { state: 'configured' },
    jobs: { state: 'configured' },
    media: { state: 'configured' },
  },
};
function security(res: ServerResponse) {
  for (const [name, value] of Object.entries({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': csp,
  }))
    res.setHeader(name, value);
}
async function server(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const instance = createServer((req, res) => {
    security(res);
    Promise.resolve(handler(req, res)).catch(() => {
      res.writeHead(500).end();
    });
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        instance.closeAllConnections();
        instance.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(instance.address() as any).port}`;
}
async function fixture(
  options: {
    rootStatus?: number;
    rootBody?: string;
    redirect?: string;
    healthDelay?: boolean;
    readiness?: unknown;
  } = {},
) {
  const requests: {
    path: string;
    method: string;
    oidc?: string;
    cookie?: string;
    body: string;
  }[] = [];
  const origin = await server(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({
      path: req.url!,
      method: req.method!,
      oidc: req.headers['x-vercel-trusted-oidc-idp-token'] as
        | string
        | undefined,
      cookie: req.headers.cookie,
      body,
    });
    if (req.url === '/' && options.redirect) {
      res.writeHead(302, { location: options.redirect }).end();
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res
        .writeHead(req.url === '/' ? (options.rootStatus ?? 200) : 200, {
          'content-type': 'text/html',
        })
        .end(options.rootBody ?? html);
      return;
    }
    if (req.url?.startsWith('/assets/')) {
      res.setHeader(
        'content-type',
        req.url.endsWith('.js') ? 'text/javascript' : 'text/css',
      );
      res.end(
        req.url.endsWith('.js')
          ? 'document.querySelector("#root").textContent="fixture";'
          : 'body{color:#222}',
      );
      return;
    }
    if (req.url === '/api/health' && options.healthDelay) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') res.end('{"ok":true}');
    else if (req.url === '/api/hosting/readiness')
      res.end(JSON.stringify(options.readiness ?? readiness));
    else if (req.url === '/api/auth/status')
      res.end('{"setup":false,"demo":false}');
    else if (req.url === '/api/projects')
      res.writeHead(401).end('{"error":"sign in"}');
    else if (req.url === '/api/auth/setup')
      res.writeHead(403).end('{"error":"unavailable"}');
    else if (req.url === '/api/auth/demo')
      res.writeHead(404).end('{"error":"unavailable"}');
    else if (req.url === '/api/auth/login')
      res
        .writeHead(401)
        .end(
          JSON.stringify({
            error: 'synthetic-password-that-must-not-leak synthetic-oidc-token',
          }),
        );
    else res.writeHead(404).end('{"error":"missing"}');
  });
  return { origin, requests };
}
function config(origin: string, extra: NodeJS.ProcessEnv = {}) {
  return liveConfigFromEnv({
    STUDIO_LIVE_ORIGIN: origin,
    STUDIO_LIVE_DEV_LOOPBACK: '1',
    ...extra,
  });
}
describe('hosted acceptance exact-origin and credential boundary', () => {
  it('defaults to GET-only and separates configured services from verified operations', async () => {
    const x = await fixture();
    const report = await runVercelLive(
      config(x.origin, {
        STUDIO_LIVE_EMAIL: 'owner@example.test',
        STUDIO_LIVE_PASSWORD: 'synthetic-password-that-must-not-leak',
      }),
    );
    expect(report).toMatchObject({
      status: 'passed',
      mode: 'dev-loopback-protocol',
      scope: 'public-read-only',
      counts: { passed: 6, failed: 0, skipped: 3 },
      services: {
        database: { sqlProbeObserved: true },
        objects: { reportedState: 'configured', operationsVerified: false },
        jobs: { deliveryVerified: false },
        media: { executionVerified: false },
      },
    });
    expect(
      x.requests.every((r) => r.method === 'GET' && !r.cookie && !r.body),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain('synthetic-password');
  });
  it('fails root404 even when index.html works and never enters the write workflow', async () => {
    const x = await fixture({ rootStatus: 404 });
    const report = await runVercelLive(
      config(x.origin, {
        STUDIO_LIVE_ALLOW_WRITES: '1',
        STUDIO_LIVE_EMAIL: 'owner@example.test',
        STUDIO_LIVE_PASSWORD: 'synthetic-password-that-must-not-leak',
      }),
    );
    expect(report.status).toBe('failed');
    expect(report.checks).toContainEqual({
      id: 'root-spa',
      status: 'failed',
      reason: 'root-not-200',
    });
    expect(x.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(x.requests.some((r) => r.path === '/index.html')).toBe(false);
  });
  it('rejects redirects before forwarding the exact-host trusted OIDC header', async () => {
    let otherRequests = 0;
    const other = await server((_req, res) => {
      otherRequests++;
      res.end('wrong host');
    });
    const x = await fixture({ redirect: other });
    const report = await runVercelLive(
      config(x.origin, {
        STUDIO_LIVE_OIDC_TOKEN: 'synthetic-oidc-token',
        STUDIO_LIVE_OIDC_HOST: new URL(x.origin).host,
      }),
    );
    expect(report.checks).toContainEqual({
      id: 'root-spa',
      status: 'failed',
      reason: 'redirect-rejected',
    });
    expect(otherRequests).toBe(0);
    expect(x.requests.every((r) => r.oidc === 'synthetic-oidc-token')).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toContain('synthetic-oidc-token');
  });
  it('rejects foreign bootstrap assets without requesting them or disclosing credentials', async () => {
    let otherRequests = 0;
    const other = await server((_req, res) => {
      otherRequests++;
      res.end('untrusted');
    });
    const x = await fixture({
      rootBody: html.replace('/assets/live.js', other + '/assets/live.js'),
    });
    const report = await runVercelLive(
      config(x.origin, {
        STUDIO_LIVE_OIDC_TOKEN: 'synthetic-oidc-token',
        STUDIO_LIVE_OIDC_HOST: new URL(x.origin).host,
      }),
    );
    expect(report.checks).toContainEqual({
      id: 'root-spa',
      status: 'failed',
      reason: 'asset-origin-or-path-rejected',
    });
    expect(otherRequests).toBe(0);
  });
  it('bounds streamed response bytes and a body that never finishes', async () => {
    const oversized = await fixture({ rootBody: html + 'x'.repeat(5000) });
    const sizeReport = await runVercelLive(
      config(oversized.origin, { STUDIO_LIVE_RESPONSE_BYTES: '4096' }),
    );
    expect(sizeReport.checks).toContainEqual({
      id: 'root-spa',
      status: 'failed',
      reason: 'response-too-large',
    });
    const hanging = await fixture({ healthDelay: true });
    const timeoutReport = await runVercelLive(
      config(hanging.origin, { STUDIO_LIVE_TIMEOUT_MS: '100' }),
    );
    expect(timeoutReport.checks).toContainEqual({
      id: 'health',
      status: 'failed',
      reason: 'request-timeout',
    });
  });
  it('rejects noncanonical origins, credentials without pairs, wrong OIDC hosts and production loopback', () => {
    for (const env of [
      { STUDIO_LIVE_ORIGIN: 'https://studio.example.test/' },
      { STUDIO_LIVE_ORIGIN: 'https://user:password@studio.example.test' },
      { STUDIO_LIVE_ORIGIN: 'https://studio.example.test?token=secret' },
      { STUDIO_LIVE_ORIGIN: 'http://127.0.0.1:1234' },
      {
        STUDIO_LIVE_ORIGIN: 'https://studio.example.test',
        STUDIO_LIVE_EMAIL: 'owner@example.test',
      },
      {
        STUDIO_LIVE_ORIGIN: 'https://studio.example.test',
        STUDIO_LIVE_OIDC_TOKEN: 'secret',
        STUDIO_LIVE_OIDC_HOST: 'other.example.test',
      },
      {
        STUDIO_LIVE_ORIGIN: 'https://studio.example.test',
        STUDIO_LIVE_ALLOW_WRITES: '1',
      },
      {
        STUDIO_LIVE_ORIGIN: 'http://127.0.0.1:1234',
        STUDIO_LIVE_DEV_LOOPBACK: '1',
        NODE_ENV: 'production',
      },
    ])
      expect(() => liveConfigFromEnv(env)).toThrow();
  });
  it('redacts secrets and response bodies from failed login reports', async () => {
    const x = await fixture();
    const report = await runVercelLive(
      config(x.origin, {
        STUDIO_LIVE_ALLOW_WRITES: '1',
        STUDIO_LIVE_EMAIL: 'owner@example.test',
        STUDIO_LIVE_PASSWORD: 'synthetic-password-that-must-not-leak',
        STUDIO_LIVE_OIDC_TOKEN: 'synthetic-oidc-token',
        STUDIO_LIVE_OIDC_HOST: new URL(x.origin).host,
      }),
    );
    expect(report.checks).toContainEqual({
      id: 'secure-owner-login',
      status: 'failed',
      reason: 'owner-login-failed',
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('synthetic-password');
    expect(serialized).not.toContain('synthetic-oidc-token');
    expect(serialized).not.toContain('owner@example.test');
  });
  it('does not pass a local SQLite readiness response as Vercel SQL readiness', async () => {
    const x = await fixture({
      readiness: { ...readiness, provider: 'node', database: 'sqlite' },
    });
    expect((await runVercelLive(config(x.origin))).checks).toContainEqual({
      id: 'vercel-sql-readiness',
      status: 'failed',
      reason: 'vercel-sql-not-ready',
    });
  });
  it('writes and reloads canonical documents through two secure sessions in the actual application', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-hosted-acceptance-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const clientDir = join(dir, 'client');
    await mkdir(join(clientDir, 'assets'), { recursive: true });
    await writeFile(join(clientDir, 'index.html'), html);
    await writeFile(
      join(clientDir, 'assets/live.js'),
      'document.querySelector("#root").textContent="fixture";',
    );
    await writeFile(join(clientDir, 'assets/live.css'), 'body{color:#222}');
    const settings = {
      production: true,
      demo: false,
      dataDir: dir,
      origin: 'http://127.0.0.1:1234',
      adminEmail: 'owner@example.test',
      adminPassword: 'synthetic-password-that-must-not-leak',
    };
    const studio = await createApp(settings, { clientDir });
    cleanup.push(() => studio.app.close());
    // Only Vercel diagnostics are a protocol fixture; auth, documents, SQL, revision and sessions are the actual application.
    studio.app.get('/api/hosting/readiness', async () => {
      await studio.store.one('SELECT 1');
      return readiness;
    });
    const origin = await studio.app.listen({ port: 0, host: '127.0.0.1' });
    settings.origin = origin;
    const report = await runVercelLive(
      config(origin, {
        STUDIO_LIVE_ALLOW_WRITES: '1',
        STUDIO_LIVE_EMAIL: settings.adminEmail,
        STUDIO_LIVE_PASSWORD: settings.adminPassword,
      }),
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { id: 'secure-owner-login', status: 'passed' },
        { id: 'persisted-document-fresh-session', status: 'passed' },
        { id: 'session-cleanup', status: 'passed' },
      ]),
    );
    expect(report.status).toBe('passed');
    expect(report.synthetic?.retained).toBe(true);
    expect(
      (await studio.store.one('SELECT count(*) AS n FROM sessions')).n,
    ).toBe(0);
    const artifact = await studio.store.one(
      'SELECT version,content FROM artifacts WHERE id=?',
      report.synthetic!.artifactId,
    );
    expect(artifact.version).toBeGreaterThan(1);
    expect(JSON.parse(artifact.content).doc.content[0].content[0].text).toMatch(
      /^Hosted acceptance /,
    );
    expect(
      (await studio.store.one('SELECT count(*) AS n FROM studio_durable_jobs'))
        .n,
    ).toBe(0);
  });
});
