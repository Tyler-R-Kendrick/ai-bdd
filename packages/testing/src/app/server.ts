import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderPage } from './html.ts';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_TEST_TOKEN,
  dispatch,
  initialState,
  pathOf,
  resolveRoute,
  type AcmeState,
} from './model.ts';
import { handleTestApi } from './test-api.ts';

export interface AcmeAppOptions {
  port?: number;
  adminPassword?: string;
  testToken?: string;
  flags?: string[];
}

const MAX_BODY = 64 * 1024;
const MAX_SESSIONS = 5000;
const COOKIE = 'acme_sid';

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Only same-origin absolute paths may be used as a post-action redirect target. */
function safeRoute(route: string | null): string {
  if (route === null || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return '/settings/billing';
  return route;
}

export async function startAcmeApp(opts: AcmeAppOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const adminPassword = opts.adminPassword ?? DEFAULT_ADMIN_PASSWORD;
  const testToken = opts.testToken ?? DEFAULT_TEST_TOKEN;
  const initial = initialState({ flags: opts.flags ?? [], adminPassword });
  const sessions = new Map<string, AcmeState>();

  function session(req: IncomingMessage): { sid: string; fresh: boolean } {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid !== undefined && sessions.has(sid)) return { sid, fresh: false };
    const created = randomUUID();
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done !== true) sessions.delete(oldest.value);
    }
    sessions.set(created, initial);
    return { sid: created, fresh: true };
  }

  function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string, setSid?: string): void {
    const h: Record<string, string | string[]> = { 'cache-control': 'no-store', ...headers };
    if (setSid !== undefined) h['set-cookie'] = `${COOKIE}=${setSid}; Path=/; HttpOnly; SameSite=Lax`;
    res.writeHead(status, h);
    res.end(body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://acme.local');
    const route = url.pathname + url.search;
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const { sid, fresh } = session(req);
    const sidCookie = fresh ? sid : undefined;
    let state = sessions.get(sid) ?? initial;
    const now = Date.now();

    if (path.startsWith('/__test/')) {
      let body: unknown;
      if (method === 'POST') {
        const raw = await readBody(req);
        if (raw.trim() !== '') {
          try {
            body = JSON.parse(raw);
          } catch {
            send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'invalid JSON' }), sidCookie);
            return;
          }
        }
      }
      const r = handleTestApi(
        { method, path, headers: req.headers as Record<string, string | undefined>, body },
        { testToken, state, now },
      );
      if (r.state !== undefined) sessions.set(sid, r.state);
      send(res, r.status, { 'content-type': 'application/json' }, JSON.stringify(r.body), sidCookie);
      return;
    }

    if (path === '/__act') {
      if (method !== 'POST') {
        send(res, 405, { allow: 'POST', 'content-type': 'text/plain' }, 'Method Not Allowed', sidCookie);
        return;
      }
      const form = new URLSearchParams(await readBody(req));
      const target = safeRoute(form.get('__route'));
      const action = form.get('__action');
      if (action !== null) {
        const fields: Record<string, string> = {};
        for (const [k, v] of form) if (!k.startsWith('__')) fields[k] = v;
        // A form post comes from the page it names; align the session with it so the post-redirect GET keeps flash messages.
        if (pathOf(target) !== state.lastPath) state = dispatch(state, { type: 'visit', route: target }, now).state;
        const out = dispatch(state, { type: 'action', action, fields }, now);
        sessions.set(sid, out.state);
        send(res, 303, { location: out.redirect ?? target }, '', sidCookie);
        return;
      }
      send(res, 303, { location: target }, '', sidCookie);
      return;
    }

    if (path === '/__redirect') {
      // Convenience for driver tests: a same-origin route that bounces to an arbitrary URL.
      const to = url.searchParams.get('to');
      if (to === null) {
        send(res, 400, { 'content-type': 'text/plain' }, 'missing "to"', sidCookie);
        return;
      }
      send(res, 302, { location: to }, '', sidCookie);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }, 'Method Not Allowed', sidCookie);
      return;
    }

    const effective = resolveRoute(state, route);
    if (effective !== route) {
      send(res, 302, { location: effective }, '', sidCookie);
      return;
    }
    state = dispatch(state, { type: 'visit', route }, now).state;
    sessions.set(sid, state);
    const known = ['/login', '/settings/billing', '/todos', '/forms/two', '/slow', '/notes'].includes(pathOf(route));
    send(
      res,
      known ? 200 : 404,
      { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
      method === 'HEAD' ? '' : renderPage(state, route, now),
      sidCookie,
    );
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
