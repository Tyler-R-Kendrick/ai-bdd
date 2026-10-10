// @ts-nocheck
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from '@ai-bdd/verify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';
import { parseAriaSnapshot, pruneWrappers } from '../src/index.ts';
import { browserAvailable, launchRaw } from './browser.ts';
import { PAGES, startFixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'golden');
const hasBrowser = await browserAvailable();

const SCREENS: Record<string, string> = {
  login: '/login', billing: '/settings/billing', todos: '/todos', 'forms-two': '/forms/two', notes: '/notes', widgets: '/widgets',
};
void PAGES;

describe('parseAriaSnapshot grammar (V3/V4)', () => {
  it('R-AG4: parses role, name, attributes, level, refs, inline text and /url properties', () => {
    const nodes = parseAriaSnapshot([
      '- navigation "Primary" [ref=e2]:',
      '  - link "Billing" [ref=e3] [cursor=pointer]:',
      '    - /url: /settings/billing',
      '- heading "Sign in" [level=1] [ref=e6]',
      '- textbox "Email" [ref=e8]: a@b.c',
      '- status [ref=e13]: "Plan: Free"',
      '- button "Upgrade to Pro" [disabled] [ref=e14]',
      '- checkbox "Agree" [checked] [ref=e21]',
      '- checkbox "Mix" [checked=mixed] [ref=e22]',
      '- button "Menu" [expanded] [pressed=mixed] [ref=e24]',
      '- tab "T" [selected] [active] [ref=e25]',
    ].join('\n'));
    expect(nodes.map((n) => [n.ref, n.role, n.name, n.depth, n.parentRef])).toEqual([
      ['e2', 'navigation', 'Primary', 0, undefined],
      ['e3', 'link', 'Billing', 1, 'e2'],
      ['e6', 'heading', 'Sign in', 0, undefined],
      ['e8', 'textbox', 'Email', 0, undefined],
      ['e13', 'status', 'Plan: Free', 0, undefined],
      ['e14', 'button', 'Upgrade to Pro', 0, undefined],
      ['e21', 'checkbox', 'Agree', 0, undefined],
      ['e22', 'checkbox', 'Mix', 0, undefined],
      ['e24', 'button', 'Menu', 0, undefined],
      ['e25', 'tab', 'T', 0, undefined],
    ]);
    expect(nodes[1]?.url).toBe('/settings/billing');
    expect(nodes[2]?.level).toBe(1);
    expect(nodes[3]?.value).toBe('a@b.c');
    expect(nodes[4]?.text).toBe('Plan: Free');
    expect(nodes[5]?.states).toEqual({ disabled: true });
    expect(nodes[6]?.states).toEqual({ checked: true });
    expect(nodes[7]?.states).toEqual({ checked: 'mixed' });
    expect(nodes[8]?.states).toEqual({ expanded: true, pressed: 'mixed' });
    expect(nodes[9]?.states).toEqual({ selected: true, focused: true });
  });

  it('R-AG4: unquotes whole-line single-quoted keys and double-quoted values with escapes', () => {
    const nodes = parseAriaSnapshot([
      `- 'link "Link with: colon" [ref=e21] [cursor=pointer]':`,
      '  - /url: /x?a=1&b=2',
      `- 'button "It''s" [ref=e22]'`,
      '- heading "Title \\"quoted\\" here" [level=2] [ref=e3]',
      '- paragraph [ref=e4]: "Hello \\"x\\" \\\\ back \\n next \\x01"',
      '- paragraph [ref=e5]: "true"',
      '- paragraph [ref=e6]: ~',
    ].join('\n'));
    expect(nodes[0]).toMatchObject({ role: 'link', name: 'Link with: colon', url: '/x?a=1&b=2', ref: 'e21' });
    expect(nodes[1]?.name).toBe("It's");
    expect(nodes[2]?.name).toBe('Title "quoted" here');
    expect(nodes[3]?.text).toBe('Hello "x" \\ back \n next \x01');
    expect(nodes[4]?.text).toBe('true');
    expect(nodes[5]?.text).toBe('~');
  });

  it('R-AG4: name falls back to inline text; textboxes keep inline text as value; text nodes and nesting', () => {
    const nodes = parseAriaSnapshot([
      '- paragraph [ref=e3]:',
      '  - text: Hello',
      '  - link "link" [ref=e4] [cursor=pointer]:',
      '    - /url: /z',
      '  - text: tail',
      '- listitem [ref=e8]: Buy milk — added 12:00:01',
      '- textbox "New todo" [ref=e9]',
      '- combobox "Color" [ref=e10]:',
      '  - option "Red"',
      '  - option "Blue" [selected]',
    ].join('\n'));
    expect(nodes.map((n) => [n.role, n.name, n.depth])).toEqual([
      ['paragraph', '', 0], ['text', 'Hello', 1], ['link', 'link', 1], ['text', 'tail', 1],
      ['listitem', 'Buy milk — added 12:00:01', 0], ['textbox', 'New todo', 0], ['combobox', 'Color', 0], ['option', 'Red', 1], ['option', 'Blue', 1],
    ]);
    expect(nodes[1]?.ref).toBe('n2');
    expect(nodes[3]?.parentRef).toBe('e3');
    expect(nodes[5]?.value).toBeUndefined();
    expect(nodes[6]?.value).toBe('Blue');
    expect(nodes[7]?.ref).toBe('n8');
  });

  it('R-AG4: buttons and links with elided names take the text of their content', () => {
    const nodes = parseAriaSnapshot(['- button [ref=e11]:', '  - text: Say "hi"', '  - emphasis [ref=e12]: now'].join('\n'));
    expect(nodes[0]?.name).toBe('Say "hi" now');
  });

  it('R-AG4: pruneWrappers drops anonymous generics and re-parents children, keeping text-bearing generics', () => {
    const nodes = pruneWrappers(parseAriaSnapshot([
      '- generic [active] [ref=e1]:',
      '  - navigation "Primary" [ref=e2]',
      '  - generic [ref=e7]:',
      '    - textbox "Email" [ref=e8]',
      '    - button "Go" [ref=e10]',
      '  - generic [ref=e27]: plain div text',
    ].join('\n')));
    expect(nodes.map((n) => [n.ref, n.depth, n.parentRef])).toEqual([
      ['e2', 0, undefined], ['e8', 0, undefined], ['e10', 0, undefined], ['e27', 0, undefined],
    ]);
  });

  it('R-AG4: ignores malformed lines and never throws on arbitrary input', () => {
    expect(parseAriaSnapshot('')).toEqual([]);
    expect(() => parseAriaSnapshot('garbage\n- \n  - "unterminated\n- x "bad [ref=')).not.toThrow();
  });
});

describe.skipIf(!hasBrowser)('parseAriaSnapshot goldens captured from Chromium (V3/V4)', () => {
  let browser: Browser;
  let fx: Fixture;
  beforeAll(async () => {
    browser = await launchRaw();
    fx = await startFixture();
  });
  afterAll(async () => {
    await browser.close();
    await fx.close();
  });

  for (const [name, path] of Object.entries(SCREENS)) {
    it(`R-AG4: golden ${name}: live ai-mode snapshot matches the pinned text and parses to the pinned nodes`, async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${fx.url}${path}`);
      const live = await page.ariaSnapshot({ mode: 'ai' });
      await ctx.close();
      // approve a changed screen with `pnpm verify:accept`
      await verify(`${live}\n`, { directory: goldenDir, fileName: `${name}.aria`, extension: 'txt', scrubDefaults: false });
      await verify(pruneWrappers(parseAriaSnapshot(live)), { directory: goldenDir, fileName: `${name}.nodes`, extension: 'json', scrubDefaults: false });
    });
  }

  it('R-SE1: V4 observed that the snapshot exposes password values (driver must strip them)', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${fx.url}/login`);
    await page.getByLabel('Password').fill('hunter2-hunter2');
    const live = await page.ariaSnapshot({ mode: 'ai' });
    await ctx.close();
    expect(live).toContain('hunter2-hunter2');
  });
});
