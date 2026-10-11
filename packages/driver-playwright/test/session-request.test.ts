import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import type { Driver, DriverSession, Policy, SessionOptions, ValueSource } from '@ai-bdd/sdk/contracts';
import { playwright } from '../src/index.ts';
import { browserAvailable } from './browser.ts';
import { startEdgeServer } from './edge-server.ts';
import type { EdgeServer } from './edge-server.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const hasBrowser = await browserAvailable();
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };

let edge: EdgeServer;
let driver: Driver;

function sessionOpts(over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    scenarioId: 'edge', baseURL: edge.url, policy,
    resolveValue: (v: ValueSource) => ('literal' in v ? v.literal : ''),
    ...over,
  };
}
const open = (over: Partial<SessionOptions> = {}): Promise<DriverSession> => driver.openSession(sessionOpts(over));
const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe.skipIf(!hasBrowser)('driver-playwright request()', () => {
  beforeAll(async () => {
    edge = await startEdgeServer();
    driver = await playwright({ actionTimeoutMs: 1500 }).create({ projectRoot: process.cwd(), policy, artifactsDir: process.cwd(), baseURL: edge.url });
  });
  afterAll(async () => {
    await driver.dispose();
    await edge.close();
  });

  describe('request()', () => {
    it('R-RN2: without a baseURL a relative path is a non-retryable DRIVER_ERROR, while an absolute URL still works', async () => {
      const bare = await playwright().create({ projectRoot: '.', policy, artifactsDir: process.cwd() });
      const s = await bare.openSession({ scenarioId: 'bare', policy, resolveValue: () => '' });
      const err = await errorOf(s.request?.({ method: 'GET', path: '/api/echo' }) as Promise<unknown>);
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({ code: 'DRIVER_ERROR', retryable: false, message: 'cannot resolve request path "/api/echo" without a baseURL' });
      const ok = await s.request?.({ method: 'get', path: `${edge.url}/api/echo` });
      expect(ok).toMatchObject({ status: 200, body: { method: 'GET', body: '' } });
      await s.close();
      await bare.dispose();
    });

    it('R-RN2: a string body is sent verbatim and, unlike an object body, gets no JSON content type; headers pass through', async () => {
      const s = await open();
      const raw = await s.request?.({ method: 'post', path: '/api/echo', body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(raw).toEqual({ status: 200, body: { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'a=1&b=2' } });
      const json = await s.request?.({ method: 'POST', path: '/api/echo', body: { a: [1, 2] } });
      expect(json).toEqual({ status: 200, body: { method: 'POST', contentType: 'application/json', body: '{"a":[1,2]}' } });
      await s.close();
    });

    it('R-RN2: an explicit Content-Type (any casing) is kept when the body is JSON', async () => {
      const s = await open();
      const res = await s.request?.({ method: 'PUT', path: '/api/echo', body: { a: 1 }, headers: { 'Content-Type': 'application/vnd.test+json' } });
      expect(res).toEqual({ status: 200, body: { method: 'PUT', contentType: 'application/vnd.test+json', body: '{"a":1}' } });
      await s.close();
    });

    it('R-RN2: response bodies are parsed by content type: JSON variants parse, invalid JSON and other types come back as text', async () => {
      const s = await open();
      expect(await s.request?.({ method: 'GET', path: '/jsonish' })).toEqual({ status: 200, body: { problem: true } });
      expect(await s.request?.({ method: 'GET', path: '/badjson' })).toEqual({ status: 200, body: 'not json {' });
      expect(await s.request?.({ method: 'GET', path: '/text' })).toEqual({ status: 200, body: 'plain text' });
      expect(await s.request?.({ method: 'GET', path: '/nothing-here' })).toEqual({ status: 404, body: 'not found' });
      await s.close();
    });

    it('R-AG3: redirects are followed hop by hop; 303 (and 301/302 after POST) switch to GET and drop the body, 307/308 keep both', async () => {
      const s = await open();
      const post = (status: number, method = 'POST') =>
        s.request?.({ method, path: `/r?status=${status}&to=/api/echo`, body: 'payload', headers: { 'content-type': 'text/plain' } });
      const echoed = async (status: number, method = 'POST'): Promise<{ method: string; body: string }> => {
        const res = (await post(status, method)) as { status: number; body: { method: string; body: string } };
        expect(res.status).toBe(200);
        return { method: res.body.method, body: res.body.body };
      };
      expect(await echoed(303)).toEqual({ method: 'GET', body: '' });
      expect(await echoed(302)).toEqual({ method: 'GET', body: '' });
      expect(await echoed(301)).toEqual({ method: 'GET', body: '' });
      expect(await echoed(307)).toEqual({ method: 'POST', body: 'payload' });
      expect(await echoed(308)).toEqual({ method: 'POST', body: 'payload' });
      // 301/302 keep the method for anything other than POST, 303 never does.
      expect(await echoed(302, 'PUT')).toEqual({ method: 'PUT', body: 'payload' });
      expect(await echoed(303, 'PUT')).toEqual({ method: 'GET', body: '' });
      await s.close();
    });

    it('R-AG3: a redirect that turns the request into a bodyless GET drops the headers that described the body; 307/308 keep them', async () => {
      const s = await open();
      const sent = async (status: number): Promise<{ method: string; contentType: string | null }> => {
        const res = (await s.request?.({
          method: 'POST', path: `/r?status=${status}&to=/api/echo`, body: 'payload', headers: { 'Content-Type': 'text/plain', 'content-length': '7', 'x-keep': '1' },
        })) as { status: number; body: { method: string; contentType: string | null } };
        expect(res.status).toBe(200);
        return res.body;
      };
      for (const status of [301, 302, 303]) expect(await sent(status), String(status)).toMatchObject({ method: 'GET', contentType: null });
      for (const status of [307, 308]) expect(await sent(status), String(status)).toMatchObject({ method: 'POST', contentType: 'text/plain' });
      await s.close();
    });

    it('R-AG3: a relative Location resolves against the URL that sent it; a redirect without Location is returned as the answer', async () => {
      const s = await open();
      const before = edge.hits.length;
      expect(await s.request?.({ method: 'GET', path: '/r?status=302&to=text' })).toEqual({ status: 200, body: 'plain text' });
      expect(edge.hits.slice(before)).toEqual(['GET /r', 'GET /text']);
      expect(await s.request?.({ method: 'GET', path: '/nolocation' })).toEqual({ status: 302, body: 'stay here' });
      await s.close();
    });

    it('R-AG3: up to five redirects are followed; a sixth ends with a non-retryable "too many redirects" error instead of returning a 302', async () => {
      const s = await open();
      expect(await s.request?.({ method: 'GET', path: '/chain?n=5' })).toEqual({ status: 200, body: 'end of chain' });
      const before = edge.hits.length;
      const err = await errorOf(s.request?.({ method: 'GET', path: '/chain?n=6' }) as Promise<unknown>);
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({ code: 'DRIVER_ERROR', message: 'too many redirects', retryable: false });
      expect(edge.hits.slice(before)).toEqual(Array.from({ length: 6 }, () => 'GET /chain'));
      const loop = await errorOf(s.request?.({ method: 'GET', path: '/loop' }) as Promise<unknown>);
      expect(loop).toMatchObject({ code: 'DRIVER_ERROR', message: 'too many redirects' });
      await s.close();
    });

    it('R-RN2: transport failures surface as DRIVER_ERROR with the cause, not as hangs or POLICY_DENIED', async () => {
      const s = await open();
      const err = await errorOf(s.request?.({ method: 'GET', path: 'http://localhost:1/never' }) as Promise<unknown>);
      expect(err).toBeInstanceOf(AiBddError);
      expect(err).toMatchObject({ code: 'DRIVER_ERROR' });
      expect((err as Error).message).toContain('ECONNREFUSED');
      await s.close();
    });
  });
});
