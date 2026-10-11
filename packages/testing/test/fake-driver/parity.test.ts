import type { DriverSession, Observation } from '@ai-bdd/sdk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAcmeApp } from '../../src/app/index.ts';
import type { AxNode } from '../app/html-parse.ts';
import { MiniBrowser } from './mini-browser.ts';
import { click, fill, goto, openSession } from './helpers.ts';

/** Normalizes values that legitimately differ between a real wall clock and the fake clock. */
const mask = (s: string): string => s.replace(/\d\d:\d\d:\d\d(\.\d{3})?/g, 'T');

function fromObservation(obs: Observation): AxNode[] {
  return obs.nodes.map((n) => {
    const out: AxNode = { role: n.role, name: mask(n.name), states: {}, depth: n.depth };
    if (n.level !== undefined) out.level = n.level;
    if (n.value !== undefined) out.value = n.value;
    if (n.url !== undefined) out.url = n.url;
    if (n.states.disabled === true) out.states.disabled = true;
    if (n.states.checked !== undefined) out.states.checked = n.states.checked;
    if (n.states.expanded !== undefined) out.states.expanded = n.states.expanded;
    return out;
  });
}

const fromBrowser = (b: MiniBrowser): AxNode[] => b.nodes().map((n) => ({ ...n, name: mask(n.name) }));

describe('R-RN2: fake driver observation == HTTP server page (AC3 parity on role, name, level, states, value, url, order, depth)', () => {
  let app: Awaited<ReturnType<typeof startAcmeApp>>;
  beforeAll(async () => {
    app = await startAcmeApp({ flags: ['v2'] });
  });
  afterAll(async () => {
    await app.close();
  });

  async function pair(): Promise<{ s: DriverSession; b: MiniBrowser }> {
    return { s: await openSession({ flags: ['v2'] }), b: new MiniBrowser(app.url) };
  }

  it('static screens', async () => {
    for (const route of ['/login', '/settings/billing', '/todos', '/forms/two', '/notes', '/nope']) {
      const { s, b } = await pair();
      const obs = await goto(s, route);
      await b.goto(route);
      expect(fromObservation(obs), route).toEqual(fromBrowser(b));
      expect(obs.route).toBe(b.route);
      await s.close();
    }
  });

  it('billing upgrade flow (v2: "Go Pro"), step by step', async () => {
    const { s, b } = await pair();
    await goto(s, '/settings/billing');
    await b.goto('/settings/billing');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await click(s, 'button', 'Go Pro');
    await b.clickButton('Go Pro');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await click(s, 'button', 'Confirm');
    await b.clickButton('Confirm');
    const after = await s.observe();
    expect(fromObservation(after)).toEqual(fromBrowser(b));
    expect(after.nodes.some((n) => n.name === 'Upgraded to Pro')).toBe(true);
    await click(s, 'button', 'Downgrade to Free');
    await b.clickButton('Downgrade to Free');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await s.close();
  });

  it('cancel path and navigation away and back clear the dialog', async () => {
    const { s, b } = await pair();
    await goto(s, '/settings/billing');
    await b.goto('/settings/billing');
    await click(s, 'button', 'Go Pro');
    await b.clickButton('Go Pro');
    await click(s, 'button', 'Cancel');
    await b.clickButton('Cancel');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await click(s, 'link', 'Todos');
    await b.clickLink('Todos');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await s.close();
  });

  it('todos: add via the button and via Enter', async () => {
    const { s, b } = await pair();
    await goto(s, '/todos');
    await b.goto('/todos');
    await fill(s, 'New todo', { literal: 'Buy <milk> & "eggs"' });
    b.fill('New todo', 'Buy <milk> & "eggs"');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b).map((n) => (n.role === 'textbox' ? { ...n, value: 'Buy <milk> & "eggs"' } : n)));
    await click(s, 'button', 'Add');
    await b.clickButton('Add');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    const obs = await s.observe();
    await s.perform({ verb: 'fill', target: { ref: obs.nodes.find((n) => n.role === 'textbox')?.ref ?? '' }, value: { literal: 'Second' } });
    await s.perform({ verb: 'press', key: 'Enter', target: { ref: obs.nodes.find((n) => n.role === 'textbox')?.ref ?? '' } });
    b.fill('New todo', 'Second');
    await b.pressEnter();
    const final = fromObservation(await s.observe());
    expect(final).toEqual(fromBrowser(b));
    expect(final.filter((n) => n.role === 'listitem')).toHaveLength(2);
    await s.close();
  });

  it('checkout: both forms, including saved values', async () => {
    const { s, b } = await pair();
    await goto(s, '/forms/two');
    await b.goto('/forms/two');
    await fill(s, 'Street', { literal: '1 Main St' }, 0);
    b.fill('Street', '1 Main St', 0);
    await click(s, 'button', 'Submit', 0);
    await b.clickButton('Submit', 0);
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await fill(s, 'Street', { literal: '2 Side St' }, 1);
    b.fill('Street', '2 Side St', 1);
    await click(s, 'button', 'Submit', 1);
    await b.clickButton('Submit', 1);
    const end = await s.observe();
    expect(fromObservation(end)).toEqual(fromBrowser(b));
    expect(end.nodes.filter((n) => n.role === 'textbox').map((n) => n.value)).toEqual(['1 Main St', '2 Side St']);
    await s.close();
  });

  it('login: failure then success redirect', async () => {
    const { s, b } = await pair();
    await goto(s, '/login');
    await b.goto('/login');
    await fill(s, 'Password', { literal: 'nope' });
    b.fill('Password', 'nope');
    await click(s, 'button', 'Sign in');
    await b.clickButton('Sign in');
    expect(fromObservation(await s.observe())).toEqual(fromBrowser(b));
    await fill(s, 'Password', { secret: 'adminPassword' });
    b.fill('Password', 'correct-horse-battery');
    await click(s, 'button', 'Sign in');
    await b.clickButton('Sign in');
    const obs = await s.observe();
    expect(fromObservation(obs)).toEqual(fromBrowser(b));
    expect(obs.route).toBe(b.route);
    expect(obs.route).toBe('/settings/billing');
    await s.close();
  });

  it('slow: spinner shape matches the server loading page; the finished shape matches the swapped content', async () => {
    const { s, b } = await pair();
    const loading = await goto(s, '/slow?ms=5000');
    await b.goto('/slow?ms=5000');
    expect(loading.busy).toBe(true);
    expect(fromObservation(loading)).toEqual(fromBrowser(b));
    await s.perform({ verb: 'wait', ms: 5000 });
    const done = await s.observe();
    expect(done.busy).toBe(false);
    // The server swaps in exactly this markup after the delay; render it directly.
    const { renderPage, acmeModel } = await import('../../src/app/index.ts');
    const { toAxNodes } = await import('../app/html-parse.ts');
    const st = acmeModel.dispatch(acmeModel.initialState(), { type: 'visit', route: '/slow?ms=5000' }, 0).state;
    expect(fromObservation(done)).toEqual(toAxNodes(renderPage(st, '/slow?ms=5000', 5000)).map((n) => ({ ...n, name: mask(n.name) })));
    await s.close();
  });
});
