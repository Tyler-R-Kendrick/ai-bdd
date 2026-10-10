import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservedNode } from '@ai-bdd/sdk/contracts';
import { buildNodes, desktopEnv, settleHash } from '../src/index.ts';
import type { CuaElement } from '../src/index.ts';

const el = (over: Partial<CuaElement> & { element_index: number; role: string }): CuaElement => ({ element_token: `t:${over.element_index}`, label: `n${over.element_index}`, ...over });
const build = (rows: CuaElement[], scope: 'content' | 'window' = 'window', secrets: string[] = []) => buildNodes(rows, 1, { scope, secrets });

describe('buildNodes element states', () => {
  it('check boxes, radios and switches expose their state, taken from `checked` and falling back to `selected`', () => {
    const built = build([
      el({ element_index: 0, role: 'check box', checked: true }),
      el({ element_index: 1, role: 'check box', checked: false, selected: true }),
      el({ element_index: 2, role: 'radio button', selected: true }),
      el({ element_index: 3, role: 'switch', selected: false }),
      el({ element_index: 4, role: 'check box' }),
    ]);
    expect(built.nodes.map((n) => [n.name, n.states])).toEqual([
      ['n0', { checked: true }], ['n1', { checked: false }], ['n2', { checked: true }], ['n3', { checked: false }], ['n4', {}],
    ]);
    expect([...built.checked]).toEqual([['r1:e0', true], ['r1:e1', false], ['r1:e2', true], ['r1:e3', false]]);
  });

  it('`selected` marks tabs, options, tree items, rows, cells, menu items and list items, and nothing else', () => {
    const roles: [string, string][] = [['page tab', 'tab'], ['option', 'option'], ['tree item', 'treeitem'], ['table row', 'row'], ['table cell', 'cell'], ['menu item', 'menuitem'], ['list item', 'listitem']];
    const built = build([...roles.map(([role], i) => el({ element_index: i, role, selected: true })), el({ element_index: 20, role: 'push button', selected: true }), el({ element_index: 21, role: 'page tab', selected: false })]);
    expect(built.nodes.filter((n) => n.states.selected === true).map((n) => n.role)).toEqual(roles.map(([, aria]) => aria));
    expect(built.nodes.find((n) => n.role === 'button')?.states).toEqual({});
    expect(built.nodes.find((n) => n.name === 'n21')?.states).toEqual({});
  });

  it('disabled, expanded (true and false) and focused (only when true) are carried over', () => {
    const built = build([
      el({ element_index: 0, role: 'push button', enabled: false }),
      el({ element_index: 1, role: 'push button', enabled: true }),
      el({ element_index: 2, role: 'tree item', expanded: true }),
      el({ element_index: 3, role: 'tree item', expanded: false }),
      el({ element_index: 4, role: 'entry', focused: true }),
      el({ element_index: 5, role: 'entry', focused: false }),
    ]);
    expect(built.nodes.map((n) => n.states)).toEqual([{ disabled: true }, {}, { expanded: true }, { expanded: false }, { focused: true }, {}]);
  });

  it('a progress bar marks the observation busy, even without a name', () => {
    expect(build([el({ element_index: 0, role: 'progress bar', label: '' })]).busy).toBe(true);
    expect(build([el({ element_index: 0, role: 'push button' })]).busy).toBe(false);
  });

  it('a label that merely repeats the description is dropped, and password values never leave the driver', () => {
    const built = build([
      el({ element_index: 0, role: 'push button', label: 'Scroll it into view', description: 'Scroll it into view' }),
      el({ element_index: 1, role: 'password text', label: 'Password', value: 'hunter22' }),
      el({ element_index: 2, role: 'entry', label: 'Empty', value: '' }),
      el({ element_index: 3, role: 'entry', label: 'Name', value: 'Ada' }),
    ]);
    expect(built.nodes.map((n) => [n.name, n.value])).toEqual([['', undefined], ['Password', undefined], ['Empty', undefined], ['Name', 'Ada']]);
  });

  it('parents are the nearest kept ancestor, depth follows them, and a parent chain cannot loop forever', () => {
    const built = build([
      el({ element_index: 0, role: 'frame', label: 'Window' }),
      el({ element_index: 1, role: 'panel', label: '' }),
      el({ element_index: 2, role: 'panel', label: '', parent_index: 1 }),
      el({ element_index: 3, role: 'push button', label: 'Go', parent_index: 2 }),
    ].map((e, i) => (i === 1 ? { ...e, parent_index: 0 } : e)));
    expect(built.nodes.map((n) => [n.ref, n.parentRef, n.depth])).toEqual([['r1:e0', undefined, 0], ['r1:e3', 'r1:e0', 1]]);

    const cyclic = build([el({ element_index: 0, role: 'panel', label: '', parent_index: 1 }), el({ element_index: 1, role: 'panel', label: '', parent_index: 0 }), el({ element_index: 2, role: 'push button', parent_index: 0 })]);
    expect(cyclic.nodes.map((n) => [n.ref, n.parentRef, n.depth])).toEqual([['r1:e2', undefined, 0]]);
  });

  it('secrets of four characters or more are scrubbed from names and values, shorter ones are left alone', () => {
    const built = build([el({ element_index: 0, role: 'entry', label: 'Token abcd1234 here', value: 'abcd1234' }), el({ element_index: 1, role: 'entry', label: 'Pin 12', value: '12' })], 'window', ['abcd1234', '12', '']);
    expect(built.nodes.map((n) => [n.name, n.value])).toEqual([['Token [secret] here', '[secret]'], ['Pin 12', '12']]);
  });
});

describe('settleHash', () => {
  const node = (over: Partial<ObservedNode> & { ref: string; role: string }): ObservedNode => ({ name: 'x', states: {}, depth: 0, ...over });

  it('hands the hash function nodes whose live regions have lost their text, name and value, and leaves all others untouched', () => {
    const seen: ObservedNode[][] = [];
    const nodes = [
      node({ ref: 'a', role: 'status', name: '12:00', value: 'v', text: 't', states: { busy: true }, parentRef: 'p' }),
      node({ ref: 'b', role: 'timer', name: 'tick', text: '3' }),
      node({ ref: 'c', role: 'log', name: 'lines' }),
      node({ ref: 'd', role: 'marquee', name: 'ticker' }),
      node({ ref: 'e', role: 'button', name: 'Go', value: 'kept', text: 'kept' }),
    ];
    settleHash(nodes, (n) => {
      seen.push([...n]);
      return 0;
    });
    expect(seen[0]).toEqual([
      { ref: 'a', role: 'status', name: '', states: { busy: true }, depth: 0, parentRef: 'p' },
      { ref: 'b', role: 'timer', name: '', states: {}, depth: 0 },
      { ref: 'c', role: 'log', name: '', states: {}, depth: 0 },
      { ref: 'd', role: 'marquee', name: '', states: {}, depth: 0 },
      nodes[4],
    ]);
    expect(nodes[0]?.name).toBe('12:00'); // the observation itself is not modified
  });
});

describe('desktopEnv', () => {
  it('keeps exact names and the LC_, XDG_, CUA_ and AT_SPI_ families, and drops everything else', () => {
    expect(desktopEnv({
      PATH: '/bin', HOME: '/h', DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:x', LC_ALL: 'C', XDG_RUNTIME_DIR: '/run', CUA_LOG: '1', AT_SPI_BUS_ADDRESS: 'b',
      OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', LCX: 'no', XDGX: 'no', MYCUA_X: 'no', UNSET: undefined,
    })).toEqual({ PATH: '/bin', HOME: '/h', DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:x', LC_ALL: 'C', XDG_RUNTIME_DIR: '/run', CUA_LOG: '1', AT_SPI_BUS_ADDRESS: 'b' });
  });
});

describe('key names by platform', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.resetModules();
  });
  const parseOn = async (platform: string): Promise<(spec: string) => ReturnType<typeof import('../src/keys.ts').parseKey>> => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
    const mod = await import('../src/keys.ts');
    return mod.parseKey;
  };

  it('Meta, Cmd and ControlOrMeta mean the command key on macOS and super / control elsewhere', async () => {
    const mac = await parseOn('darwin');
    expect(mac('Meta+S')).toEqual({ key: 'S', modifiers: ['cmd'] });
    expect(mac('Command+Shift+Z')).toEqual({ key: 'Z', modifiers: ['cmd', 'shift'] });
    expect(mac('ControlOrMeta+A')).toEqual({ key: 'A', modifiers: ['cmd'] });
    expect(mac('Control+A')).toEqual({ key: 'A', modifiers: ['ctrl'] });
    const linux = await parseOn('linux');
    expect(linux('Meta+S')).toEqual({ key: 'S', modifiers: ['super'] });
    expect(linux('Win+E')).toEqual({ key: 'E', modifiers: ['super'] });
    expect(linux('ControlOrMeta+A')).toEqual({ key: 'A', modifiers: ['ctrl'] });
  });

  it('a modifier named twice, or by two spellings of the same key, is sent once', async () => {
    const parse = await parseOn('linux');
    expect(parse('Control+Ctrl+A')).toEqual({ key: 'A', modifiers: ['ctrl'] });
    expect(parse('Shift+Shift+Tab')).toEqual({ key: 'tab', modifiers: ['shift'] });
    expect(parse('Alt+Option+F4')).toEqual({ key: 'f4', modifiers: ['alt'] });
  });

  it('function keys stop at F12 and unknown multi-character names are rejected', async () => {
    const parse = await parseOn('linux');
    expect(parse('F12')).toEqual({ key: 'f12', modifiers: [] });
    expect(parse('F13')).toBeUndefined();
    expect(parse('F0')).toBeUndefined();
    expect(parse('Shift+Bogus')).toBeUndefined();
  });
});
