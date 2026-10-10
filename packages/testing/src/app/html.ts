import { isLoading, pathOf, slowDurationMs, syncText, view, SYNC_PERIOD_MS, type AcmeState, type UINode } from './model.ts';

/**
 * Semantic HTML renderer for the Acme `UINode` tree (SPEC 13.1).
 * Everything the accessibility tree needs is expressed with native elements or explicit ARIA.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const attr = (name: string, value: string): string => ` ${name}="${escapeHtml(value)}"`;

function stateAttrs(node: UINode): string {
  const s = node.states;
  if (s === undefined) return '';
  let out = '';
  if (s.disabled === true) out += ' disabled';
  if (s.expanded !== undefined) out += attr('aria-expanded', String(s.expanded));
  if (s.checked !== undefined) out += attr('aria-checked', String(s.checked));
  if (s.selected !== undefined) out += attr('aria-selected', String(s.selected));
  if (s.pressed !== undefined) out += attr('aria-pressed', String(s.pressed));
  if (s.invalid === true) out += attr('aria-invalid', 'true');
  return out;
}

function renderChildren(nodes: readonly UINode[] | undefined): string {
  return (nodes ?? []).map(renderNode).join('');
}

/** Renders the children of `<main>` inside the single page form. */
function renderMainInner(node: UINode, route: string): string {
  return `<form method="post" action="/__act"><input type="hidden" name="__route"${attr('value', route)}>${renderChildren(node.children)}</form>`;
}

function renderNode(node: UINode): string {
  const inner = (): string => (node.children === undefined || node.children.length === 0 ? escapeHtml(node.name) : renderChildren(node.children));
  switch (node.role) {
    case 'navigation':
      return `<nav${attr('aria-label', node.name)}>${renderChildren(node.children)}</nav>`;
    case 'link':
      return `<a${attr('href', node.href ?? '#')}>${escapeHtml(node.name)}</a>`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, node.level ?? 1));
      return `<h${level}>${escapeHtml(node.name)}</h${level}>`;
    }
    case 'textbox': {
      const type = node.states?.secret === true ? 'password' : 'text';
      const value = node.value === undefined || node.value === '' ? '' : attr('value', node.value);
      return `<input type="${type}"${attr('aria-label', node.name)}${attr('name', node.field ?? '')}${value} autocomplete="off"${stateAttrs(node)}>`;
    }
    case 'button':
      return node.action === undefined
        ? `<button type="button"${stateAttrs(node)}>${escapeHtml(node.name)}</button>`
        : `<button type="submit" name="__action"${attr('value', node.action)}${stateAttrs(node)}>${escapeHtml(node.name)}</button>`;
    case 'region':
      return `<section${attr('aria-label', node.name)}>${renderChildren(node.children)}</section>`;
    case 'status':
      return `<p role="status">${escapeHtml(node.name)}</p>`;
    case 'alert':
      return `<p role="alert">${escapeHtml(node.name)}</p>`;
    case 'paragraph':
      return `<p>${escapeHtml(node.name)}</p>`;
    case 'dialog':
      return `<div role="dialog"${attr('aria-label', node.name)}>${renderChildren(node.children)}</div>`;
    case 'list':
      return `<ul${attr('aria-label', node.name)}>${renderChildren(node.children)}</ul>`;
    case 'listitem':
      return `<li>${escapeHtml(node.name)}</li>`;
    case 'progressbar':
      return `<div role="progressbar"${attr('aria-label', node.name)}></div>`;
    default:
      return `<div role="${escapeHtml(node.role)}"${attr('aria-label', node.name)}>${inner()}</div>`;
  }
}

/** Renders a node list (no document wrapper). `main` becomes `<main>` containing the page form. */
export function renderNodes(nodes: readonly UINode[], route: string): string {
  return nodes
    .map((node) =>
      node.role === 'main'
        ? `<main${node.states?.busy === true ? ' aria-busy="true"' : ''}>${renderMainInner(node, route)}</main>`
        : renderNode(node),
    )
    .join('\n');
}

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const SYNC_SCRIPT = `(function(){
function p(n,w){n=String(n);while(n.length<(w||2))n='0'+n;return n}
var el=document.getElementById('sync');
setInterval(function(){
var t=Math.floor(Date.now()/${SYNC_PERIOD_MS})*${SYNC_PERIOD_MS};var d=new Date(t);
el.textContent='Synced at '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+'.'+p(d.getUTCMilliseconds(),3);
},100);
})();`;

/** A complete HTML document for `route` as seen by `state` at `now`. */
export function renderPage(state: AcmeState, route: string, now: number): string {
  const nodes = view(state, route, now);
  const path = pathOf(route);
  let body = renderNodes(nodes, route);
  const scripts: string[] = [];

  if (path === '/slow' && isLoading(nodes)) {
    const started = state.slowStartedAt ?? now;
    const doneAt = started + slowDurationMs(route);
    const doneMain = view(state, route, doneAt).find((x) => x.role === 'main');
    if (doneMain !== undefined) {
      const delay = Math.max(0, doneAt - now);
      scripts.push(
        `(function(){var html=${jsString(renderMainInner(doneMain, route))};setTimeout(function(){var m=document.querySelector('main');m.innerHTML=html;m.removeAttribute('aria-busy');},${delay});})();`,
      );
    }
  }
  if (path === '/todos') {
    // Mark the sync status so the clock script can find it (id does not affect the accessible tree).
    const text = escapeHtml(syncText(now));
    body = body.replace(`<p role="status">${text}</p>`, `<p role="status" id="sync">${text}</p>`);
    scripts.push(SYNC_SCRIPT);
  }

  const script = scripts.length === 0 ? '' : `\n<script>${scripts.join('\n')}</script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acme</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem;max-width:40rem}nav a{margin-right:1rem}section{margin:1rem 0;padding:.5rem;border:1px solid #ccc}</style>
</head>
<body>
${body}${script}
</body>
</html>
`;
}
