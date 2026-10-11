import { describe, expect, it } from 'vitest';
import { treeHash } from '@ai-bdd/sdk';
import { ariaRole, buildNodes, cleanLabel, desktopEnv, normalizeResult, parseElements, parseKey, settleHash } from '../src/index.ts';
import type { CuaElement } from '../src/index.ts';

const el = (over: Partial<CuaElement> & { element_index: number; role: string }): CuaElement => ({ element_token: `s00000001:${over.element_index}`, ...over });

describe('parseKey', () => {
  it('maps Playwright style key names to cua-driver keys and modifiers', () => {
    expect(parseKey('Enter')).toEqual({ key: 'enter', modifiers: [] });
    expect(parseKey('Escape')).toEqual({ key: 'escape', modifiers: [] });
    expect(parseKey('ArrowDown')).toEqual({ key: 'down', modifiers: [] });
    expect(parseKey('Control+A')).toEqual({ key: 'A', modifiers: ['ctrl'] });
    expect(parseKey('Control+Shift+K')).toEqual({ key: 'K', modifiers: ['ctrl', 'shift'] });
    expect(parseKey('Alt+Left')).toEqual({ key: 'left', modifiers: ['alt'] });
    expect(parseKey('F5')).toEqual({ key: 'f5', modifiers: [] });
    expect(parseKey('x')).toEqual({ key: 'x', modifiers: [] });
    expect(parseKey(' ')).toEqual({ key: 'space', modifiers: [] });
    expect(parseKey('+')).toEqual({ key: '+', modifiers: [] });
    expect(parseKey('Control++')).toEqual({ key: '+', modifiers: ['ctrl'] });
  });

  it('rejects empty, unknown and malformed specs', () => {
    expect(parseKey('')).toBeUndefined();
    expect(parseKey('Hyper+A')).toBeUndefined();
    expect(parseKey('NotAKey')).toBeUndefined();
    expect(parseKey('Control+')).toBeUndefined();
  });
});

describe('parseKey: names that exist on Object.prototype', () => {
  // Found by tests/fuzz/cua-keys.test.ts: parseKey('constructor') returned { key: Object } and parseKey('__proto__') { key: {} }.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Constructor', 'TOSTRING'])('%s is neither a key nor a modifier', (name) => {
    expect(parseKey(name)).toBeUndefined();
    expect(parseKey(`Control+${name}`)).toBeUndefined();
    expect(parseKey(`${name}+a`)).toBeUndefined();
  });
});

describe('buildNodes: overlapping secrets', () => {
  // Found by tests/fuzz/cua-nodes.test.ts (secrets ["AAAA", "AAAA0"], value "AAAA0" came out as "[secret]0").
  it.each([[['alice', 'alice123']], [['alice123', 'alice']]])('a secret that contains another one is replaced whole (%j)', (secrets) => {
    const built = buildNodes([{ element_index: 0, element_token: 't', role: 'entry', label: 'Name alice123', value: 'alice123' }], 1, { scope: 'window', secrets });
    expect(built.nodes[0]?.value).toBe('[secret]');
    expect(built.nodes[0]?.name).toBe('Name [secret]');
  });
});

describe('cleanLabel: repeated list markers', () => {
  // Found by tests/fuzz/cua-nodes.test.ts: cleanLabel("••", "listitem") gave "•", and cleaning that again gave "".
  it('strips every leading marker, so cleaning twice equals cleaning once', () => {
    expect(cleanLabel('• ◦ One', 'listitem')).toBe('One');
    expect(cleanLabel('••', 'listitem')).toBe('');
    expect(cleanLabel('••', 'button')).toBe('••');
  });
});

describe('roles and labels', () => {
  it('maps AT-SPI role names to ARIA roles and keeps unknown ones recognizable', () => {
    expect(ariaRole('push button')).toBe('button');
    expect(ariaRole('check box')).toBe('checkbox');
    expect(ariaRole('entry')).toBe('textbox');
    expect(ariaRole('password text')).toBe('textbox');
    expect(ariaRole('document web')).toBe('document');
    expect(ariaRole('page tab')).toBe('tab');
    expect(ariaRole('statusbar')).toBe('status');
    expect(ariaRole('status bar')).toBe('status');
    expect(ariaRole('Push-Button')).toBe('button');
    expect(ariaRole('PushButton')).toBe('button');
    expect(ariaRole('Some New Role')).toBe('some-new-role');
    expect(ariaRole('')).toBe('generic');
  });

  it('strips object replacement characters, collapses whitespace and removes list markers', () => {
    expect(cleanLabel('￼￼', 'generic')).toBe('');
    expect(cleanLabel('  Sign   in\n now ', 'button')).toBe('Sign in now');
    expect(cleanLabel('• One', 'listitem')).toBe('One');
    expect(cleanLabel('• One', 'paragraph')).toBe('• One');
    expect(cleanLabel(undefined, 'button')).toBe('');
  });
});

describe('parseElements', () => {
  it('keeps addressable rows in index order and skips malformed ones', () => {
    const rows = parseElements({
      elements: [
        { element_index: 2, element_token: 's1:2', role: 'link', label: 'B' },
        { element_index: 1, element_token: 's1:1', role: 'heading', label: 'A', selected: true, actions: ['x', 3] },
        { element_index: 'x', element_token: 's1:3', role: 'link' },
        { element_index: 4, role: 'link' },
        'junk',
        null,
      ],
    });
    expect(rows.map((r) => r.element_index)).toEqual([1, 2]);
    expect(rows[0]?.actions).toEqual(['x']);
    expect(rows[0]?.selected).toBe(true);
    expect(parseElements({})).toEqual([]);
    expect(parseElements({ elements: 'nope' })).toEqual([]);
  });
});

describe('buildNodes', () => {
  const rows: CuaElement[] = [
    el({ element_index: 0, role: 'frame', label: 'App' }),
    el({ element_index: 1, role: 'panel', label: '￼', parent_index: 0 }),
    el({ element_index: 2, role: 'push button', label: 'Reload', parent_index: 1 }),
    el({ element_index: 3, role: 'document web', label: 'Page', parent_index: 1 }),
    el({ element_index: 4, role: 'section', label: '', parent_index: 3, in_web_content: true }),
    el({ element_index: 5, role: 'heading', label: 'Settings', parent_index: 4, in_web_content: true }),
    el({ element_index: 6, role: 'check box', label: 'Subscribe', selected: true, parent_index: 4, in_web_content: true }),
    el({ element_index: 7, role: 'check box', label: 'Terms', selected: false, parent_index: 4, in_web_content: true }),
    el({ element_index: 8, role: 'password text', label: 'Password', value: 'hunter22', parent_index: 4, in_web_content: true }),
    el({ element_index: 9, role: 'entry', label: 'Name', value: 'Ada hunter22', parent_index: 4, in_web_content: true }),
    el({ element_index: 10, role: 'list item', label: '• One', selected: false, parent_index: 4, in_web_content: true }),
    el({ element_index: 11, role: 'push button', label: 'Save', enabled: false, parent_index: 4, in_web_content: true }),
    el({ element_index: 12, role: 'progress bar', label: 'Loading', value: '0.0', parent_index: 4, in_web_content: true }),
    el({ element_index: 13, role: 'paragraph', label: 'off-screen: scroll it into view', description: 'off-screen: scroll it into view', parent_index: 4, in_web_content: true }),
  ];

  it('content scope drops the browser chrome and prunes unnamed layout containers, moving their children up', () => {
    const built = buildNodes(rows, 3, { scope: 'content', secrets: [] });
    expect(built.nodes.map((n) => `${n.depth}:${n.role}:${n.name}`)).toEqual([
      '0:heading:Settings', '0:checkbox:Subscribe', '0:checkbox:Terms', '0:textbox:Password', '0:textbox:Name',
      '0:listitem:One', '0:button:Save', '0:progressbar:Loading',
    ]);
    expect(built.nodes[0]?.ref).toBe('r3:e5');
    expect(built.nodes.every((n) => n.parentRef === undefined)).toBe(true);
    expect(built.tokens.get('r3:e5')).toBe('s00000001:5');
  });

  it('window scope keeps the whole window with the parent structure', () => {
    const built = buildNodes(rows, 1, { scope: 'window', secrets: [] });
    const byName = new Map(built.nodes.map((n) => [n.name, n]));
    expect(byName.get('App')?.depth).toBe(0);
    expect(byName.get('Reload')?.parentRef).toBe('r1:e0');
    expect(byName.get('Reload')?.depth).toBe(1);
    expect(byName.get('Page')?.role).toBe('document');
    expect(byName.get('Settings')?.parentRef).toBe('r1:e3');
    expect(byName.get('Settings')?.depth).toBe(2);
  });

  it('maps states and exposes check state for check, radio and switch only', () => {
    const built = buildNodes(rows, 1, { scope: 'content', secrets: [] });
    const node = (name: string) => built.nodes.find((n) => n.name === name);
    expect(node('Subscribe')?.states).toEqual({ checked: true });
    expect(node('Terms')?.states).toEqual({ checked: false });
    expect(node('Save')?.states).toEqual({ disabled: true });
    expect(node('One')?.states).toEqual({});
    expect(built.checked.get('r1:e6')).toBe(true);
    expect(built.checked.get('r1:e7')).toBe(false);
    expect(built.checked.has('r1:e5')).toBe(false);
  });

  it('never exposes password values, scrubs known secrets, ignores the driver\'s off-screen note and reports busy', () => {
    const built = buildNodes(rows, 1, { scope: 'content', secrets: ['hunter22'] });
    const password = built.nodes.find((n) => n.name === 'Password');
    expect(password?.value).toBeUndefined();
    expect(built.nodes.find((n) => n.name === 'Name')?.value).toBe('Ada [secret]');
    expect(JSON.stringify(built.nodes)).not.toContain('hunter22');
    expect(built.nodes.some((n) => n.name.startsWith('off-screen'))).toBe(false);
    expect(built.busy).toBe(true);
    expect(buildNodes(rows.slice(0, 6), 1, { scope: 'content', secrets: [] }).busy).toBe(false);
  });

  it('does not scrub values shorter than the minimum secret length', () => {
    const built = buildNodes([el({ element_index: 1, role: 'entry', label: 'Code ab', in_web_content: true })], 1, { scope: 'content', secrets: ['ab'] });
    expect(built.nodes[0]?.name).toBe('Code ab');
  });
});

describe('normalizeResult', () => {
  it('flags driver refusals and errors with their machine-readable code', () => {
    const refused = normalizeResult({ content: [], structuredContent: { status: 'refused', refusal: { code: 'stale_element_token', message: 'element_token is stale' } } });
    expect(refused).toMatchObject({ failed: true, code: 'stale_element_token', text: 'element_token is stale' });
    const errored = normalizeResult({ isError: true, content: [{ type: 'text', text: 'Background delivery is not available' }], structuredContent: { code: 'background_unavailable', detail: 'x' } });
    expect(errored).toMatchObject({ failed: true, code: 'background_unavailable', text: 'Background delivery is not available' });
    const ok = normalizeResult({ content: [{ type: 'text', text: 'Clicked' }], structuredContent: { effect: 'confirmed' } });
    expect(ok).toMatchObject({ failed: false, text: 'Clicked' });
    expect(ok.code).toBeUndefined();
  });

  it('decodes image blocks', () => {
    const r = normalizeResult({ content: [{ type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' }] });
    expect(Array.from(r.images[0]?.data ?? [])).toEqual([1, 2, 3]);
    expect(r.images[0]?.mimeType).toBe('image/png');
    expect(normalizeResult(undefined)).toEqual({ failed: false, text: '', structured: {}, images: [] });
  });
});

describe('desktopEnv', () => {
  it('passes what a desktop process needs and nothing else', () => {
    const env = desktopEnv({
      PATH: '/bin', DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', LC_ALL: 'C', XDG_RUNTIME_DIR: '/run/u', CUA_DRIVER_HOME: '/h',
      ANTHROPIC_API_KEY: 'sk-secret', ACME_ADMIN_PASSWORD: 'pw', AI_GATEWAY_API_KEY: 'k', GITHUB_TOKEN: 't',
    });
    expect(Object.keys(env).sort()).toEqual(['CUA_DRIVER_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'LC_ALL', 'PATH', 'XDG_RUNTIME_DIR']);
  });
});

describe('settleHash', () => {
  const node = (role: string, name: string, over: Record<string, unknown> = {}) => ({ ref: `r1:${name}`, role, name, states: {}, depth: 0, ...over });
  it('ignores the text of live regions but not their presence, and every other change counts', () => {
    const base = [node('heading', 'Todos'), node('status', 'Synced at 10:00:00.500')];
    const later = [node('heading', 'Todos'), node('status', 'Synced at 10:00:01.000')];
    expect(settleHash(later, treeHash)).toBe(settleHash(base, treeHash));
    expect(settleHash([node('heading', 'Todos')], treeHash)).not.toBe(settleHash(base, treeHash));
    expect(settleHash([node('heading', 'Todos!'), node('status', 'x')], treeHash)).not.toBe(settleHash(base, treeHash));
    expect(settleHash([node('heading', 'Todos'), node('log', 'a'), node('timer', 'b', { value: '3' })], treeHash))
      .toBe(settleHash([node('heading', 'Todos'), node('log', 'zz'), node('timer', 'c', { value: '9' })], treeHash));
    expect(treeHash(later)).not.toBe(treeHash(base)); // the plain tree hash would have moved
  });
});
