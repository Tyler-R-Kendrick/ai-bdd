#!/usr/bin/env node
/**
 * The fixture web app: dependency-free, server-rendered HTML with minimal inline JS.
 *
 *   node fixtures/app/server.mjs --port 0
 *
 * Supports the screens of section 14.3 plus the test API:
 *   POST /__test/seed   { workspace, plan, unpaid }   (header x-test-token)
 *   POST /__test/reset  {}                            (header x-test-token)
 */
import { createServer } from 'node:http';
import { findScreen } from './screens.mjs';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg === -1 ? 0 : Number(args[portArg + 1] ?? 0);
const TEST_TOKEN = process.env.AI_BDD_TEST_TOKEN ?? 'ai-bdd-test';

const state = { workspace: null, plan: 'free', unpaid: 0, dialog: null, signedIn: false, user: 'admin', toast: null, loading: false };
const visits = new Map();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function interpolate(template, extra = {}) {
  return template.replace(/\{\{(\w+)\}\}/gu, (_all, key) => {
    if (key === 'planLabel') return state.plan === 'pro' ? 'Pro plan' : 'Free plan';
    if (key === 'workspaceLabel') return state.workspace ?? 'none';
    if (key === 'prorated') return '12.00';
    return String(extra[key] ?? state[key] ?? '');
  });
}

function isVisible(node) {
  if (!node.visibleWhen) return true;
  const [key, expected] = String(node.visibleWhen).split(':');
  if (key === 'plan') return state.plan === expected;
  if (key === 'toast') return state.toast === expected;
  if (key === 'blocked') return state.unpaid > 0;
  if (key === 'loading') return state.loading || visits.get('slow') === 1;
  if (key === 'loaded') return !state.loading && (visits.get('slow') ?? 0) > 1;
  return Boolean(state[key]);
}

function renderNode(node) {
  const name = escapeHtml(interpolate(node.name));
  const testId = node.testId ? ` data-testid="${escapeHtml(node.testId)}"` : '';
  switch (node.role) {
    case 'heading':
      return `<h1${testId}>${name}</h1>`;
    case 'button':
      return `<button type="button"${testId} data-action="${escapeHtml(node.testId ?? name)}">${name}</button>`;
    case 'textbox':
      return `<label>${name}<input${testId} type="${node.secret ? 'password' : 'text'}" name="${escapeHtml(node.testId ?? 'field')}" /></label>`;
    case 'alert':
      return `<div role="alert"${testId}>${name}</div>`;
    case 'dialog':
      return `<div role="dialog" aria-label="${name}"${testId}>`;
    case 'form':
      return `<form aria-label="${name}"${testId}>`;
    default:
      return `<p${testId}>${name}</p>`;
  }
}

function renderPage(route, query) {
  const screen = findScreen(route);
  if (!screen) return { status: 404, html: '<h1>Not found</h1>' };

  if (route === '/slow') {
    const ms = Number(query.get('ms') ?? screen.spinnerMs ?? 0);
    const count = (visits.get('slow') ?? 0) + 1;
    visits.set('slow', count);
    state.loading = count === 1 && ms >= 1000;
  }
  if (query.has('unpaid')) state.unpaid = Number(query.get('unpaid'));
  if (query.has('plan')) state.plan = String(query.get('plan'));
  if (query.has('toast')) state.toast = String(query.get('toast'));
  if (query.has('now')) state.now = String(query.get('now'));
  state.dialog = query.get('dialog');
  const extra = { now: state.now ?? new Date().toISOString(), toast: state.toast ?? '' };

  const parts = [`<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(screen.title)}</title></head><body>`];
  parts.push(`<main data-route="${escapeHtml(route)}">`);
  for (const node of screen.nodes) {
    if (!isVisible(node)) continue;
    parts.push(renderNode({ ...node, name: interpolate(node.name, extra) }));
    if (node.role === 'dialog') parts.push('</div>');
    if (node.role === 'form') parts.push('</form>');
  }
  if (state.dialog && screen.dialogs?.[state.dialog]) {
    for (const node of screen.dialogs[state.dialog]) {
      parts.push(renderNode({ ...node, name: interpolate(node.name, extra) }));
      if (node.role === 'dialog') parts.push('</div>');
    }
  }
  parts.push('</main>');
  parts.push('<script>document.addEventListener("click", (event) => { const target = event.target.closest("[data-action]"); if (!target) return; fetch("/__test/visit", { method: "POST", body: JSON.stringify({ action: target.dataset.action }) }); });</script>');
  parts.push('</body></html>');
  return { status: 200, html: parts.join('') };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const token = request.headers['x-test-token'];

  if (url.pathname === '/__test/seed' && request.method === 'POST') {
    if (token !== TEST_TOKEN) return send(response, 403, '<h1>forbidden</h1>');
    return collect(request, (body) => {
      if (typeof body.workspace === 'string') state.workspace = body.workspace;
      if (typeof body.plan === 'string') state.plan = body.plan;
      if (typeof body.unpaid === 'number') state.unpaid = body.unpaid;
      send(response, 200, JSON.stringify({ ok: true, state }), 'application/json');
    });
  }
  if (url.pathname === '/__test/reset' && request.method === 'POST') {
    if (token !== TEST_TOKEN) return send(response, 403, '<h1>forbidden</h1>');
    Object.assign(state, { workspace: null, plan: 'free', unpaid: 0, dialog: null, signedIn: false, toast: null, loading: false });
    visits.clear();
    return send(response, 200, JSON.stringify({ ok: true }), 'application/json');
  }
  if (url.pathname === '/__test/visit' && request.method === 'POST') {
    return collect(request, (body) => {
      const action = String(body.action ?? '');
      if (action === 'upgrade') state.plan = 'pro';
      if (action === 'downgrade') state.plan = state.unpaid > 0 ? state.plan : 'free';
      if (action === 'confirmUpgrade') state.plan = 'pro';
      if (action === 'cancelUpgrade') state.dialog = null;
      if (action === 'signIn') state.signedIn = true;
      send(response, 200, JSON.stringify({ ok: true, state }), 'application/json');
    });
  }
  if (url.pathname === '/__test/state') {
    return send(response, 200, JSON.stringify({ state, visits: Object.fromEntries(visits) }), 'application/json');
  }
  if (url.pathname === '/__health') return send(response, 200, JSON.stringify({ ok: true }), 'application/json');
  if (url.pathname === '/dashboard') {
    const { html, status } = renderPage('/dashboard', url.searchParams);
    return send(response, status, html);
  }
  const { status, html } = renderPage(url.pathname, url.searchParams);
  return send(response, status, html);
});

function send(response, status, body, type = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function collect(request, handle) {
  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    try {
      handle(raw.length > 0 ? JSON.parse(raw) : {});
    } catch {
      handle({});
    }
  });
}

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: typeof address === 'object' && address ? address.port : port })}\n`);
});
