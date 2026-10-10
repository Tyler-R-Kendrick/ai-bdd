import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Extra HTTP routes for the session edge-case tests: redirects with chosen status codes, content types, a document that
 * never answers, and a few small pages. Separate from fixture.ts, which mirrors the Acme app.
 */
export interface EdgeServer {
  url: string;
  /** Requests received, as `METHOD path`. */
  hits: string[];
  close(): Promise<void>;
}

const wrap = (body: string, head = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Edge</title>${head}</head><body>${body}</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c: Buffer) => { b += c.toString('utf8'); });
    req.on('end', () => resolve(b));
  });
}

export async function startEdgeServer(): Promise<EdgeServer> {
  const hits: string[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.push(`${req.method ?? 'GET'} ${url.pathname}`);
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const html = (body: string, head = ''): void => send(200, 'text/html; charset=utf-8', wrap(body, head));
    const q = (name: string): string => url.searchParams.get(name) ?? '';

    switch (url.pathname) {
      case '/hang':
        return; // never answers; the test closes the connection
      case '/api/echo': {
        const body = await readBody(req);
        return send(200, 'application/json', JSON.stringify({ method: req.method, contentType: req.headers['content-type'] ?? null, body }));
      }
      case '/r':
        return send(Number(q('status')), 'text/plain', 'redirecting', { location: q('to') });
      case '/nolocation':
        return send(302, 'text/plain', 'stay here');
      case '/loop':
        return send(302, 'text/plain', 'again', { location: '/loop' });
      case '/chain': {
        const n = Number(q('n'));
        return n > 0 ? send(302, 'text/plain', 'next', { location: `/chain?n=${n - 1}` }) : send(200, 'text/plain', 'end of chain');
      }
      case '/text':
        return send(200, 'text/plain', 'plain text');
      case '/badjson':
        return send(200, 'application/json', 'not json {');
      case '/jsonish':
        return send(200, 'application/problem+json; charset=utf-8', '{"problem":true}');
      case '/viewport':
        return html('<h1 id="v">pending</h1><script>document.getElementById("v").textContent = innerWidth + "x" + innerHeight;</script>');
      case '/mixed':
        return html(`<h1>Mixed</h1><p id="out" role="status">idle</p>
<div onmouseover="document.getElementById('out').textContent='hover-text'">Lonely <input type="checkbox" aria-label="c"></div>
<div role="progressbar"></div>`);
      case '/secret-select':
        return html(`<h1>Pick</h1><select aria-label="Token"><option value="">none</option><option value="sekret-value-1">sekret-value-1</option></select>
<p>Chosen: <span id="chosen">nothing</span></p>
<script>document.querySelector('select').onchange = function () { document.getElementById('chosen').textContent = this.value; };</script>`);
      case '/blob':
        return html(`<h1>Blob</h1><button onclick="location.href = URL.createObjectURL(new Blob(['<h1>from blob</h1>'], { type: 'text/html' }))">Go blob</button>`);
      case '/frames':
        return html(`<h1>Frames</h1><iframe title="inner" src="${q('src')}"></iframe>`);
      case '/popup-next':
        return html('<h1>Popup next</h1>', `<script>setTimeout(function () { location.href = ${JSON.stringify(q('to'))}; }, 50);</script>`);
      case '/open':
        return html(`<h1>Open</h1><button id="open" onclick="window.open(${JSON.stringify(q('to'))})">Open window</button>`);
      case '/plain':
        return html('<h1>Plain</h1><button>Press me</button>');
      default:
        return send(404, 'text/plain', 'not found');
    }
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    hits,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
