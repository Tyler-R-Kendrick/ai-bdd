import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIONS, acmeModel, renderPage, startAcmeApp, type AcmeEvent, type AcmeState } from '../../src/app/index.ts';
import { Client } from './client.ts';
import { toAxNodes, uiToAxNodes } from './html-parse.ts';

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const run = (s: AcmeState, ...events: AcmeEvent[]): AcmeState => events.reduce((a, e) => acmeModel.dispatch(a, e, T0).state, s);
const visit = (route: string): AcmeEvent => ({ type: 'visit', route });
const act = (action: string, fields?: Record<string, string>): AcmeEvent => ({ type: 'action', action, ...(fields ? { fields } : {}) });

interface Case {
  name: string;
  state: AcmeState;
  route: string;
  now: number;
}

const base = acmeModel.initialState();
const pro = run(base, { type: 'seed', plan: 'pro' });
const cases: Case[] = [
  { name: 'login', state: base, route: '/login', now: T0 },
  { name: 'login error', state: run(base, act(ACTIONS.loginSubmit, { password: 'x' })), route: '/login', now: T0 },
  { name: 'billing free', state: base, route: '/settings/billing', now: T0 },
  { name: 'billing free v2', state: acmeModel.initialState({ flags: ['v2'] }), route: '/settings/billing', now: T0 },
  { name: 'billing dialog open', state: run(base, visit('/settings/billing'), act(ACTIONS.upgrade)), route: '/settings/billing', now: T0 },
  { name: 'billing after upgrade (toast)', state: run(base, visit('/settings/billing'), act(ACTIONS.upgrade), act(ACTIONS.confirmUpgrade)), route: '/settings/billing', now: T0 },
  { name: 'billing bug-upgrade-noop', state: run(acmeModel.initialState({ flags: ['bug-upgrade-noop'] }), visit('/settings/billing'), act(ACTIONS.upgrade), act(ACTIONS.confirmUpgrade)), route: '/settings/billing', now: T0 },
  { name: 'billing pro', state: pro, route: '/settings/billing', now: T0 },
  { name: 'billing pro unpaid alert', state: run(pro, { type: 'seed', unpaid: 2 }, visit('/settings/billing'), act(ACTIONS.downgrade)), route: '/settings/billing', now: T0 },
  { name: 'billing downgraded (toast)', state: run(pro, visit('/settings/billing'), act(ACTIONS.downgrade)), route: '/settings/billing', now: T0 },
  { name: 'todos empty', state: base, route: '/todos', now: T0 },
  {
    name: 'todos with items',
    state: run(base, visit('/todos'), act(ACTIONS.addTodo, { todo: 'Buy <milk> & "eggs"' }), act(ACTIONS.addTodo, { todo: 'Second' })),
    route: '/todos',
    now: T0 + 1234,
  },
  { name: 'forms/two', state: base, route: '/forms/two', now: T0 },
  { name: 'forms/two shipping saved', state: run(base, act(ACTIONS.submitShipping, { 'shipping.street': '1 "Main" St & Co' })), route: '/forms/two', now: T0 },
  { name: 'forms/two billing saved', state: run(base, act(ACTIONS.submitBilling, { 'billing.street': '2 Side St' })), route: '/forms/two', now: T0 },
  { name: 'slow loading', state: run(base, visit('/slow?ms=3000')), route: '/slow?ms=3000', now: T0 + 100 },
  { name: 'slow done', state: run(base, visit('/slow?ms=3000')), route: '/slow?ms=3000', now: T0 + 3000 },
  { name: 'notes', state: base, route: '/notes', now: T0 },
  { name: 'not found', state: base, route: '/missing', now: T0 },
];

describe('R-RN2: model/HTML parity (AC3) on role, name, level, states, value, url', () => {
  for (const c of cases) {
    it(`renderPage matches the model view: ${c.name}`, () => {
      const html = renderPage(c.state, c.route, c.now);
      const fromHtml = toAxNodes(html);
      const fromModel = uiToAxNodes(acmeModel.view(c.state, c.route, c.now));
      expect(fromHtml).toEqual(fromModel);
      expect(fromHtml.length).toBeGreaterThan(5);
    });
  }

  it('the secret password value is never in the HTML, even when typed into the model', () => {
    const s = run(base, { type: 'input', field: 'password', value: 'correct-horse-battery' });
    const html = renderPage(s, '/login', T0);
    expect(html).not.toContain('correct-horse-battery');
    expect(html).toContain('type="password"');
  });

  it('semantic markup follows SPEC 13.1 (native elements and ARIA roles)', () => {
    const billing = renderPage(run(base, visit('/settings/billing'), act(ACTIONS.upgrade), act(ACTIONS.confirmUpgrade)), '/settings/billing', T0);
    expect(billing).toContain('<nav aria-label="Primary">');
    expect(billing).toContain('<form method="post" action="/__act">');
    expect(billing).toContain('<section aria-label="Plan">');
    expect(billing).toContain('<p role="status">Plan: Pro</p>');
    expect(billing).toContain('name="__action" value="billing.downgrade"');
    const dialog = renderPage(run(base, visit('/settings/billing'), act(ACTIONS.upgrade)), '/settings/billing', T0);
    expect(dialog).toContain('<div role="dialog" aria-label="Confirm upgrade">');
    expect(renderPage(run(base, act(ACTIONS.loginSubmit, { password: 'x' })), '/login', T0)).toContain('<p role="alert">Invalid email or password</p>');
    expect(renderPage(base, '/todos', T0)).toContain('<ul aria-label="Todo items">');
    const slow = renderPage(run(base, visit('/slow?ms=3000')), '/slow?ms=3000', T0);
    expect(slow).toContain('<main aria-busy="true">');
    expect(slow).toContain('<div role="progressbar" aria-label="Loading"></div>');
    expect(renderPage(base, '/slow?ms=0', T0)).not.toContain('aria-busy');
  });

  it('inline JS exists only for /slow (swap) and /todos (sync clock)', () => {
    const scriptsOn = (state: AcmeState, route: string, now = T0): number => (renderPage(state, route, now).match(/<script>/g) ?? []).length;
    expect(scriptsOn(run(base, visit('/slow?ms=3000')), '/slow?ms=3000')).toBe(1);
    expect(scriptsOn(run(base, visit('/slow?ms=3000')), '/slow?ms=3000', T0 + 3000)).toBe(0);
    expect(scriptsOn(base, '/todos')).toBe(1);
    for (const r of ['/login', '/settings/billing', '/forms/two', '/notes', '/nope']) expect(scriptsOn(base, r), r).toBe(0);
  });

  it('the /slow swap script carries the finished markup and the remaining delay', () => {
    const s = run(base, visit('/slow?ms=3000'));
    const html = renderPage(s, '/slow?ms=3000', T0 + 1000);
    expect(html).toContain('Report ready');
    expect(html).toMatch(/,2000\);\}\)\(\);<\/script>/);
    // the script payload must not be able to close the script element early
    expect(html.split('</script>')).toHaveLength(2);
  });
});

describe('R-RN2: live HTTP server parity (cookie sessions, real GET/POST flow)', () => {
  let app: Awaited<ReturnType<typeof startAcmeApp>>;
  beforeAll(async () => {
    app = await startAcmeApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves every screen with the same accessibility structure as the model', async () => {
    const c = new Client(app.url);
    for (const route of ['/login', '/settings/billing', '/todos', '/forms/two', '/slow?ms=60000', '/notes']) {
      const res = await c.get(route);
      expect(res.status, route).toBe(200);
      const state = acmeModel.initialState();
      const model = acmeModel.view(run(state, visit(route)), route, route.startsWith('/todos') ? Date.now() : T0);
      const fromHtml = toAxNodes(res.text);
      const fromModel = uiToAxNodes(model);
      // The /todos sync status carries wall-clock time on the live server; compare it by shape.
      const norm = (n: { name: string }) => ({ ...n, name: n.name.replace(/\d\d:\d\d:\d\d\.\d{3}/, 'T') });
      expect(fromHtml.map(norm), route).toEqual(fromModel.map(norm));
    }
  });

  it('drives the billing upgrade through real form posts and keeps the toast after the redirect', async () => {
    const c = new Client(app.url);
    await c.get('/settings/billing');
    let res = await c.post('/__act', { __route: '/settings/billing', __action: ACTIONS.upgrade });
    expect(toAxNodes(res.text).some((n) => n.role === 'dialog' && n.name === 'Confirm upgrade')).toBe(true);
    res = await c.post('/__act', { __route: '/settings/billing', __action: ACTIONS.confirmUpgrade });
    const names = toAxNodes(res.text).map((n) => `${n.role}:${n.name}`);
    expect(names).toContain('status:Plan: Pro');
    expect(names).toContain('status:Upgraded to Pro');
    expect(names).toContain('paragraph:Next invoice: $12.50 (prorated)');
  });

  it('login with the admin password redirects to billing; a wrong one shows the alert', async () => {
    const c = new Client(app.url);
    let res = await c.post('/__act', { __route: '/login', __action: ACTIONS.loginSubmit, email: 'a@b.c', password: 'nope' });
    expect(toAxNodes(res.text).some((n) => n.role === 'alert' && n.name === 'Invalid email or password')).toBe(true);
    res = await c.post('/__act', { __route: '/login', __action: ACTIONS.loginSubmit, email: 'a@b.c', password: 'correct-horse-battery' });
    expect(res.url).toContain('/settings/billing');
    expect(toAxNodes(res.text).some((n) => n.role === 'heading' && n.name === 'Billing')).toBe(true);
    const again = await c.get('/login', false);
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/settings/billing');
  });
});
