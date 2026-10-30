import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { QueueClient } from '@vercel/queue';
import {
  createVercelJobCallback,
  VercelQueueDispatcher,
} from '../server/hosting/vercel-queue.ts';
import { STUDIO_QUEUE_TOPIC } from '../server/hosting/config.ts';

/** This fixture exercises the real SDK transport; it is not live Vercel evidence. */
describe('Vercel queue SDK transport and consumer contract', () => {
  const seen: {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }[] = [];
  let origin: string;
  let client: QueueClient;
  let deferred = false;
  const server = createServer(async (request, reply) => {
    if (request.headers.authorization !== 'Bearer fixture-queue-token') {
      reply.writeHead(403);
      reply.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    seen.push({
      method: request.method!,
      path: request.url!,
      headers: request.headers,
      body: text ? JSON.parse(text) : null,
    });
    reply.writeHead(request.method === 'POST' && deferred ? 202 : 200, {
      'content-type': 'application/json',
    });
    reply.end(JSON.stringify({ messageId: 'fixture-message-1' }));
  });
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    client = new QueueClient({
      region: 'iad1',
      token: 'fixture-queue-token',
      deploymentId: 'dpl_fixture',
      resolveBaseUrl: () => new URL(origin),
    });
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  function delivery(payload: unknown) {
    return new Request('https://studio.example.test/api/studio-jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ce-type': 'com.vercel.queue.v2beta',
        'ce-vqsqueuename': STUDIO_QUEUE_TOPIC,
        'ce-vqsconsumergroup': 'fixture-consumer',
        'ce-vqsmessageid': 'fixture-message-1',
        'ce-vqsreceipthandle': 'fixture-lease',
        'ce-vqsdeliverycount': '3',
        'ce-vqscreatedat': new Date().toISOString(),
        'ce-vqsexpiresat': new Date(Date.now() + 86400000).toISOString(),
        'ce-vqsvisibilitydeadline': new Date(Date.now() + 300000).toISOString(),
        'ce-vqsregion': 'iad1',
      },
      body: JSON.stringify(payload),
    });
  }
  it('publishes only durable identity, with deployment pinning and idempotency', async () => {
    const dispatcher = new VercelQueueDispatcher({ region: 'iad1', client });
    const jobId = crypto.randomUUID();
    const receipt = await dispatcher.publish(jobId);
    expect(receipt.messageId).toBe('fixture-message-1');
    expect(seen.at(-1)?.body).toEqual({ schemaVersion: 1, jobId });
    expect(seen.at(-1)?.headers['vqs-deployment-id']).toBe('dpl_fixture');
    expect(Object.values(seen.at(-1)!.headers)).toContain(
      `studio-dispatch:${jobId}`,
    );
    deferred = true;
    expect(await dispatcher.publish(crypto.randomUUID())).toEqual({
      provider: 'vercel-queue',
    });
    deferred = false;
    await expect(dispatcher.publish('not-a-job-identity')).rejects.toThrow();
  });
  it('executes a prefetched delivery and acknowledges only after the executor completes', async () => {
    const start = seen.length;
    const jobId = crypto.randomUUID();
    let completed = false;
    const callback = createVercelJobCallback({
      region: 'iad1',
      client,
      executor: async (id, context) => {
        expect(id).toBe(jobId);
        expect(context.deliveryCount).toBe(3);
        expect(context.signal?.aborted).toBe(false);
        expect(context.deadlineAt).toBeGreaterThan(Date.now());
        expect(seen.slice(start).some((item) => item.method === 'DELETE')).toBe(
          false,
        );
        completed = true;
      },
    });
    const response = await callback(delivery({ schemaVersion: 1, jobId }));
    expect(response.status).toBe(200);
    expect(completed).toBe(true);
    expect(seen.at(-1)?.method).toBe('DELETE');
  });
  it('reschedules transient failures instead of falsely acknowledging domain completion', async () => {
    const start = seen.length;
    const callback = createVercelJobCallback({
      region: 'iad1',
      client,
      executor: async () => {
        throw new Error('Explicit transient executor fixture');
      },
    });
    const response = await callback(
      delivery({ schemaVersion: 1, jobId: crypto.randomUUID() }),
    );
    expect(response.status).toBe(200);
    expect(seen.slice(start).some((item) => item.method === 'PATCH')).toBe(
      true,
    );
    expect(seen.slice(start).some((item) => item.method === 'DELETE')).toBe(
      false,
    );
  });
  it('drops malformed provider envelopes without invoking application work', async () => {
    let executed = false;
    const callback = createVercelJobCallback({
      region: 'iad1',
      client,
      executor: async () => {
        executed = true;
      },
    });
    const response = await callback(
      delivery({
        schemaVersion: 1,
        jobId: crypto.randomUUID(),
        artifactSource: 'must never be accepted in a queue envelope',
      }),
    );
    expect(response.status).toBe(200);
    expect(executed).toBe(false);
    expect(seen.at(-1)?.method).toBe('DELETE');
  });
});
