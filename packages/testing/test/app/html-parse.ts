import type { UINode } from '../../src/app/index.ts';

/**
 * A tiny HTML parser plus accessibility mapping for the Acme pages. It is deliberately small:
 * the server only emits a handful of well-formed elements. It lets the parity tests run without a browser.
 */

export interface AxNode {
  role: string;
  name: string;
  level?: number;
  value?: string;
  url?: string;
  states: { checked?: boolean | 'mixed'; disabled?: boolean; expanded?: boolean };
  depth: number;
}

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

const VOID = new Set(['meta', 'input', 'link', 'br', 'hr', 'img']);
const RAW = new Set(['script', 'style']);

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)(?:="([^"]*)")?/g;
  for (const m of src.matchAll(re)) attrs[(m[1] ?? '').toLowerCase()] = unescapeHtml(m[2] ?? '');
  return attrs;
}

export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const top = stack[stack.length - 1] as El;
    if (m[4] !== undefined) {
      top.children.push(unescapeHtml(m[4]));
    } else if (m[2] !== undefined) {
      const tag = m[2].toLowerCase();
      if (m[1] === '/') {
        const at = stack.map((e) => e.tag).lastIndexOf(tag);
        if (at > 0) stack.length = at;
      } else {
        const el: El = { tag, attrs: parseAttrs(m[3] ?? ''), children: [] };
        top.children.push(el);
        if (RAW.has(tag)) {
          const end = html.toLowerCase().indexOf(`</${tag}>`, re.lastIndex);
          re.lastIndex = end < 0 ? html.length : end + tag.length + 3;
        } else if (!VOID.has(tag)) {
          stack.push(el);
        }
      }
    }
  }
  return root;
}

const textOf = (el: El | string): string => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function roleOf(el: El): { role: string; fromContent: boolean } | null {
  const explicit = el.attrs['role'];
  switch (el.tag) {
    case 'nav':
      return { role: 'navigation', fromContent: false };
    case 'a':
      return el.attrs['href'] === undefined ? null : { role: 'link', fromContent: true };
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return { role: 'heading', fromContent: true };
    case 'input':
      return el.attrs['type'] === 'hidden' ? null : { role: 'textbox', fromContent: false };
    case 'button':
      return { role: 'button', fromContent: true };
    case 'section':
      return el.attrs['aria-label'] === undefined ? null : { role: 'region', fromContent: false };
    case 'p':
      return explicit === 'status' || explicit === 'alert' ? { role: explicit, fromContent: true } : { role: 'paragraph', fromContent: true };
    case 'ul':
      return { role: 'list', fromContent: false };
    case 'li':
      return { role: 'listitem', fromContent: true };
    case 'main':
      return { role: 'main', fromContent: false };
    case 'div':
      return explicit === undefined ? null : { role: explicit, fromContent: false };
    default:
      return null;
  }
}

export function toAxNodes(html: string): AxNode[] {
  const out: AxNode[] = [];
  const walk = (el: El, depth: number): void => {
    if (['head', 'script', 'style', 'title'].includes(el.tag)) return;
    const r = roleOf(el);
    let childDepth = depth;
    if (r !== null) {
      const node: AxNode = {
        role: r.role,
        name: r.fromContent ? norm(textOf(el)) : norm(el.attrs['aria-label'] ?? ''),
        states: {},
        depth,
      };
      if (el.tag.length === 2 && el.tag.startsWith('h')) node.level = Number(el.tag.slice(1));
      if (r.role === 'textbox' && el.attrs['value'] !== undefined && el.attrs['value'] !== '') node.value = el.attrs['value'];
      if (el.tag === 'a') node.url = el.attrs['href'] ?? '';
      if ('disabled' in el.attrs) node.states.disabled = true;
      if (el.attrs['aria-expanded'] !== undefined) node.states.expanded = el.attrs['aria-expanded'] === 'true';
      if (el.attrs['aria-checked'] !== undefined) node.states.checked = el.attrs['aria-checked'] === 'mixed' ? 'mixed' : el.attrs['aria-checked'] === 'true';
      out.push(node);
      childDepth = depth + 1;
      if (r.fromContent) return; // name-from-content leaves expose no children of their own
    }
    for (const c of el.children) if (typeof c !== 'string') walk(c, childDepth);
  };
  walk(parseHtml(html), 0);
  return out;
}

/** The model's UINode tree in the same normalized shape (busy/secret markers dropped, empty value omitted). */
export function uiToAxNodes(nodes: readonly UINode[], depth = 0, out: AxNode[] = []): AxNode[] {
  for (const ui of nodes) {
    const node: AxNode = { role: ui.role, name: ui.name, states: {}, depth };
    if (ui.level !== undefined) node.level = ui.level;
    if (ui.value !== undefined && ui.value !== '' && ui.states?.secret !== true) node.value = ui.value;
    if (ui.href !== undefined) node.url = ui.href;
    if (ui.states?.disabled === true) node.states.disabled = true;
    if (ui.states?.expanded !== undefined) node.states.expanded = ui.states.expanded;
    if (ui.states?.checked !== undefined) node.states.checked = ui.states.checked;
    out.push(node);
    uiToAxNodes(ui.children ?? [], depth + 1, out);
  }
  return out;
}
