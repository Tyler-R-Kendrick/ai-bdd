import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { QueueClient } from '@vercel/queue';
import { createGateway, generateText } from 'ai';
import { VercelQueueDispatcher } from '../server/hosting/vercel-queue.ts';
import { VercelSchedulerDispatcher } from '../server/hosting/vercel-scheduler.ts';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
// Deliberately unsigned local transport fixtures. No provider/secret file is used.
function jwt(label: string) {
  return (
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') +
    '.' +
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 7200,
        owner_id: 'team_fixture',
        project_id: 'prj_fixture',
        jti: label,
      }),
    ).toString('base64url') +
    '.synthetic'
  );
}
async function fixture() {
  for (const name of [
    'VERCEL_OIDC_TOKEN',
    'VERCEL_OIDC_TOKEN_FILE',
    'AI_GATEWAY_API_KEY',
    'VERCEL_QUEUE_BASE_URL',
    'VERCEL_QUEUE_TOKEN',
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_oidc_fixture');
  const symbol = Symbol.for('@vercel/request-context'),
    platform = globalThis as typeof globalThis & { [key: symbol]: unknown },
    previous = platform[symbol];
  let header: string | undefined;
  platform[symbol] = {
    get: () => ({ headers: header ? { 'x-vercel-oidc-token': header } : {} }),
  };
  cleanup.push(() => {
    if (previous === undefined) delete platform[symbol];
    else platform[symbol] = previous;
  });
  const dir = await mkdtemp(join(tmpdir(), 'studio-oidc-rotation-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic-token'),
    a = jwt('A'),
    b = jwt('B');
  await writeFile(path, a, { mode: 0o600 });
  vi.stubEnv('VERCEL_OIDC_TOKEN_FILE', path);
  const requests: {
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: any;
  }[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    requests.push({
      path: req.url!,
      headers: req.headers,
      body: text ? JSON.parse(text) : null,
    });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url!.startsWith('/api/v3/topic/')
          ? { messageId: 'synthetic-message' }
          : {
              content: [
                { type: 'text', text: 'Synthetic native SDK response.' },
              ],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              warnings: [],
            },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const regions: string[] = [];
  const client = new QueueClient({
    region: 'iad1',
    deploymentId: 'dpl_oidc_fixture',
    resolveBaseUrl: (region) => {
      regions.push(region);
      return new URL(origin);
    },
  });
  const model = createGateway({ baseURL: origin })('fixture/model');
  return {
    a,
    b,
    path,
    requests,
    regions,
    client,
    model,
    setHeader: (value: string | undefined) => {
      header = value;
    },
    rotate: async (value: string) => {
      await writeFile(path + '.next', value, { mode: 0o600 });
      await rename(path + '.next', path);
    },
  };
}
describe('pinned real Queue/Gateway SDK rotating-file OIDC compatibility', () => {
  it('resolves only the selected SDKs to the pinned OIDC4 Node implementation', async () => {
    const require = createRequire(import.meta.url);
    const gateway = createRequire(require.resolve('ai')).resolve(
      '@ai-sdk/gateway',
    );
    for (const sdk of [require.resolve('@vercel/queue'), gateway]) {
      const oidc = createRequire(sdk).resolve('@vercel/oidc');
      expect(
        JSON.parse(
          await readFile(join(dirname(oidc), '../package.json'), 'utf8'),
        ).version,
      ).toBe('4.0.5');
    }
  });
  it('publishes job and maintenance messages with fresh file tokens while preserving scope and idempotency', async () => {
    const x = await fixture(),
      jobs = new VercelQueueDispatcher({ region: 'iad1', client: x.client }),
      scheduler = new VercelSchedulerDispatcher({
        region: 'iad1',
        client: x.client,
      });
    const jobId = crypto.randomUUID(),
      dispatchId = crypto.randomUUID();
    await jobs.publish(jobId, { dispatchId, delaySeconds: 2 });
    await x.rotate(x.b);
    await scheduler.publish(
      { schemaVersion: 1, generation: crypto.randomUUID(), bucket: 12345 },
      { dispatchId, delaySeconds: 3 },
    );
    expect(x.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer ' + x.a,
      'Bearer ' + x.b,
    ]);
    expect(x.requests[0]).toMatchObject({
      path: '/api/v3/topic/studio-jobs-v1',
      body: { schemaVersion: 1, jobId },
      headers: {
        'vqs-deployment-id': 'dpl_oidc_fixture',
        'vqs-idempotency-key': 'studio-dispatch:' + dispatchId,
        'vqs-retention-seconds': '86400',
        'vqs-delay-seconds': '2',
      },
    });
    expect(x.requests[1]?.headers).toMatchObject({
      'vqs-deployment-id': 'dpl_oidc_fixture',
      'vqs-idempotency-key': 'studio-tick:' + dispatchId,
      'vqs-retention-seconds': '86400',
      'vqs-delay-seconds': '3',
    });
    expect(x.regions.every((region) => region === 'iad1')).toBe(true);
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined();
  });
  it('reuses the same real Gateway model with freshly rotated files and keeps native OIDC auth classification', async () => {
    const x = await fixture();
    for (const token of [x.a, x.b]) {
      await x.rotate(token);
      expect(
        (
          await generateText({
            model: x.model,
            prompt: 'Synthetic HTTP fixture only.',
            maxRetries: 0,
          })
        ).text,
      ).toBe('Synthetic native SDK response.');
    }
    expect(x.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer ' + x.a,
      'Bearer ' + x.b,
    ]);
    expect(
      x.requests.every(
        (r) =>
          r.headers['ai-gateway-auth-method'] === 'oidc' &&
          r.path === '/language-model',
      ),
    ).toBe(true);
    expect(process.env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(process.env.VERCEL_OIDC_TOKEN).toBeUndefined();
  });
  it('preserves environment compatibility and trusted request-context precedence without global credential mutation', async () => {
    const x = await fixture();
    vi.stubEnv('VERCEL_OIDC_TOKEN_FILE', undefined);
    vi.stubEnv('VERCEL_OIDC_TOKEN', x.a);
    await x.client.send('sdk-fixture', {});
    await generateText({
      model: x.model,
      prompt: 'Env fixture.',
      maxRetries: 0,
    });
    vi.stubEnv('VERCEL_OIDC_TOKEN_FILE', x.path + '.missing');
    x.setHeader(x.b);
    await x.client.send('sdk-fixture', {});
    await generateText({
      model: x.model,
      prompt: 'Context fixture.',
      maxRetries: 0,
    });
    expect(x.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer ' + x.a,
      'Bearer ' + x.a,
      'Bearer ' + x.b,
      'Bearer ' + x.b,
    ]);
    expect(
      x.requests
        .filter((r) => r.path === '/language-model')
        .every((r) => r.headers['ai-gateway-auth-method'] === 'oidc'),
    ).toBe(true);
    expect(process.env.VERCEL_OIDC_TOKEN).toBe(x.a);
  });
  it.each(['missing', 'empty', 'malformed'])(
    'fails closed for a configured %s token file instead of using another environment identity',
    async (kind) => {
      const x = await fixture();
      vi.stubEnv('VERCEL_OIDC_TOKEN', x.b);
      if (kind === 'missing')
        vi.stubEnv('VERCEL_OIDC_TOKEN_FILE', x.path + '.missing');
      else await x.rotate(kind === 'empty' ? ' \n' : 'not-a-jwt');
      await expect(x.client.send('sdk-fixture', {})).rejects.toBeInstanceOf(
        Error,
      );
      await expect(
        generateText({
          model: x.model,
          prompt: 'Must not reach the provider.',
          maxRetries: 0,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(x.requests).toEqual([]);
      expect(process.env.VERCEL_OIDC_TOKEN).toBe(x.b);
    },
  );
});
