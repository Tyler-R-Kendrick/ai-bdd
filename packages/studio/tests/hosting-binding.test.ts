import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  internalHeaders,
  assertInternalRequest,
} from '../server/hosting/internal-auth.ts';
import {
  forwardInternal,
  bindingJobExecutor,
} from '../server/hosting/binding.ts';
import { registerInternalRoutes } from '../server/hosting/internal-routes.ts';
import { Store } from '../server/store.ts';
import { DurableScheduler } from '../server/hosting/scheduler.ts';
import type { DurableJobRuntime } from '../server/runtime/contracts.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const secret = 'fixture-private-job-secret-over-32-characters';
describe('native queue to private container binding', () => {
  it('forwards only durable identity/delivery over signed HTTP and does not follow redirects', async () => {
    const received: unknown[] = [];
    let redirect = false;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      assertInternalRequest(secret, req.url!, body, {
        time: req.headers['x-studio-time'] as string,
        signature: req.headers['x-studio-signature'] as string,
      });
      received.push(JSON.parse(body));
      if (redirect) {
        res.writeHead(302, { location: 'https://untrusted.example/' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"completed":true}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        ),
    );
    const config = {
        backendUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        secret,
        maxRequestSeconds: 30,
      },
      id = randomUUID();
    await bindingJobExecutor(config)(id, {
      messageId: 'msg',
      deliveryCount: 2,
      region: 'iad1',
      deadlineAt: Date.now() + 5000,
    });
    expect(received).toEqual([
      {
        jobId: id,
        delivery: {
          messageId: 'msg',
          deliveryCount: 2,
          region: 'iad1',
          deadlineAt: expect.any(Number),
        },
      },
    ]);
    redirect = true;
    await expect(
      forwardInternal(config, '/internal/jobs/execute', { jobId: id }),
    ).rejects.toThrow();
    await expect(
      forwardInternal(config, '/other', { jobId: id }),
    ).rejects.toThrow('Unknown');
  });
  it('verifies exact signed bytes before invoking shared durable executor or maintenance', async () => {
    const app = Fastify(),
      store = await Store.open(':memory:');
    cleanup.push(() => store.close());
    cleanup.push(() => app.close());
    const executeJob = vi.fn(async () => {}),
      recover = vi.fn(async () => {}),
      flushOutbox = vi.fn(async () => {});
    const runtime = {
      executeJob,
      recover,
      flushOutbox,
    } as unknown as DurableJobRuntime;
    const deliveries: unknown[] = [];
    const scheduler = await new DurableScheduler(store, {
      provider: 'fixture',
      publish: async (tick) => {
        deliveries.push(tick);
      },
    }).initialize();
    await registerInternalRoutes(app, {
      secret,
      runtime,
      scheduler,
      requestSeconds: 30,
      deploymentId: 'dpl_active',
    });
    const path = '/internal/jobs/execute',
      body = JSON.stringify({
        jobId: randomUUID(),
        delivery: { messageId: 'message', deliveryCount: 1 },
      });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: body,
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: body + ' ',
          headers: internalHeaders(secret, path, body),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: body,
          headers: internalHeaders(secret, path, body),
        })
      ).statusCode,
    ).toBe(200);
    expect(executeJob).toHaveBeenCalledOnce();
    const activate = '/internal/maintenance/activate',
      activation = JSON.stringify({ deploymentId: 'dpl_active' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: activate,
          payload: activation,
          headers: internalHeaders(secret, activate, activation),
        })
      ).statusCode,
    ).toBe(200);
    expect(deliveries).toHaveLength(1);
    const tick = '/internal/maintenance/execute',
      input = JSON.stringify(deliveries[0]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: tick,
          payload: input,
          headers: internalHeaders(secret, tick, input),
        })
      ).statusCode,
    ).toBe(200);
    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith({ dispatchLimit: 5 });
    expect(flushOutbox).not.toHaveBeenCalled();
    const stale = JSON.stringify({ deploymentId: 'dpl_old' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: activate,
          payload: stale,
          headers: internalHeaders(secret, activate, stale),
        })
      ).statusCode,
    ).toBe(409);
  });
});
