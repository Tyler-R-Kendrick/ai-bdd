// A tiny hostile web site on 127.0.0.1. The same server answers for `localhost:<port>` (allowed by policy) and
// `evil.localhost:<port>` (never allowed). Chromium resolves *.localhost to loopback, so the "evil" origin is reachable
// without a network: any request whose Host header is evil.* proves the browser left the allow-list.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HostileSite {
  port: number;
  /** http://localhost:<port> */
  origin: string;
  /** http://evil.localhost:<port> */
  evil: string;
  /** Hosts of every request that reached the server, in order. */
  hits: { host: string; path: string; method: string }[];
  evilHits(): { host: string; path: string; method: string }[];
  reset(): void;
  close(): Promise<void>;
}

const page = (title: string, body: string, head = ''): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

export async function startHostileSite(): Promise<HostileSite> {
  const hits: HostileSite['hits'] = [];
  let port = 0;
  const evilUrl = (path = '/steal'): string => `http://evil.localhost:${port}${path}`;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const host = String(req.headers.host ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push({ host, path: url.pathname + url.search, method: req.method ?? 'GET' });
    const html = (s: string, status = 200): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(s);
    };
    const redirect = (to: string, status = 302): void => {
      res.writeHead(status, { location: to });
      res.end();
    };
    if (host.startsWith('evil.')) return html(page('EVIL', '<p>you should never see this</p>'));
    switch (url.pathname) {
      case '/ok':
        return html(page('Safe page', '<p>fine</p><a href="/ok2">Next</a>'));
      case '/ok2':
        return html(page('Second safe page', '<p>fine too</p>'));
      case '/set-state': {
        const v = url.searchParams.get('v') ?? 'x';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `leak=${encodeURIComponent(v)}; Path=/` });
        res.end(page('State set', `<p>cookie and storage written</p>`, `<script>localStorage.setItem('leak', ${JSON.stringify(v)}); sessionStorage.setItem('leak', ${JSON.stringify(v)});</script>`));
        return;
      }
      case '/get-state':
        return html(page('State read', '<p id="out">pending</p>', `<script>addEventListener('DOMContentLoaded', function(){ document.title = 'State read'; var h = document.createElement('h2'); h.textContent = 'cookie=[' + document.cookie + '] local=[' + (localStorage.getItem('leak') || '') + '] session=[' + (sessionStorage.getItem('leak') || '') + ']'; document.querySelector('main').appendChild(h); });</script>`));
      case '/swap': {
        const swapped = url.searchParams.get('s') === '1';
        const buttons = [['A', 'Alpha'], ['B', 'Beta']].map(([id, label]) => `<form method="get" action="/click"><input type="hidden" name="b" value="${id}"><button type="submit">${label}</button></form>`);
        return html(page('Swap', (swapped ? buttons.reverse() : buttons).join('')));
      }
      case '/click':
        return redirect('/swap?s=1&clicked=' + (url.searchParams.get('b') ?? ''), 303);
      case '/spa-list':
        return html(page('List', `<ul><li>one <button onclick="this.parentNode.remove()">Delete</button></li><li>two <button onclick="fetch('/mark?item=two')">Delete</button></li><li>three <button onclick="fetch('/mark?item=three')">Delete</button></li></ul>`));
      case '/mark':
        res.writeHead(204);
        res.end();
        return;
      case '/redirect302':
        return redirect(url.searchParams.get('to') ?? evilUrl());
      case '/redirect-chain':
        return redirect('/redirect302?to=' + encodeURIComponent(evilUrl()), 301);
      case '/redirect-307':
        return redirect(evilUrl(), 307);
      case '/meta':
        return html(page('Meta refresh', '<p>redirecting</p>', `<meta http-equiv="refresh" content="0;url=${evilUrl()}">`));
      case '/timer':
        return html(page('Timer', '<p>soon</p>', `<script>setTimeout(function(){ location.href = ${JSON.stringify(evilUrl())}; }, 200);</script>`));
      case '/open':
        return html(page('Popup', `<button onclick="window.open(${JSON.stringify(evilUrl())})">Open popup</button>`));
      case '/open-named':
        return html(page('Named popup', `<button onclick="window.open('about:blank','w'); setTimeout(function(){ window.open(${JSON.stringify(evilUrl())}, 'w'); }, 50)">Open named popup</button>`));
      case '/blank-link':
        return html(page('Blank link', `<a target="_blank" rel="noopener" href="${evilUrl()}">Evil blank link</a>`));
      case '/js-link':
        return html(page('JS link', `<a href="javascript:location.href=${JSON.stringify(evilUrl())}">Evil script link</a>`));
      case '/data-link':
        return html(page('Data link', '<a href="data:text/html,<h1>DATA</h1>">Data link</a>'));
      case '/file-link':
        return html(page('File link', '<a href="file:///etc/passwd">File link</a>'));
      case '/form':
        return html(page('Form', `<form method="post" action="${evilUrl('/post')}"><button type="submit">Send</button></form>`));
      case '/evil-link':
        return html(page('Evil link', `<a href="${evilUrl()}">Evil link</a>`));
      case '/creds-link':
        return html(page('Creds link', `<a href="http://user:pw@localhost:${port}/ok">Credentials link</a>`));
      case '/upper-link':
        return html(page('Upper link', `<a href="http://EVIL.LOCALHOST:${port}/steal">Upper link</a>`));
      case '/dot-link':
        return html(page('Dot link', `<a href="http://localhost.:${port}/ok">Trailing dot link</a>`));
      case '/iframe':
        return html(page('Iframe', `<iframe title="Evil frame" src="${evilUrl()}"></iframe>`));
      case '/idn-link':
        return html(page('IDN link', `<a href="http://lоcalhost:${port}/ok">Cyrillic localhost link</a>`));
      default:
        return html(page('Index', '<p>index</p>'), 404);
    }
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://localhost:${port}`,
    evil: `http://evil.localhost:${port}`,
    hits,
    evilHits: () => hits.filter((h) => h.host.startsWith('evil.')),
    reset: () => {
      hits.length = 0;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
