import { Agent, request } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAcmeApp } from '../../src/app/index.ts';
import { Client } from './client.ts';
import { toAxNodes } from './html-parse.ts';

const TOKEN = { 'x-acme-test-token': 'acme-test' };
const names = (html: string): string[] => toAxNodes(html).map((n) => `${n.role}:${n.name}`);

describe('startAcmeApp edge cases', () => {
  let app: Awaited<ReturnType<typeof startAcmeApp>>;
  beforeAll(async () => {
    app = await startAcmeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers HEAD with the headers of GET and no body; every other method outside GET and HEAD is 405 with an Allow header', async () => {
    const c = new Client(app.url);
    const get = await c.req('GET', '/todos');
    const head = await c.req('HEAD', '/todos');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    expect(head.headers.get('content-security-policy')).toBe(get.headers.get('content-security-policy'));
    for (const method of ['PUT', 'DELETE', 'PATCH', 'POST']) {
      const res = await c.req(method, '/todos');
      expect([method, res.status, res.headers.get('allow'), res.text]).toEqual([method, 405, 'GET, HEAD', 'Method Not Allowed']);
    }
    expect((await c.req('POST', '/__act')).status).toBe(303); // POST is what /__act is for
  });

  it('/__redirect without a target is 400 and /__act is POST only', async () => {
    const c = new Client(app.url);
    const missing = await c.get('/__redirect', false);
    expect([missing.status, missing.text]).toEqual([400, 'missing "to"']);
    const act = await c.req('PUT', '/__act');
    expect([act.status, act.headers.get('allow')]).toEqual([405, 'POST']);
  });

  it('the post-action redirect target must be a same-origin absolute path', async () => {
    const c = new Client(app.url);
    const target = async (route: string | undefined): Promise<string | null> =>
      (await c.post('/__act', { ...(route === undefined ? {} : { __route: route }), __action: 'noop.nothing' }, false)).headers.get('location');
    expect(await target(undefined)).toBe('/settings/billing');
    expect(await target('/todos?x=1')).toBe('/todos?x=1');
    expect(await target('relative/path')).toBe('/settings/billing');
    expect(await target('//evil.example')).toBe('/settings/billing');
    expect(await target('/ok\\..\\evil')).toBe('/settings/billing');
    expect(await target('')).toBe('/settings/billing');
  });

  it('a post without an action just redirects, and only fields without the __ prefix reach the action', async () => {
    const c = new Client(app.url);
    const plain = await c.post('/__act', { __route: '/todos' }, false);
    expect([plain.status, plain.headers.get('location')]).toEqual([303, '/todos']);
    await c.get('/login');
    const wrong = await c.post('/__act', { __route: '/login', __action: 'login.submit', password: 'nope', __password: 'correct-horse-battery' });
    expect(names(wrong.text)).toContain('alert:Invalid email or password');
  });

  it('cookies are parsed leniently: junk entries are skipped and whitespace around the session id is ignored', async () => {
    const a = new Client(app.url);
    await a.json('/__test/seed', { plan: 'pro' }, TOKEN);
    const sid = /acme_sid=([^;]+)/.exec(a.sid)?.[1] as string;
    const viaOdd = await fetch(`${app.url}/settings/billing`, { headers: { cookie: `junk; =novalue; other=1;  acme_sid = ${sid} ; z=9` } });
    expect(viaOdd.headers.get('set-cookie')).toBeNull(); // the existing session was recognised
    expect(names(await viaOdd.text())).toContain('status:Plan: Pro');
    const junkOnly = await fetch(`${app.url}/settings/billing`, { headers: { cookie: 'junk; =x; acme_sid' } });
    expect(junkOnly.headers.get('set-cookie')).toMatch(/^acme_sid=[0-9a-f-]{36};/);
    expect(names(await junkOnly.text())).toContain('status:Plan: Free');
  });

  it('a body over the limit on /__test is refused without bringing the server down', async () => {
    const status = await new Promise<string>((resolve) => {
      const url = new URL(app.url);
      const socket = connect(Number(url.port), url.hostname, () => {
        const body = 'x'.repeat(70 * 1024);
        socket.write(`POST /__test/seed HTTP/1.1\r\nhost: x\r\nx-acme-test-token: acme-test\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
      });
      let got = '';
      socket.on('data', (d: Buffer) => { got += d.toString('latin1'); });
      socket.on('close', () => resolve(got.split('\r\n')[0] ?? ''));
      socket.on('error', () => resolve(''));
    });
    expect(['', 'HTTP/1.1 500 Internal Server Error']).toContain(status); // the connection is cut; if a status gets out it is a 500
    expect((await new Client(app.url).get('/todos')).status).toBe(200);
  });

  it('close() twice rejects the second time, and a port that is taken fails the start', async () => {
    const other = await startAcmeApp();
    const port = Number(new URL(other.url).port);
    await expect(startAcmeApp({ port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await other.close();
    await expect(other.close()).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
  });

  it('startAcmeApp({ port }) listens on that port on the loopback interface', async () => {
    const probe = await startAcmeApp();
    const port = Number(new URL(probe.url).port);
    await probe.close();
    const again = await startAcmeApp({ port });
    try {
      expect(again.url).toBe(`http://127.0.0.1:${port}`);
      expect((await new Client(again.url).get('/login')).status).toBe(200);
    } finally {
      await again.close();
    }
  });
});

describe('session table limit', () => {
  it('keeps the newest 5000 sessions: when it is full the oldest one is forgotten, the rest keep their state', async () => {
    const small = await startAcmeApp();
    const agent = new Agent({ keepAlive: true, maxSockets: 32 });
    try {
      const first = new Client(small.url);
      await first.json('/__test/seed', { plan: 'pro' }, TOKEN);
      const second = new Client(small.url);
      await second.json('/__test/seed', { plan: 'pro' }, TOKEN);
      expect(names((await first.get('/settings/billing')).text)).toContain('status:Plan: Pro');

      // 4998 more sessions fill the table to its limit (5000) without evicting anyone.
      const head = (): Promise<void> => new Promise((resolve, reject) => {
        const req = request(`${small.url}/login`, { method: 'HEAD', agent }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      });
      const fill = async (n: number): Promise<void> => {
        for (let done = 0; done < n; done += 200) await Promise.all(Array.from({ length: Math.min(200, n - done) }, head));
      };
      await fill(4998);
      expect(names((await first.get('/settings/billing')).text)).toContain('status:Plan: Pro');
      expect(names((await second.get('/settings/billing')).text)).toContain('status:Plan: Pro');

      // One more session evicts the oldest (the first). The second is the next oldest, so it is still there ...
      await fill(1);
      expect(names((await second.get('/settings/billing')).text)).toContain('status:Plan: Pro');
      // ... and the first starts over with a new cookie (which, in turn, pushes the second to the front of the queue).
      const reborn = await first.get('/settings/billing');
      expect(names(reborn.text)).toContain('status:Plan: Free');
      expect(reborn.headers.get('set-cookie')).toMatch(/^acme_sid=/);
    } finally {
      agent.destroy();
      await small.close();
    }
  }, 60_000);
});
