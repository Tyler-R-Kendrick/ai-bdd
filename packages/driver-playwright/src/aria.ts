import type { NodeStates, ObservedNode } from '@ai-bdd/sdk/contracts';

/**
 * Parser for the YAML-like text returned by `page.ariaSnapshot({ mode: 'ai' })` (Playwright 1.64).
 *
 * Observed grammar (V3/V4, pinned by goldens in test/aria.test.ts):
 *
 *   line      := indent '- ' body
 *   indent    := two spaces per nesting level
 *   body      := key | key ':' | key ': ' value | '/' prop ': ' value
 *   key       := role [ ' ' JSON-string-name ] { ' ' attr }          (single-quoted whole when it needs YAML quoting)
 *   attr      := '[' name [ '=' value ] ']'
 *   value     := plain scalar | JSON-like double-quoted string | single-quoted string
 *
 * Attributes: checked(=mixed), disabled, expanded, active, invalid(=grammar|spelling), level=N, pressed(=mixed),
 * selected, aria-hidden, ref=<id>, cursor=pointer, box=x,y,w,h. Property lines `- /url: ...` and
 * `- /placeholder: ...` belong to the enclosing node. `- text: ...` lines are text nodes.
 */

const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider', 'combobox']);
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
/** Roles whose accessible name comes from their content; Playwright elides the name when it equals the child text. */
const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'option', 'checkbox', 'radio', 'switch']);
const INLINE_ROLES = new Set(['text', 'generic', 'emphasis', 'strong', 'code', 'deletion', 'insertion', 'subscript', 'superscript', 'mark', 'time']);

export interface ParsedLine { depth: number; key: string; value: string | undefined; hasColon: boolean }

/** Decode a double-quoted YAML scalar as emitted by Playwright (\\ \" \b \f \n \r \t \xNN \uNNNN). */
function decodeDoubleQuoted(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charAt(i);
    if (c !== '\\') { out += c; continue; }
    i += 1;
    const e = raw.charAt(i);
    switch (e) {
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'x': out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; break;
      default: out += e;
    }
  }
  return out;
}

/** Index just past the closing double quote of a string that starts at `start`, or -1. */
function endOfDoubleQuoted(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i += 1) {
    const c = s.charAt(i);
    if (c === '\\') i += 1;
    else if (c === '"') return i + 1;
  }
  return -1;
}

function parseScalar(raw: string): string {
  if (raw.startsWith('"')) {
    const end = endOfDoubleQuoted(raw, 0);
    if (end === raw.length) return decodeDoubleQuoted(raw.slice(1, end - 1));
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** Split `body` (the text after `- `) into key and optional inline value. */
function splitBody(body: string): { key: string; value: string | undefined; hasColon: boolean } {
  if (body.startsWith("'")) {
    // Whole key is single-quoted with '' as the escape for a quote.
    let i = 1;
    for (; i < body.length; i += 1) {
      if (body.charAt(i) === "'") {
        if (body.charAt(i + 1) === "'") i += 1;
        else break;
      }
    }
    const key = body.slice(1, i).replace(/''/g, "'");
    const rest = body.slice(i + 1);
    if (rest.startsWith(':')) {
      const v = rest.slice(1);
      return { key, value: v.startsWith(' ') ? parseScalar(v.slice(1)) : undefined, hasColon: true };
    }
    return { key, value: undefined, hasColon: false };
  }
  // Unquoted key: it never contains ':' followed by whitespace or end of line (those force quoting).
  for (let i = 0; i < body.length; i += 1) {
    if (body.charAt(i) !== ':') continue;
    const next = body.charAt(i + 1);
    if (next === '' || next === ' ') {
      return { key: body.slice(0, i), value: next === ' ' ? parseScalar(body.slice(i + 2)) : undefined, hasColon: true };
    }
  }
  return { key: body, value: undefined, hasColon: false };
}

export function tokenizeLines(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of text.split('\n')) {
    const m = /^( *)- (.*)$/.exec(line.replace(/\r$/, ''));
    if (m === null) continue;
    const indent = m[1] ?? '';
    const { key, value, hasColon } = splitBody(m[2] ?? '');
    out.push({ depth: Math.floor(indent.length / 2), key, value, hasColon });
  }
  return out;
}

interface KeyParts { role: string; name: string; attrs: Map<string, string | true> }

function parseKey(key: string): KeyParts {
  const attrs = new Map<string, string | true>();
  let i = 0;
  while (i < key.length && key.charAt(i) !== ' ') i += 1;
  const role = key.slice(0, i);
  let name = '';
  while (i < key.length) {
    while (key.charAt(i) === ' ') i += 1;
    if (i >= key.length) break;
    if (key.charAt(i) === '"') {
      const end = endOfDoubleQuoted(key, i);
      if (end < 0) break;
      try {
        name = JSON.parse(key.slice(i, end)) as string;
      } catch {
        name = decodeDoubleQuoted(key.slice(i + 1, end - 1));
      }
      i = end;
    } else if (key.charAt(i) === '[') {
      const end = key.indexOf(']', i);
      if (end < 0) break;
      const inner = key.slice(i + 1, end);
      const eq = inner.indexOf('=');
      if (eq < 0) attrs.set(inner, true);
      else attrs.set(inner.slice(0, eq), inner.slice(eq + 1));
      i = end + 1;
    } else {
      // Unknown token (for example a regex name): skip to the next space.
      while (i < key.length && key.charAt(i) !== ' ') i += 1;
    }
  }
  return { role, name, attrs };
}

function statesFrom(attrs: Map<string, string | true>): { states: NodeStates; level?: number } {
  const states: NodeStates = {};
  const checked = attrs.get('checked');
  if (checked === true) states.checked = true;
  else if (checked === 'mixed') states.checked = 'mixed';
  if (attrs.has('disabled')) states.disabled = true;
  if (attrs.has('expanded')) states.expanded = true;
  if (attrs.has('selected')) states.selected = true;
  const pressed = attrs.get('pressed');
  if (pressed === true) states.pressed = true;
  else if (pressed === 'mixed') states.pressed = 'mixed';
  if (attrs.has('active')) states.focused = true;
  if (attrs.has('invalid')) states.invalid = true;
  if (attrs.has('busy')) states.busy = true;
  const lv = attrs.get('level');
  const level = typeof lv === 'string' && /^\d+$/.test(lv) ? Number(lv) : undefined;
  return level === undefined ? { states } : { states, level };
}

/** Concatenated visible text under a node (text nodes and inline wrappers only). */
function joinedText(nodes: readonly ObservedNode[], index: number): string {
  const root = nodes[index];
  if (root === undefined) return '';
  const parts: string[] = [];
  for (let i = index + 1; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n === undefined || n.depth <= root.depth) break;
    if (n.role === 'text' && n.text !== undefined) parts.push(n.text);
    else if (INLINE_ROLES.has(n.role) && n.role !== 'generic' && n.text !== undefined) parts.push(n.text);
    else if (!INLINE_ROLES.has(n.role) && n.name.length > 0) parts.push(n.name);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse an AI-mode aria snapshot into a flat, document-ordered node list.
 * Nodes that carry `[ref=X]` get ref `X`; others (text nodes, hidden or non-box nodes) get `n<k>` where `k` is
 * their 1-based position in document order. Plain `generic` wrappers are kept (see `pruneWrappers`).
 */
export function parseAriaSnapshot(text: string): ObservedNode[] {
  const nodes: ObservedNode[] = [];
  const stack: { depth: number; index: number }[] = [];
  let counter = 0;
  for (const line of tokenizeLines(text)) {
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= line.depth) stack.pop();
    const parentEntry = stack[stack.length - 1];
    const parent = parentEntry === undefined ? undefined : nodes[parentEntry.index];

    if (line.key.startsWith('/')) {
      if (parent !== undefined && line.value !== undefined && line.key === '/url') parent.url = line.value;
      continue;
    }

    counter += 1;
    const depth = parent === undefined ? 0 : parent.depth + 1;
    let node: ObservedNode;
    if (line.key === 'text') {
      const t = line.value ?? '';
      node = { ref: `n${counter}`, role: 'text', name: t, text: t, states: {}, depth };
    } else {
      const { role, name, attrs } = parseKey(line.key);
      const { states, level } = statesFrom(attrs);
      const rawRef = attrs.get('ref');
      node = { ref: typeof rawRef === 'string' ? rawRef : `n${counter}`, role, name, states, depth };
      if (level !== undefined) node.level = level;
      const inline = line.value;
      if (inline !== undefined && inline.length > 0) {
        if (VALUE_ROLES.has(role)) node.value = inline;
        else {
          node.text = inline;
          if (node.name.length === 0) node.name = inline;
        }
      } else if (TEXT_INPUT_ROLES.has(role)) {
        node.value = '';
      }
    }
    if (parent !== undefined) node.parentRef = parent.ref;
    nodes.push(node);
    stack.push({ depth: line.depth, index: nodes.length - 1 });
  }

  // Second pass: derived names and values that need the subtree.
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n === undefined) continue;
    if (n.name.length === 0 && NAME_FROM_CONTENT.has(n.role)) {
      const joined = joinedText(nodes, i);
      if (joined.length > 0) n.name = joined;
    }
    if (n.role === 'combobox' && n.value === undefined) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const o = nodes[j];
        if (o === undefined || o.depth <= n.depth) break;
        if (o.role === 'option' && o.states.selected === true) { n.value = o.name; break; }
      }
    }
  }
  return nodes;
}

/**
 * Remove purely presentational wrappers: `generic` nodes with no name, text, value or url. Children are re-parented to the
 * nearest kept ancestor and depths are recomputed. Text-bearing generics (for example `generic: plain div text`) stay.
 */
export function pruneWrappers(nodes: readonly ObservedNode[]): ObservedNode[] {
  const isWrapper = (n: ObservedNode): boolean =>
    n.role === 'generic' && n.name.length === 0 && n.text === undefined && n.value === undefined && n.url === undefined;
  const byRef = new Map<string, ObservedNode>(nodes.map((n) => [n.ref, n]));
  const kept: ObservedNode[] = [];
  const keptRefs = new Set<string>();
  const nearestKept = (ref: string | undefined): ObservedNode | undefined => {
    let cur = ref === undefined ? undefined : byRef.get(ref);
    while (cur !== undefined && !keptRefs.has(cur.ref)) cur = cur.parentRef === undefined ? undefined : byRef.get(cur.parentRef);
    return cur;
  };
  const newDepth = new Map<string, number>();
  for (const n of nodes) {
    if (isWrapper(n)) continue;
    keptRefs.add(n.ref);
    const parent = nearestKept(n.parentRef);
    const copy: ObservedNode = { ...n, depth: parent === undefined ? 0 : (newDepth.get(parent.ref) ?? 0) + 1 };
    delete copy.parentRef;
    if (parent !== undefined) copy.parentRef = parent.ref;
    newDepth.set(n.ref, copy.depth);
    kept.push(copy);
  }
  return kept;
}
