/**
 * A tiny in-memory driver that renders the Acme screens needed by the conformance kit. It exists only
 * to prove the kit itself works (and fails when a driver misbehaves); the real fixture app and the
 * real fake driver live in @ai-bdd/testing.
 */
// @ts-nocheck

import type {
  ActionOutcome,
  Driver,
  DriverAction,
  DriverCapabilities,
  DriverFactory,
  DriverSession,
  JsonValue,
  Observation,
  ObservedNode,
  Policy,
  SessionOptions,
} from '../../src/contracts/index.ts';
import { checkNavigation, sha256Hex } from '../../src/util/index.ts';
import { buildObservation, toNodes, type NodeSpec } from '../runner/doubles/world.ts';

export interface MiniAcmeFaults {
  /** Accept stale refs instead of rejecting them. */
  acceptStaleRefs?: boolean;
  /** Skip the navigation policy entirely. */
  skipPolicy?: boolean;
  /** Share todos between sessions. */
  shareState?: boolean;
  /** Never taint. */
  neverTaint?: boolean;
  /** Expose the typed password as the textbox value. */
  leakPassword?: boolean;
  /** Never report busy. */
  neverBusy?: boolean;
}

interface State {
  route: string;
  query: URLSearchParams;
  revision: number;
  clock: number;
  slowUntil: number;
  tainted: boolean;
  fields: Record<string, string>;
  todos: string[];
  plan: 'free' | 'pro';
  alert: boolean;
  external: boolean;
}

const NAV: NodeSpec[] = [
  { role: 'navigation', name: 'Primary' },
  { role: 'link', name: 'Billing', depth: 1 },
  { role: 'link', name: 'Todos', depth: 1 },
  { role: 'link', name: 'Checkout', depth: 1 },
  { role: 'link', name: 'Release notes', depth: 1 },
];

function view(s: State, faults: MiniAcmeFaults): NodeSpec[] {
  if (s.external) return [{ role: 'heading', name: 'External', level: 1 }];
  const page: NodeSpec[] = [];
  switch (s.route) {
    case '/login':
      page.push({ role: 'heading', name: 'Sign in', level: 1 });
      page.push({ role: 'textbox', name: 'Email', value: s.fields.Email ?? '' });
      page.push({ role: 'textbox', name: 'Password', value: faults.leakPassword ? (s.fields.Password ?? '') : '' });
      page.push({ role: 'button', name: 'Sign in' });
      if (s.alert) page.push({ role: 'alert', name: 'Invalid email or password' });
      break;
    case '/todos':
      page.push({ role: 'heading', name: 'Todos', level: 1 });
      page.push({ role: 'textbox', name: 'New todo', value: s.fields['New todo'] ?? '' });
      page.push({ role: 'button', name: 'Add' });
      page.push({ role: 'list', name: 'Todo items' });
      for (const t of s.todos) page.push({ role: 'listitem', name: `${t} — added 10:00:00`, depth: 1 });
      break;
    case '/settings/billing':
      page.push({ role: 'heading', name: 'Billing', level: 1 });
      page.push({ role: 'region', name: 'Plan' });
      page.push({ role: 'status', name: s.plan === 'pro' ? 'Plan: Pro' : 'Plan: Free', depth: 1 });
      page.push({ role: 'button', name: s.plan === 'pro' ? 'Downgrade to Free' : 'Upgrade to Pro', depth: 1 });
      break;
    case '/forms/two':
      page.push({ role: 'heading', name: 'Checkout', level: 1 });
      page.push({ role: 'region', name: 'Shipping' });
      page.push({ role: 'textbox', name: 'Street', depth: 1 });
      page.push({ role: 'button', name: 'Submit', depth: 1 });
      page.push({ role: 'region', name: 'Billing address' });
      page.push({ role: 'textbox', name: 'Street', depth: 1 });
      page.push({ role: 'button', name: 'Submit', depth: 1 });
      break;
    case '/slow':
      if (s.clock < s.slowUntil) page.push({ role: 'progressbar', name: 'Loading' });
      else page.push({ role: 'heading', name: 'Report ready', level: 1 });
      break;
    default:
      page.push({ role: 'heading', name: 'Not found', level: 1 });
  }
  return [...NAV, ...page];
}

class MiniSession implements DriverSession {
  readonly id: string;
  readonly driverId = 'mini-acme';
  readonly driverVersion = '1.0.0';
  readonly capabilities: DriverCapabilities;
  private readonly s: State;
  private readonly opts: SessionOptions;
  private readonly faults: MiniAcmeFaults;
  private readonly shared: string[] | undefined;
  private nodes: ObservedNode[] = [];

  constructor(id: string, caps: DriverCapabilities, opts: SessionOptions, faults: MiniAcmeFaults, shared: string[] | undefined) {
    this.id = id;
    this.capabilities = caps;
    this.opts = opts;
    this.faults = faults;
    this.shared = shared;
    this.s = {
      route: '/',
      query: new URLSearchParams(),
      revision: 0,
      clock: 0,
      slowUntil: 0,
      tainted: false,
      fields: {},
      todos: shared ?? [],
      plan: 'free',
      alert: false,
      external: false,
    };
  }

  observe(opts?: { pixels?: boolean }): Promise<Observation> {
    this.s.revision += 1;
    this.s.clock += 100;
    const rev = this.s.revision;
    const base = toNodes(view(this.s, this.faults));
    this.nodes = base.map((n) => {
      const out: ObservedNode = { ...n, ref: `r${rev}:${n.ref}` };
      if (n.parentRef !== undefined) out.parentRef = `r${rev}:${n.parentRef}`;
      return out;
    });
    const busy = this.faults.neverBusy ? false : this.s.route === '/slow' && this.s.clock < this.s.slowUntil;
    return Promise.resolve(
      buildObservation(this.nodes, { route: this.s.external ? '/' : this.s.route + (this.s.query.size > 0 ? `?${this.s.query.toString()}` : ''), revision: rev, busy, tainted: this.s.tainted, pixels: opts?.pixels === true, masked: true }),
    );
  }

  private deny(message: string): ActionOutcome {
    return { ok: false, error: { code: 'POLICY_DENIED', message, retryable: false } };
  }

  perform(action: DriverAction): Promise<ActionOutcome> {
    if (this.opts.policy.denyVerbs.includes(action.verb)) return Promise.resolve(this.deny(`verb ${action.verb} is denied`));
    if (action.verb === 'navigate') return Promise.resolve(this.navigate(action.url));
    if (action.verb === 'back' || action.verb === 'wait' || action.verb === 'scroll' || action.verb === 'press') return Promise.resolve({ ok: true });
    const ref = action.target?.ref;
    if (ref === undefined) return Promise.resolve({ ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'no target', retryable: false } });
    const m = /^r(\d+):/.exec(ref);
    if (m === null || (Number(m[1]) !== this.s.revision && !this.faults.acceptStaleRefs)) {
      return Promise.resolve({ ok: false, error: { code: 'STALE_REF', message: `stale ref ${ref}`, retryable: false } });
    }
    const node = this.nodes.find((n) => n.ref === ref) ?? this.nodes.find((n) => n.ref.endsWith(ref.slice(ref.indexOf(':'))));
    if (node === undefined) return Promise.resolve({ ok: false, error: { code: 'TARGET_NOT_FOUND', message: `no node ${ref}`, retryable: false } });
    if (action.verb === 'fill') {
      const value = this.opts.resolveValue(action.value);
      if ('secret' in action.value && !this.faults.neverTaint) this.s.tainted = true;
      this.s.fields[node.name] = value;
    } else if (action.verb === 'click') {
      this.click(node);
    }
    return Promise.resolve({ ok: true });
  }

  private click(node: ObservedNode): void {
    if (node.role === 'button' && node.name === 'Add') {
      const text = this.s.fields['New todo'];
      if (text) this.s.todos.push(text);
      this.s.fields['New todo'] = '';
    } else if (node.role === 'button' && node.name === 'Sign in') {
      if (this.s.fields.Password === 'correct-horse-battery') this.s.route = '/settings/billing';
      else this.s.alert = true;
    } else if (node.role === 'link') {
      const to: Record<string, string> = { Billing: '/settings/billing', Todos: '/todos', Checkout: '/forms/two', 'Release notes': '/notes' };
      this.s.route = to[node.name] ?? this.s.route;
    }
  }

  private navigate(raw: string): ActionOutcome {
    if (!this.faults.skipPolicy) {
      const check = checkNavigation(raw, this.opts.baseURL, this.opts.policy);
      if (!check.ok) return this.deny(check.reason);
      raw = check.url;
    }
    const url = new URL(raw, this.opts.baseURL);
    const appHost = this.opts.baseURL === undefined ? undefined : new URL(this.opts.baseURL).host;
    this.s.external = appHost !== undefined && url.host !== appHost;
    this.s.route = url.pathname;
    this.s.query = url.searchParams;
    if (url.pathname === '/slow') this.s.slowUntil = this.s.clock + Number(url.searchParams.get('ms') ?? '0');
    return { ok: true };
  }

  request(req: { method: string; path: string; headers?: Record<string, string>; body?: JsonValue }): Promise<{ status: number; body: JsonValue | string }> {
    if (req.path === '/__test/seed' && req.method === 'POST') {
      if (req.headers?.['x-acme-test-token'] !== 'acme-test') return Promise.resolve({ status: 401, body: 'missing token' });
      const body = req.body as { plan?: 'free' | 'pro' } | null;
      if (body?.plan !== undefined) this.s.plan = body.plan;
      return Promise.resolve({ status: 200, body: { ok: true } });
    }
    return Promise.resolve({ status: 404, body: 'not found' });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function miniAcme(faults: MiniAcmeFaults = {}): DriverFactory {
  const shared: string[] = [];
  return {
    id: 'mini-acme',
    create: (ctx: { policy: Policy }) => {
      void ctx;
      let n = 0;
      const caps: DriverCapabilities = { verbs: ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'], pixels: true, maskingProven: true, request: true, maxSessions: 8 };
      const driver: Driver = {
        id: 'mini-acme',
        version: '1.0.0',
        capabilities: caps,
        openSession: (opts) => {
          n += 1;
          return Promise.resolve(new MiniSession(`mini-${n}-${sha256Hex(opts.scenarioId).slice(0, 4)}`, caps, opts, faults, faults.shareState ? shared : undefined));
        },
        selfCheck: () => Promise.resolve({ ok: true, problems: [] }),
        dispose: () => Promise.resolve(),
      };
      return Promise.resolve(driver);
    },
  };
}
