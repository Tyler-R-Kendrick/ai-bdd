import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { QueueClient } from '@vercel/queue';
import {
  providerFailureDiagnostic,
  reportProviderFailure,
  type ProviderFailureDiagnostic,
} from '../server/hosting/provider-diagnostics.ts';
import { VercelQueueDispatcher } from '../server/hosting/vercel-queue.ts';
import { VercelSchedulerDispatcher } from '../server/hosting/vercel-scheduler.ts';

const symbol = Symbol.for('@vercel/request-context');
const globals = globalThis as Record<symbol, unknown>;
const previousContext = globals[symbol];
afterEach(() => {
  globals[symbol] = previousContext;
  vi.unstubAllEnvs();
});
describe('finite provider failure diagnostics', () => {
  it('does not inspect provider messages, payloads, or credential paths', () => {
    globals[symbol] = {
      get: () => ({
        headers: { 'x-vercel-oidc-token': 'private-context-token' },
      }),
    };
    const error = {
      name: 'ForbiddenError',
      code: 'ECONNRESET',
      status: 403,
      get message() {
        throw new Error('message must not be read');
      },
      get body() {
        throw new Error('body must not be read');
      },
      get headers() {
        throw new Error('headers must not be read');
      },
    };
    const diagnostic = providerFailureDiagnostic(
      'maintenance-publish',
      error,
      {
        VERCEL_OIDC_TOKEN: 'private-environment-token',
        VERCEL_OIDC_TOKEN_FILE: '/private/never-open-this-file',
      },
    );
    expect(diagnostic).toEqual({
      event: 'studio_provider_dispatch_failed',
      provider: 'vercel-queue',
      operation: 'maintenance-publish',
      errorClass: 'ForbiddenError',
      status: 403,
      code: 'ECONNRESET',
      tokenEnvPresent: true,
      tokenFileEnvPresent: true,
      contextAvailable: true,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /private-context-token|private-environment-token|never-open/,
    );
  });
  it('discards arbitrary provider class/code/status strings and broken context getters', () => {
    globals[symbol] = {
      get: () => {
        throw new Error('private-context-error');
      },
    };
    const diagnostic = providerFailureDiagnostic(
      'job-publish',
      { name: 'secret-class', code: 'secret-code', status: 'secret-status' },
      {},
    );
    expect(diagnostic).toMatchObject({
      errorClass: 'Unknown',
      code: null,
      status: null,
      contextAvailable: false,
      tokenEnvPresent: false,
      tokenFileEnvPresent: false,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /secret|private-context-error/,
    );
  });
  it('cannot replace the original provider error if the reporter fails', async () => {
    const original = new Error('private-original-error');
    const dispatcher = new VercelQueueDispatcher({
      region: 'iad1',
      client: {
        send: async () => {
          throw original;
        },
        handleCallback: vi.fn(),
      } as unknown as QueueClient,
      onFailure: () => {
        throw new Error('private-reporter-error');
      },
    });
    await expect(dispatcher.publish(crypto.randomUUID())).rejects.toBe(
      original,
    );
    expect(() =>
      reportProviderFailure(undefined, 'job-publish', original),
    ).not.toThrow();
  });
  it('reports actual SDK HTTP failures for both dispatchers without response or auth leakage', async () => {
    const secret = 'fixture-private-auth-and-provider-body';
    let failed = true;
    let calls = 0;
    const server = createServer(async (request, reply) => {
      calls++;
      for await (const _ of request) {
        /* consume the bounded actual SDK request */
      }
      reply.writeHead(failed ? 403 : 200, {
        'content-type': 'application/json',
      });
      reply.end(
        JSON.stringify(
          failed ? { error: secret } : { messageId: 'fixture-message' },
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const origin =
        'http://127.0.0.1:' + (server.address() as { port: number }).port;
      const client = new QueueClient({
        region: 'iad1',
        token: secret,
        deploymentId: 'dpl_diagnostic_fixture',
        resolveBaseUrl: () => new URL(origin),
      });
      const diagnostics: ProviderFailureDiagnostic[] = [];
      const onFailure = (item: ProviderFailureDiagnostic) =>
        diagnostics.push(item);
      const jobs = new VercelQueueDispatcher({
        region: 'iad1',
        client,
        onFailure,
      });
      const scheduler = new VercelSchedulerDispatcher({
        region: 'iad1',
        client,
        onFailure,
      });
      await expect(jobs.publish(crypto.randomUUID())).rejects.toThrow();
      await expect(
        scheduler.publish(
          {
            schemaVersion: 1,
            generation: crypto.randomUUID(),
            bucket: Math.floor(Date.now() / 60_000),
          },
          { dispatchId: crypto.randomUUID(), delaySeconds: 0 },
        ),
      ).rejects.toThrow();
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.map((item) => item.operation)).toEqual([
        'job-publish',
        'maintenance-publish',
      ]);
      expect(
        diagnostics.every(
          (item) =>
            item.errorClass === 'ForbiddenError' && item.status === 403,
        ),
      ).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain(secret);
      expect(JSON.stringify(diagnostics)).not.toContain(origin);
      failed = false;
      await jobs.publish(crypto.randomUUID());
      expect(calls).toBe(3);
      expect(diagnostics).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
