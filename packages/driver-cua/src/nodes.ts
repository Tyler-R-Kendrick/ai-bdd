import type { NodeStates, ObservedNode } from '@ai-bdd/sdk/contracts';

/**
 * One row of `get_window_state`'s `structuredContent.elements` (the fields ai-bdd uses). The driver reports the platform's
 * accessibility tree: AT-SPI role names on Linux (`push button`, `entry`, `check box`), their UIA / AX counterparts elsewhere.
 */
export interface CuaElement {
  element_index: number;
  element_token: string;
  role: string;
  label?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
  focused?: boolean;
  parent_index?: number;
  in_web_content?: boolean;
  actions?: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Read the `elements` array defensively: a row without an index, token and role is not addressable and is skipped. */
export function parseElements(structured: Record<string, unknown>): CuaElement[] {
  const rows = structured['elements'];
  if (!Array.isArray(rows)) return [];
  const out: CuaElement[] = [];
  for (const row of rows as unknown[]) {
    if (!isRecord(row)) continue;
    const index = row['element_index'];
    const token = str(row['element_token']);
    const role = str(row['role']);
    if (typeof index !== 'number' || !Number.isInteger(index) || token === undefined || role === undefined) continue;
    const el: CuaElement = { element_index: index, element_token: token, role };
    const set = <K extends keyof CuaElement>(key: K, value: CuaElement[K] | undefined): void => {
      if (value !== undefined) el[key] = value;
    };
    set('label', str(row['label']));
    set('value', str(row['value']));
    set('description', str(row['description']));
    set('enabled', bool(row['enabled']));
    set('selected', bool(row['selected']));
    set('checked', bool(row['checked']));
    set('expanded', bool(row['expanded']));
    set('focused', bool(row['focused']));
    set('in_web_content', bool(row['in_web_content']));
    if (typeof row['parent_index'] === 'number') el.parent_index = row['parent_index'];
    if (Array.isArray(row['actions'])) el.actions = (row['actions'] as unknown[]).filter((a): a is string => typeof a === 'string');
    out.push(el);
  }
  return out.sort((a, b) => a.element_index - b.element_index);
}

/** AT-SPI (and UIA / AX style) role names -> the ARIA-ish roles ai-bdd selectors and prompts use. */
const ROLE_MAP: Record<string, string> = {
  'push button': 'button', 'toggle button': 'button', button: 'button', 'check box': 'checkbox', checkbox: 'checkbox',
  'radio button': 'radio', radio: 'radio', 'check menu item': 'menuitemcheckbox', 'radio menu item': 'menuitemradio',
  entry: 'textbox', text: 'textbox', 'password text': 'textbox', edit: 'textbox', 'text field': 'textbox', 'text box': 'textbox',
  'text entry': 'textbox', 'search box': 'searchbox', 'spin button': 'spinbutton', slider: 'slider', switch: 'switch',
  'combo box': 'combobox', combobox: 'combobox', 'list box': 'listbox', list: 'list', 'list item': 'listitem', option: 'option',
  link: 'link', heading: 'heading', paragraph: 'paragraph', label: 'text', static: 'text', 'static text': 'text', caption: 'text',
  image: 'img', icon: 'img', 'progress bar': 'progressbar', separator: 'separator', 'scroll bar': 'scrollbar',
  menu: 'menu', 'menu bar': 'menubar', 'menu item': 'menuitem', 'popup menu': 'menu', 'tool bar': 'toolbar', toolbar: 'toolbar',
  'tool tip': 'tooltip', 'page tab': 'tab', 'page tab list': 'tablist', tab: 'tab', 'tab list': 'tablist',
  table: 'table', 'table row': 'row', 'table cell': 'cell', 'table column header': 'columnheader', 'table row header': 'rowheader',
  'column header': 'columnheader', 'row header': 'rowheader', tree: 'tree', 'tree item': 'treeitem', 'tree table': 'treegrid',
  dialog: 'dialog', alert: 'alert', 'status bar': 'status', form: 'form', 'document web': 'document', 'document frame': 'document',
  document: 'document', frame: 'window', window: 'window', 'application': 'application', article: 'article', landmark: 'region',
  grouping: 'group', group: 'group', 'list-item': 'listitem',
  // layout containers: no meaning of their own
  panel: 'generic', section: 'generic', filler: 'generic', 'scroll pane': 'generic', 'split pane': 'generic', viewport: 'generic',
  'layered pane': 'generic', 'root pane': 'generic', 'glass pane': 'generic', canvas: 'generic', 'redundant object': 'generic',
  unknown: 'generic', pane: 'generic', custom: 'generic',
};

/** Platforms spell the same role `push button`, `push-button`, `pushbutton` or `PushButton`: look roles up without separators or case. */
const compact = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
const ROLE_LOOKUP = new Map(Object.entries(ROLE_MAP).map(([k, v]) => [compact(k), v] as const));

export function ariaRole(raw: string): string {
  const mapped = ROLE_LOOKUP.get(compact(raw));
  if (mapped !== undefined) return mapped;
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'generic';
}

/** Roles worth keeping even without a name: they carry structure or are operable. */
const KEEP_UNNAMED = new Set([
  'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'spinbutton', 'slider', 'switch', 'combobox', 'listbox', 'list', 'listitem',
  'option', 'link', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'toolbar', 'tab', 'tablist', 'table', 'row',
  'cell', 'columnheader', 'rowheader', 'tree', 'treeitem', 'treegrid', 'dialog', 'alert', 'status', 'form', 'document', 'window',
  'progressbar', 'separator', 'scrollbar', 'tooltip',
]);

/** Object replacement characters stand in for embedded children in AT-SPI labels; they are not text. */
const OBJECT_REPLACEMENT = /￼/g;
const LIST_MARKER = /^(?:[•◦▪‣]\s*)+/;

export function cleanLabel(raw: string | undefined, role: string): string {
  if (raw === undefined) return '';
  let text = raw.replace(OBJECT_REPLACEMENT, '').replace(/\s+/g, ' ').trim();
  if (role === 'listitem') text = text.replace(LIST_MARKER, '');
  return text;
}

const CHECKABLE = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const SELECTABLE = new Set(['tab', 'option', 'treeitem', 'row', 'cell', 'menuitem', 'listitem']);

export interface BuildOptions {
  /** `content`: only the web content of a browser window (no tabs, address bar or infobars). `window`: everything. */
  scope: 'content' | 'window';
  /** Literal secret values to scrub from names and values. */
  secrets: Iterable<string>;
  minSecretLength?: number;
}

export interface BuiltNodes {
  nodes: ObservedNode[];
  /** ref -> the element handle of THIS snapshot (stale once the next `get_window_state` replaces it). */
  tokens: Map<string, string>;
  /** ref -> current checked state, for check boxes, radios and switches. */
  checked: Map<string, boolean>;
  busy: boolean;
}

/**
 * Turn a snapshot's element rows into ai-bdd's observation nodes: ARIA roles, cleaned names, states, secrets removed,
 * unnamed layout containers pruned (their children move up). Refs are `r<revision>:e<element_index>`.
 */
export function buildNodes(elements: readonly CuaElement[], revision: number, opts: BuildOptions): BuiltNodes {
  // longest first: a secret that contains another one ("alice" / "alice123") must be replaced whole, not in pieces
  const secrets = [...new Set(opts.secrets)].filter((s) => s.length >= (opts.minSecretLength ?? 4)).sort((a, b) => b.length - a.length);
  const scrub = (text: string): string => {
    let out = text;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join('[secret]');
    return out;
  };

  const included = opts.scope === 'content' ? elements.filter((e) => e.in_web_content === true) : [...elements];
  const byIndex = new Map(elements.map((e) => [e.element_index, e]));
  const keptRefOf = new Map<number, string>();
  const nodes: ObservedNode[] = [];
  const tokens = new Map<string, string>();
  const checked = new Map<string, boolean>();
  let busy = false;
  const depthOf = new Map<number, number>();

  const keptAncestor = (index: number): number | undefined => {
    let cur = byIndex.get(index)?.parent_index;
    for (let hops = 0; cur !== undefined && hops < 10_000; hops += 1) {
      if (keptRefOf.has(cur)) return cur;
      cur = byIndex.get(cur)?.parent_index;
    }
    return undefined;
  };

  for (const el of included) {
    const role = ariaRole(el.role);
    const isPassword = compact(el.role) === 'passwordtext';
    // For an empty off-screen node the driver repeats its "scroll it into view" note as the label: a description is not a name.
    const name = scrub(cleanLabel(el.label !== undefined && el.label === el.description ? undefined : el.label, role));
    const rawValue = isPassword || el.value === undefined || el.value.length === 0 ? undefined : scrub(el.value);
    if (role === 'progressbar') busy = true;
    if (name === '' && rawValue === undefined && !KEEP_UNNAMED.has(role)) continue;

    const ref = `r${revision}:e${el.element_index}`;
    const parentIndex = keptAncestor(el.element_index);
    const states: NodeStates = {};
    if (el.enabled === false) states.disabled = true;
    if (CHECKABLE.has(role)) {
      const on = el.checked ?? el.selected;
      if (on !== undefined) {
        states.checked = on;
        checked.set(ref, on);
      }
    } else if (el.selected === true && SELECTABLE.has(role)) states.selected = true;
    if (el.expanded !== undefined) states.expanded = el.expanded;
    if (el.focused === true) states.focused = true;

    const depth = parentIndex === undefined ? 0 : (depthOf.get(parentIndex) ?? 0) + 1;
    const node: ObservedNode = { ref, role, name, states, depth };
    if (rawValue !== undefined) node.value = rawValue;
    if (parentIndex !== undefined) node.parentRef = keptRefOf.get(parentIndex) as string;
    nodes.push(node);
    keptRefOf.set(el.element_index, ref);
    depthOf.set(el.element_index, depth);
    tokens.set(ref, el.element_token);
  }
  return { nodes, tokens, checked, busy };
}

/** Live regions announce changing text; their text must not decide whether the screen has settled. */
const LIVE_ROLES = new Set(['status', 'timer', 'log', 'marquee']);

/**
 * The hash the settler compares between observations. A walk of the accessibility tree takes about a second, far longer than
 * a clock or a "last synced" indicator holds one value, so the text of live regions is left out (their presence and role still
 * count). The nodes themselves, which checks and the judge read, keep their text.
 */
export function settleHash<H>(nodes: readonly ObservedNode[], hash: (nodes: readonly ObservedNode[]) => H): H {
  return hash(nodes.map((n) => {
    if (!LIVE_ROLES.has(n.role)) return n;
    const { value: _value, text: _text, ...rest } = n;
    return { ...rest, name: '' };
  }));
}
