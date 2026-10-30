import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { QueueClient } from '@vercel/queue';
import { Sandbox } from '@vercel/sandbox';
import { createGateway, generateText } from 'ai';
import { NativeIdentityExecutionContext } from '../server/hosting/native-identity-context.ts';
import { identityLanguageModel } from '../server/hosting/identity-language-model.ts';
import {
  PrivateIdentityLeaseClient,
  createIdentityLeaseHandler,
  type IdentityScope,
  type ValidatedIdentityLease,
} from '../server/hosting/identity-lease.ts';
import { VercelQueueDispatcher } from '../server/hosting/vercel-queue.ts';
import {
  VercelSandboxMediaRuntime,
  type MediaSandboxFactory,
} from '../server/media/vercel-sandbox.ts';
import { initialAudioContent } from '../shared/audio.ts';
const close: (() => Promise<unknown> | void)[] = [];
const symbol = Symbol.for('@vercel/request-context');
const platform = globalThis as typeof globalThis & { [key: symbol]: any };
let previous: PropertyDescriptor | undefined;
beforeEach(() => {
  for (const name of [
    'VERCEL_OIDC_TOKEN',
    'VERCEL_OIDC_TOKEN_FILE',
    'AI_GATEWAY_API_KEY',
    'VERCEL_QUEUE_TOKEN',
    'VERCEL_QUEUE_BASE_URL',
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv('NODE_ENV', 'production');
  previous = Object.getOwnPropertyDescriptor(platform, symbol);
  Object.defineProperty(platform, symbol, {
    configurable: true,
    value: {
      get: () => ({
        headers: { 'native-marker': 'preserved' },
        waitUntil: 'native-metadata',
      }),
    },
  });
});
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  if (previous) Object.defineProperty(platform, symbol, previous);
  else delete platform[symbol];
  vi.unstubAllEnvs();
});
const ambient = () => platform[symbol]?.get?.() ?? {};
const scope: IdentityScope = {
  ownerId: 'team_Fixture',
  ownerSlug: 'fixture-team',
  projectId: 'prj_Fixture',
  projectName: 'fixture-project',
  environment: 'preview',
  deploymentId: 'dpl_Fixture',
  issuer: 'https://oidc.vercel.com/fixture-team',
  audience: 'https://vercel.com/fixture-team',
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>,
  jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'context-key',
    alg: 'RS256',
    use: 'sig',
  };
});
async function token(label: string, changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    owner: scope.ownerSlug,
    owner_id: scope.ownerId,
    project: scope.projectName,
    project_id: scope.projectId,
    environment: scope.environment,
    deployment_id: scope.deploymentId,
    jti: label,
    ...changes,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'context-key' })
    .setIssuer(scope.issuer)
    .setAudience(scope.audience)
    .setSubject(
      `owner:${scope.ownerSlug}:project:${scope.projectName}:environment:${scope.environment}`,
    )
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 7200)
    .sign(keys.privateKey);
}
async function http(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      res.writeHead(500).end('fixture-failed');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  close.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function broker() {
  let current = await token('A'),
    calls = 0;
  let tokenSource: (() => Promise<string>) | undefined;
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    if (url === 'https://oidc.vercel.com/.well-known/jwks')
      return fetch(origin + '/jwks', init);
    if (url.startsWith(origin + '/internal/identity/lease'))
      return fetch(input, init);
    throw new Error('Unexpected identity fixture URL');
  };
  const handler = createIdentityLeaseHandler({
    scope,
    secret: 'synthetic-identity-context-secret-32characters',
    fetch: fetcher,
    getToken: async () => {
      calls++;
      return tokenSource ? tokenSource() : current;
    },
  });
  const origin = await http(async (req, res) => {
    if (req.url === '/jwks') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    let body = '';
    for await (const part of req) body += part;
    const response = await handler(
      new Request(origin + req.url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const client = new PrivateIdentityLeaseClient({
    scope,
    bindingUrl: origin,
    secret: 'synthetic-identity-context-secret-32characters',
    fetch: fetcher,
  });
  return {
    client,
    context: new NativeIdentityExecutionContext({
      acquire: () => client.acquire(),
    }),
    calls: () => calls,
    setToken: (value: string) => {
      current = value;
    },
    setTokenSource: (source: () => Promise<string>) => {
      tokenSource = source;
    },
  };
}
const generated = {
  content: [{ type: 'text', text: 'Verified lease HTTP fixture.' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};
describe('validated private lease → scoped execution → actual provider SDK HTTP', () => {
  it('uses fresh verified broker tokens for Queue and Gateway without changing native auth or routing', async () => {
    const f = await broker(),
      a = await token('queue'),
      b = await token('gateway');
    const received: any[] = [];
    const origin = await http(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      received.push({
        path: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url!.startsWith('/api/v3/topic/')
            ? { messageId: 'lease-message' }
            : generated,
        ),
      );
    });
    const client = new QueueClient({
      region: 'iad1',
      deploymentId: scope.deploymentId,
      resolveBaseUrl: () => new URL(origin),
    });
    const jobs = new VercelQueueDispatcher({
      region: 'iad1',
      client,
      identityExecutionContext: f.context,
    });
    f.setToken(a);
    const jobId = crypto.randomUUID(),
      dispatchId = crypto.randomUUID();
    await jobs.publish(jobId, { dispatchId });
    f.setToken(b);
    const model = identityLanguageModel(
      createGateway({ baseURL: origin })('fixture/model'),
      f.context,
    );
    expect(
      (
        await generateText({
          model,
          prompt: 'Synthetic fixture.',
          maxRetries: 0,
        })
      ).text,
    ).toBe('Verified lease HTTP fixture.');
    expect(received[0]).toMatchObject({
      path: '/api/v3/topic/studio-jobs-v1',
      headers: {
        authorization: 'Bearer ' + a,
        'vqs-deployment-id': scope.deploymentId,
        'vqs-idempotency-key': 'studio-dispatch:' + dispatchId,
      },
      body: { schemaVersion: 1, jobId },
    });
    expect(received[1]?.headers).toMatchObject({
      authorization: 'Bearer ' + b,
      'ai-gateway-auth-method': 'oidc',
    });
    expect(f.calls()).toBe(2);
    expect(ambient()).toEqual({
      headers: { 'native-marker': 'preserved' },
      waitUntil: 'native-metadata',
    });
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined();
    expect(process.env.AI_GATEWAY_API_KEY).toBeUndefined();
  });
  it('keeps concurrently active Gateway callbacks isolated even when their HTTP responses overlap', async () => {
    const f = await broker(),
      expected = new Map<string, string>();
    const tokens = [
      await token('concurrent-one'),
      await token('concurrent-two'),
    ];
    f.setTokenSource(async () => tokens.shift()!);
    const acquire = async (label: string) => {
      const lease = await f.client.acquire();
      expected.set(label, lease.token);
      return lease;
    };
    const pending: {
      label: string;
      authorization: string | undefined;
      res: ServerResponse;
    }[] = [];
    const origin = await http(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      const label = body.includes('turn-one') ? 'one' : 'two';
      pending.push({ label, authorization: req.headers.authorization, res });
      if (pending.length === 2)
        for (const item of pending) {
          item.res.setHeader('content-type', 'application/json');
          item.res.end(JSON.stringify(generated));
        }
    });
    await Promise.all(
      ['one', 'two'].map((label) =>
        generateText({
          model: identityLanguageModel(
            createGateway({ baseURL: origin })('fixture/model'),
            new NativeIdentityExecutionContext({
              acquire: () => acquire(label),
            }),
          ),
          prompt: 'turn-' + label,
          maxRetries: 0,
        }),
      ),
    );
    expect(pending).toHaveLength(2);
    expect(new Set(expected.values()).size).toBe(2);
    for (const item of pending)
      expect(item.authorization).toBe('Bearer ' + expected.get(item.label));
    expect(f.calls()).toBe(2);
    expect(ambient().headers['x-vercel-oidc-token']).toBeUndefined();
  });
  it('preserves native metadata and blocks retained headers and detached descendants after callback settlement', async () => {
    const f = await broker();
    let retained: any, release!: () => void, detached!: Promise<unknown>;
    await f.context.run(async () => {
      retained = ambient();
      expect(retained.headers['native-marker']).toBe('preserved');
      expect(retained.headers['x-vercel-oidc-token']).toMatch(/\./);
      expect(JSON.stringify(retained)).not.toContain('x-vercel-oidc-token');
      detached = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => ambient().headers['x-vercel-oidc-token']);
    });
    expect(() => retained.headers['x-vercel-oidc-token']).toThrow(
      'Provider identity lease is unavailable',
    );
    release();
    await expect(detached).rejects.toMatchObject({ code: 'unavailable' });
    expect(ambient().headers).toEqual({ 'native-marker': 'preserved' });
  });
  it('rejects unbranded/expired leases and clears scope after an operation throws', async () => {
    const f = await broker(),
      lease = await f.client.acquire();
    let invoked = false;
    const invalid = new NativeIdentityExecutionContext({
      acquire: async () =>
        ({ ...lease, token: lease.token }) as ValidatedIdentityLease,
    });
    await expect(
      invalid.run(async () => {
        invoked = true;
      }),
    ).rejects.toMatchObject({ code: 'verification' });
    await expect(
      new NativeIdentityExecutionContext({
        acquire: async () => lease,
        clock: () => lease.expiresAt,
      }).run(async () => {
        invoked = true;
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(invoked).toBe(false);
    await expect(
      f.context.run(async () => {
        throw new Error('Synthetic operation failure');
      }),
    ).rejects.toThrow('Synthetic operation failure');
    expect(ambient().headers['x-vercel-oidc-token']).toBeUndefined();
  });
  it('fails closed when a validated grant expires during the callback or broker scope is rejected', async () => {
    const f = await broker(),
      lease = await f.client.acquire();
    let now = Date.now();
    const context = new NativeIdentityExecutionContext({
      acquire: async () => lease,
      clock: () => now,
    });
    await expect(
      context.run(async () => {
        now = lease.expiresAt;
        expect(() => ambient()).toThrow(
          'Provider identity lease is unavailable',
        );
        return 'must not publish';
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    f.setToken(await token('wrong-scope', { project_id: 'prj_Other' }));
    let invoked = false;
    await expect(
      f.context.run(async () => {
        invoked = true;
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(invoked).toBe(false);
  });
  it('authenticates real Sandbox create through the validated context without putting credentials inside the VM', async () => {
    const f = await broker(),
      current = await token('sandbox');
    f.setToken(current);
    const received: any[] = [];
    const origin = await http(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Synthetic SDK refusal"}}');
    });
    const runtime = new VercelSandboxMediaRuntime(
      { image: 'private-fixture@sha256:' + 'a'.repeat(64), timeoutMs: 240000 },
      (params) =>
        Sandbox.create({
          ...params,
          fetch: async (input, init) => {
            const request = new Request(input, init),
              url = new URL(request.url);
            return fetch(origin + url.pathname + url.search, {
              method: request.method,
              headers: request.headers,
              body: await request.arrayBuffer(),
            });
          },
        }),
      undefined,
      f.context,
    );
    await expect(
      runtime.audioRenderDriver.render({
        content: initialAudioContent(),
        assets: new Map(),
        format: 'wav',
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(received).toHaveLength(1);
    expect(received[0].headers.authorization).toBe('Bearer ' + current);
    expect(received[0].body).toMatchObject({
      persistent: false,
      networkPolicy: { mode: 'deny-all' },
    });
    expect(received[0].body.env ?? {}).toEqual({});
  });
  it('enters a fresh validated scope for every Sandbox file/command/stop operation', async () => {
    const f = await broker(),
      files = new Map<string, Buffer>(),
      seen: string[] = [],
      output = Buffer.from('synthetic-media');
    const check = (label: string) => {
      expect(ambient().headers['x-vercel-oidc-token']).toMatch(/\./);
      seen.push(label);
    };
    const create = async () => {
      check('create');
      return {
        writeFiles: async (items: any[]) => {
          check('write');
          for (const item of items)
            files.set(item.path, Buffer.from(item.content));
        },
        runCommand: async () => {
          check('run');
          const raw = files.get('/vercel/sandbox/request.json')!,
            request = JSON.parse(raw.toString()),
            sha256 = (value: Uint8Array) =>
              createHash('sha256').update(value).digest('hex');
          files.set(
            '/vercel/sandbox/result.json',
            Buffer.from(
              JSON.stringify({
                protocolVersion: 1,
                id: request.id,
                requestSha256: sha256(raw),
                worker: {
                  workerVersion: 'studio-media-worker-v1',
                  files: Object.fromEntries(
                    ['worker', 'ffmpeg', 'ffprobe', 'chromium', 'font'].map(
                      (key) => [key, '0'.repeat(64)],
                    ),
                  ),
                  versions: {
                    node: 'synthetic',
                    ffmpeg: 'synthetic',
                    ffprobe: 'synthetic',
                    chromium: 'synthetic',
                  },
                },
                status: 'completed',
                output: { byteSize: output.length, sha256: sha256(output) },
              }),
            ),
          );
          files.set('/vercel/sandbox/output.bin', output);
          return { exitCode: 0 };
        },
        readFile: async ({ path }: any) => {
          check('read');
          return files.has(path) ? Readable.from([files.get(path)!]) : null;
        },
        stop: async () => {
          check('stop');
        },
      };
    };
    const runtime = new VercelSandboxMediaRuntime(
      { image: 'private-fixture@sha256:' + 'a'.repeat(64), timeoutMs: 240000 },
      create as unknown as MediaSandboxFactory,
      undefined,
      f.context,
    );
    expect(
      await runtime.audioRenderDriver.render({
        content: initialAudioContent(),
        assets: new Map(),
        format: 'wav',
        signal: AbortSignal.timeout(3000),
      }),
    ).toEqual(output);
    expect(seen).toEqual(['create', 'write', 'run', 'read', 'read', 'stop']);
    expect(f.calls()).toBe(seen.length);
  });
});
