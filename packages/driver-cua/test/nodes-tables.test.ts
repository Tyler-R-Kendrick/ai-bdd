import { describe, expect, it } from 'vitest';
import { ariaRole, buildNodes, parseElements } from '../src/nodes.ts';
import { parseKey } from '../src/keys.ts';
import type { CuaElement } from '../src/nodes.ts';

// The role and key tables are the product's vocabulary for another platform. Each entry is pinned here on its own, so a typo, a
// dropped or an emptied entry is a failing test and not a silent change in what the agent sees.

/** AT-SPI (and UIA / AX style) role name -> ARIA role. */
const ROLES: [string, string][] = [
  ['push button', 'button'], ['toggle button', 'button'], ['button', 'button'], ['check box', 'checkbox'],
  ['checkbox', 'checkbox'], ['radio button', 'radio'], ['radio', 'radio'], ['check menu item', 'menuitemcheckbox'],
  ['radio menu item', 'menuitemradio'], ['entry', 'textbox'], ['text', 'textbox'], ['password text', 'textbox'],
  ['edit', 'textbox'], ['text field', 'textbox'], ['text box', 'textbox'], ['text entry', 'textbox'],
  ['search box', 'searchbox'], ['spin button', 'spinbutton'], ['slider', 'slider'], ['switch', 'switch'],
  ['combo box', 'combobox'], ['combobox', 'combobox'], ['list box', 'listbox'], ['list', 'list'], ['list item', 'listitem'],
  ['option', 'option'], ['link', 'link'], ['heading', 'heading'], ['paragraph', 'paragraph'], ['label', 'text'],
  ['static', 'text'], ['static text', 'text'], ['caption', 'text'], ['image', 'img'], ['icon', 'img'],
  ['progress bar', 'progressbar'], ['separator', 'separator'], ['scroll bar', 'scrollbar'], ['menu', 'menu'],
  ['menu bar', 'menubar'], ['menu item', 'menuitem'], ['popup menu', 'menu'], ['tool bar', 'toolbar'], ['toolbar', 'toolbar'],
  ['tool tip', 'tooltip'], ['page tab', 'tab'], ['page tab list', 'tablist'], ['tab', 'tab'], ['tab list', 'tablist'],
  ['table', 'table'], ['table row', 'row'], ['table cell', 'cell'], ['table column header', 'columnheader'],
  ['table row header', 'rowheader'], ['column header', 'columnheader'], ['row header', 'rowheader'], ['tree', 'tree'],
  ['tree item', 'treeitem'], ['tree table', 'treegrid'], ['dialog', 'dialog'], ['alert', 'alert'], ['status bar', 'status'],
  ['form', 'form'], ['document web', 'document'], ['document frame', 'document'], ['document', 'document'], ['frame', 'window'],
  ['window', 'window'], ['application', 'application'], ['article', 'article'], ['landmark', 'region'], ['grouping', 'group'],
  ['group', 'group'], ['list-item', 'listitem'], ['panel', 'generic'], ['section', 'generic'], ['filler', 'generic'],
  ['scroll pane', 'generic'], ['split pane', 'generic'], ['viewport', 'generic'], ['layered pane', 'generic'],
  ['root pane', 'generic'], ['glass pane', 'generic'], ['canvas', 'generic'], ['redundant object', 'generic'],
  ['unknown', 'generic'], ['pane', 'generic'], ['custom', 'generic'],
];

/** Roles kept even without a name: they carry structure or are operable. */
const KEPT_WITHOUT_NAME = ['button', 'checkbox', 'radio', 'textbox', 'searchbox', 'spinbutton', 'slider', 'switch', 'combobox', 'listbox', 'list', 'listitem', 'option', 'link', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'toolbar', 'tab', 'tablist', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'tree', 'treeitem', 'treegrid', 'dialog', 'alert', 'status', 'form', 'document', 'window', 'progressbar', 'separator', 'scrollbar', 'tooltip'];

const el = (over: Partial<CuaElement> & { element_index: number; role: string }): CuaElement => ({ element_token: `t:${over.element_index}`, ...over });

describe('role table', () => {
  it.each(ROLES)('%s is %s', (raw, aria) => {
    expect(ariaRole(raw)).toBe(aria);
  });

  it('has no entry that is not listed here', () => {
    const known = new Set(ROLES.map(([raw]) => raw));
    expect(known.size).toBe(ROLES.length);
    // every spelling of an unlisted role falls through to its slug
    expect(ariaRole('Totally New Role')).toBe('totally-new-role');
  });

  it('looks roles up without case or separators, and slugs the rest without leading or trailing hyphens', () => {
    expect(ariaRole('PushButton')).toBe('button');
    expect(ariaRole('push-button')).toBe('button');
    expect(ariaRole('PUSH_BUTTON')).toBe('button');
    expect(ariaRole('  --Odd  Role!! ')).toBe('odd-role');
    expect(ariaRole('')).toBe('generic');
    expect(ariaRole('***')).toBe('generic');
  });
});

describe('roles kept without a name', () => {
  it.each(KEPT_WITHOUT_NAME)('an unnamed %s is kept', (role) => {
    const built = buildNodes([el({ element_index: 0, role })], 1, { scope: 'window', secrets: [] });
    expect(built.nodes.map((n) => n.role)).toEqual([role]);
  });

  it.each(['heading', 'img', 'label', 'paragraph', 'region', 'article', 'group', 'application'])('an unnamed %s is dropped', (role) => {
    const built = buildNodes([el({ element_index: 0, role })], 1, { scope: 'window', secrets: [] });
    expect(built.nodes).toEqual([]);
  });

  it('an unnamed element with a value is kept whatever its role', () => {
    const built = buildNodes([el({ element_index: 0, role: 'heading', value: 'v' })], 1, { scope: 'window', secrets: [] });
    expect(built.nodes.map((n) => [n.role, n.name, n.value])).toEqual([['heading', '', 'v']]);
  });
});

describe('checked state', () => {
  it.each(['check box', 'radio button', 'switch', 'check menu item', 'radio menu item'])('%s exposes checked', (role) => {
    const built = buildNodes([el({ element_index: 0, role, label: 'x', checked: true })], 1, { scope: 'window', secrets: [] });
    expect(built.nodes[0]?.states).toEqual({ checked: true });
  });

  it.each(['push button', 'entry', 'menu item', 'list item'])('%s does not', (role) => {
    const built = buildNodes([el({ element_index: 0, role, label: 'x', checked: true })], 1, { scope: 'window', secrets: [] });
    expect(built.nodes[0]?.states).toEqual({});
  });
});

describe('parseElements keeps every field it knows', () => {
  it('copies strings, flags, parent and actions, and ignores wrongly typed ones', () => {
    const [e] = parseElements({
      elements: [{
        element_index: 3, element_token: 'tok', role: 'button', label: 'L', value: 'V', description: 'D', enabled: false, selected: true,
        checked: false, expanded: true, focused: true, in_web_content: true, parent_index: 1, actions: ['press', 7, 'focus'],
      }],
    });
    expect(e).toEqual({
      element_index: 3, element_token: 'tok', role: 'button', label: 'L', value: 'V', description: 'D', enabled: false, selected: true,
      checked: false, expanded: true, focused: true, in_web_content: true, parent_index: 1, actions: ['press', 'focus'],
    });
    const [bad] = parseElements({ elements: [{ element_index: 1, element_token: 't', role: 'r', label: 4, value: 5, description: 6, enabled: 'yes', expanded: 1, focused: 'no' }] });
    expect(bad).toEqual({ element_index: 1, element_token: 't', role: 'r' });
  });

  it('skips rows that are not objects, whatever they are (null, undefined, arrays, primitives)', () => {
    const rows = [undefined, null, [1, 2], 'text', 7, true, { element_index: 1, element_token: 't', role: 'button' }];
    expect(parseElements({ elements: rows }).map((r) => r.element_index)).toEqual([1]);
  });
});

describe('ancestor search', () => {
  it('gives up on an ancestor more than 10 000 levels up (a guard against parent cycles)', () => {
    // 0 (unnamed container), 1 = kept ancestor, 2..10001 unnamed containers, 10002 = kept node whose nearest kept ancestor is 10 001 hops away
    const rows: CuaElement[] = [el({ element_index: 0, role: 'panel' }), el({ element_index: 1, role: 'button', label: 'top' })];
    for (let i = 2; i <= 10_001; i += 1) rows.push(el({ element_index: i, role: 'panel', parent_index: i - 1 }));
    rows.push(el({ element_index: 10_002, role: 'button', label: 'deep', parent_index: 10_001 }));
    const built = buildNodes(rows, 1, { scope: 'window', secrets: [] });
    expect(built.nodes.map((n) => [n.name, n.parentRef, n.depth])).toEqual([['top', undefined, 0], ['deep', undefined, 0]]);
  });

  it('finds an ancestor 9 999 levels up', () => {
    const rows: CuaElement[] = [el({ element_index: 1, role: 'button', label: 'top' })];
    for (let i = 2; i <= 9_999; i += 1) rows.push(el({ element_index: i, role: 'panel', parent_index: i - 1 }));
    rows.push(el({ element_index: 10_000, role: 'button', label: 'deep', parent_index: 9_999 }));
    const built = buildNodes(rows, 1, { scope: 'window', secrets: [] });
    expect(built.nodes.map((n) => [n.name, n.parentRef])).toEqual([['top', undefined], ['deep', 'r1:e1']]);
  });
});

/** Key names (lower case) -> Cua Driver key names. */
const NAMED_KEYS: [string, string][] = [
  ['Enter', 'enter'], ['Return', 'return'], ['Tab', 'tab'], ['Escape', 'escape'], ['Esc', 'escape'], [' ', 'space'], ['Space', 'space'],
  ['Backspace', 'backspace'], ['Delete', 'delete'], ['Del', 'delete'], ['Insert', 'insert'], ['Home', 'home'], ['End', 'end'],
  ['PageUp', 'pageup'], ['PageDown', 'pagedown'], ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
  ['Up', 'up'], ['Down', 'down'], ['Left', 'left'], ['Right', 'right'],
];

describe('key table', () => {
  it.each(NAMED_KEYS)('%s -> %s', (spec, key) => {
    expect(parseKey(spec)).toEqual({ key, modifiers: [] });
    expect(parseKey(spec.toUpperCase())).toEqual({ key, modifiers: [] });
  });

  it('accepts F1 to F12 and nothing around them', () => {
    for (let n = 1; n <= 12; n += 1) expect(parseKey(`F${n}`)).toEqual({ key: `f${n}`, modifiers: [] });
    for (const bad of ['F0', 'F13', 'xF1', 'F1x', 'F100']) expect(parseKey(bad), bad).toBeUndefined();
  });

  it('an empty spec is not a key', () => {
    expect(parseKey('')).toBeUndefined();
  });
});
