import {
  AiBddError,
  type ActionOutcome,
  type AiBddErrorPayload,
  type DriverAction,
  type DriverCapabilities,
  type DriverSession,
  type JsonValue,
  type ObservedNode,
  type Observation,
  type Policy,
  type SessionOptions,
} from '@ai-bdd/sdk/contracts';
import { checkNavigation, renderTree, sha256Hex, treeHash } from '@ai-bdd/sdk';
import {
  DEFAULT_TEST_TOKEN,
  dispatch,
  initialState,
  isLoading,
  resolveRoute,
  view,
  type AcmeState,
  type UINode,
} from '../app/model.ts';
import { handleTestApi } from '../app/test-api.ts';
import { screenshotPng } from '../png.ts';

/** Fake clock origin: every session starts at 2026-01-01T09:00:00Z so runs are reproducible. */
export const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1, 9, 0, 0);
const DEFAULT_BASE = 'http://localhost';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_WAIT_MS = 600_000;

type Page = { kind: 'blank' } | { kind: 'app'; origin: string; route: string } | { kind: 'external'; url: string };

interface Entry {
  ui: UINode;
  depth: number;
  parent: number;
}

export interface FakeSessionConfig {
  id: string;
  driverId: string;
  driverVersion: string;
  capabilities: DriverCapabilities;
  options: SessionOptions;
  flags: readonly string[];
  adminPassword: string | undefined;
  clockStepMs: number;
  testToken: string;
  onClose(): void;
}

const keyOf = (ui: UINode): string => JSON.stringify([ui.role, ui.name, ui.action ?? null, ui.field ?? null]);

function flatten(nodes: readonly UINode[], depth = 0, parent = -1, out: Entry[] = []): Entry[] {
  for (const ui of nodes) {
    const index = out.length;
    out.push({ ui, depth, parent });
    flatten(ui.children ?? [], depth + 1, index, out);
  }
  return out;
}

const fail = (code: ConstructorParameters<typeof AiBddError>[0], message: string, details?: JsonValue): ActionOutcome => ({
  ok: false,
  error: new AiBddError(code, message, { retryable: false, ...(details === undefined ? {} : { details }) }).toPayload(),
});

function payloadOf(err: unknown): AiBddErrorPayload | undefined {
  return err instanceof AiBddError ? err.toPayload() : undefined;
}

export class FakeSession implements DriverSession {
  readonly id: string;
  readonly driverId: string;
  readonly driverVersion: string;
  readonly capabilities: DriverCapabilities;

  private readonly cfg: FakeSessionConfig;
  private readonly policy: Policy;
  private readonly base: URL;
  private state: AcmeState;
  private elapsed = 0;
  private revision = 0;
  private snapshot: Entry[] = [];
  private page: Page = { kind: 'blank' };
  private history: Page[] = [];
  private tainted = false;
  private closed = false;
  private focusedField: string | null = null;

  constructor(cfg: FakeSessionConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.driverId = cfg.driverId;
    this.driverVersion = cfg.driverVersion;
    this.capabilities = cfg.capabilities;
    this.policy = cfg.options.policy;
    this.base = new URL(cfg.options.baseURL ?? DEFAULT_BASE);
    this.state = initialState({ flags: cfg.flags, ...(cfg.adminPassword === undefined ? {} : { adminPassword: cfg.adminPassword }) });
  }

  /** Current fake time in ms since the epoch. */
  private get now(): number {
    return FAKE_EPOCH_MS + this.elapsed;
  }

  private assertOpen(): void {
    if (this.closed) throw new AiBddError('DRIVER_ERROR', `fake session ${this.id} is closed`, { retryable: false });
  }

  private currentUi(): UINode[] {
    switch (this.page.kind) {
      case 'blank':
        return [];
      case 'external':
        return [{ role: 'heading', name: 'External', level: 1 }];
      case 'app':
        return view(this.state, this.page.route, this.now);
    }
  }

  private currentRoute(): string {
    switch (this.page.kind) {
      case 'blank':
        return 'about:blank';
      case 'external': {
        const u = new URL(this.page.url);
        return u.pathname + u.search;
      }
      case 'app':
        return this.page.route;
    }
  }

  private currentUrl(): string {
    switch (this.page.kind) {
      case 'blank':
        return 'about:blank';
      case 'external':
        return this.page.url;
      case 'app':
        return this.page.origin + this.page.route;
    }
  }

  async observe(opts?: { pixels?: boolean }): Promise<Observation> {
    this.assertOpen();
    const ui = this.currentUi();
    const entries = flatten(ui);
    this.revision += 1;
    this.snapshot = entries;
    const nodes: ObservedNode[] = entries.map((e, i) => {
      const node: ObservedNode = {
        ref: `r${this.revision}:e${i + 1}`,
        role: e.ui.role,
        name: e.ui.name,
        states: {},
        depth: e.depth,
      };
      const s = e.ui.states;
      if (s !== undefined) {
        // `busy` is reported only on the observation (like the Playwright driver); `secret` is an app-internal marker.
        const { secret: _secret, busy: _busy, ...rest } = s;
        node.states = rest;
      }
      if (e.ui.value !== undefined && e.ui.states?.secret !== true) node.value = e.ui.value;
      if (e.ui.level !== undefined) node.level = e.ui.level;
      if (e.ui.href !== undefined) node.url = e.ui.href;
      if (e.parent >= 0) node.parentRef = `r${this.revision}:e${e.parent + 1}`;
      return node;
    });
    const hash = treeHash(nodes);
    const obs: Observation = {
      revision: this.revision,
      route: this.currentRoute(),
      url: this.currentUrl(),
      title: this.page.kind === 'external' ? 'External' : this.page.kind === 'blank' ? '' : 'Acme',
      nodes,
      busy: isLoading(ui),
      tainted: this.tainted,
      treeText: renderTree(nodes, { refs: true }),
      treeHash: hash,
    };
    if (opts?.pixels === true) {
      const png = screenshotPng(hash);
      obs.screenshot = { png, sha256: sha256Hex(png), masked: true };
    }
    this.elapsed += this.cfg.clockStepMs;
    return obs;
  }

  // ───────────────────────── navigation

  private isInternal(u: URL): boolean {
    return LOOPBACK.has(u.hostname.toLowerCase()) || u.host === this.base.host;
  }

  private visit(origin: string, route: string): void {
    let effective = route;
    for (let i = 0; i < 5; i += 1) {
      const next = resolveRoute(this.state, effective);
      if (next === effective) break;
      effective = next;
    }
    this.state = dispatch(this.state, { type: 'visit', route: effective }, this.now).state;
    this.focusedField = null;
    this.page = { kind: 'app', origin, route: effective };
  }

  private push(next: Page): void {
    this.history.push(this.page);
    if (this.history.length > 100) this.history.shift();
    this.page = next;
  }

  /** Navigates to an already policy-checked absolute URL. */
  private load(urlStr: string, depth = 0): ActionOutcome {
    const u = new URL(urlStr);
    if (!this.isInternal(u)) {
      this.push({ kind: 'external', url: u.toString() });
      this.focusedField = null;
      return { ok: true, navigatedTo: u.toString() };
    }
    if (u.pathname === '/__redirect' && depth < 5) {
      const to = u.searchParams.get('to');
      if (to !== null) {
        const check = checkNavigation(to, u.toString(), this.policy);
        if (!check.ok) return fail('POLICY_DENIED', `navigation blocked: ${check.reason}`, { url: to, reason: check.reason });
        return this.load(check.url, depth + 1);
      }
    }
    const before = this.page;
    this.history.push(before);
    if (this.history.length > 100) this.history.shift();
    this.visit(u.origin, u.pathname + u.search);
    return { ok: true, navigatedTo: this.currentUrl() };
  }

  private navigate(raw: string, relativeTo: string): ActionOutcome {
    const check = checkNavigation(raw, relativeTo, this.policy);
    if (!check.ok) return fail('POLICY_DENIED', `navigation blocked: ${check.reason}`, { url: raw, reason: check.reason });
    return this.load(check.url);
  }

  // ───────────────────────── perform

  private resolveTarget(ref: string): UINode | ActionOutcome {
    const m = /^r(\d+):e(\d+)$/.exec(ref);
    if (m === null) return fail('TARGET_NOT_FOUND', `unknown ref ${ref}`, { ref });
    if (Number(m[1]) !== this.revision) {
      return fail('STALE_REF', `ref ${ref} belongs to an older observation (current revision ${this.revision})`, { ref, revision: this.revision });
    }
    const idx = Number(m[2]) - 1;
    const seen = this.snapshot[idx];
    if (seen === undefined) return fail('TARGET_NOT_FOUND', `unknown ref ${ref}`, { ref });
    const key = keyOf(seen.ui);
    const occurrence = this.snapshot.slice(0, idx).filter((e) => keyOf(e.ui) === key).length;
    const current = flatten(this.currentUi()).filter((e) => keyOf(e.ui) === key)[occurrence];
    if (current === undefined) return fail('TARGET_NOT_FOUND', `element for ${ref} is no longer on the page`, { ref });
    return current.ui;
  }

  private runAction(ui: UINode, fields?: Record<string, string>): ActionOutcome {
    const action = ui.action;
    if (action === undefined) return { ok: true };
    const out = dispatch(this.state, { type: 'action', action, ...(fields === undefined ? {} : { fields }) }, this.now);
    this.state = out.state;
    if (out.redirect !== undefined && this.page.kind === 'app') {
      this.history.push(this.page);
      this.visit(this.page.origin, out.redirect);
      return { ok: true, navigatedTo: this.currentUrl() };
    }
    return { ok: true };
  }

  private firstActionNode(): UINode | undefined {
    return flatten(this.currentUi()).find((e) => e.ui.action !== undefined)?.ui;
  }

  async perform(action: DriverAction): Promise<ActionOutcome> {
    this.assertOpen();
    if (this.policy.denyVerbs.includes(action.verb)) {
      return fail('POLICY_DENIED', `verb ${action.verb} is denied by policy`, { verb: action.verb });
    }
    switch (action.verb) {
      case 'navigate':
        return this.navigate(action.url, this.base.toString());
      case 'back': {
        const prev = this.history.pop();
        if (prev === undefined) return { ok: true };
        this.page = prev;
        if (prev.kind === 'app') this.visit(prev.origin, prev.route);
        return { ok: true, navigatedTo: this.currentUrl() };
      }
      case 'wait': {
        const ms = Number.isFinite(action.ms) ? Math.max(0, Math.min(action.ms, MAX_WAIT_MS)) : 0;
        this.elapsed += ms;
        return { ok: true };
      }
      case 'scroll': {
        if (action.target === undefined) return { ok: true };
        const t = this.resolveTarget(action.target.ref);
        return 'ok' in t ? t : { ok: true };
      }
      case 'hover': {
        const t = this.resolveTarget(action.target.ref);
        return 'ok' in t ? t : { ok: true };
      }
      case 'click': {
        const t = this.resolveTarget(action.target.ref);
        if ('ok' in t) return t;
        if (t.states?.disabled === true) return fail('TARGET_NOT_FOUND', `"${t.name}" is disabled`);
        if (t.role === 'textbox' && t.field !== undefined) this.focusedField = t.field;
        if (t.role === 'link' && t.href !== undefined) {
          if (t.href.startsWith('#')) return { ok: true };
          return this.navigate(t.href, this.currentUrl());
        }
        return this.runAction(t);
      }
      case 'fill': {
        const t = this.resolveTarget(action.target.ref);
        if ('ok' in t) return t;
        if (t.role !== 'textbox' || t.field === undefined) return fail('TARGET_NOT_FOUND', `"${t.name}" is not a text field`);
        if (t.states?.disabled === true) return fail('TARGET_NOT_FOUND', `"${t.name}" is disabled`);
        let value: string;
        try {
          value = this.cfg.options.resolveValue(action.value);
        } catch (err) {
          const payload = payloadOf(err);
          if (payload === undefined) throw err;
          return { ok: false, error: payload };
        }
        this.state = dispatch(this.state, { type: 'input', field: t.field, value }, this.now).state;
        this.focusedField = t.field;
        if ('secret' in action.value) this.tainted = true;
        return { ok: true };
      }
      case 'press': {
        let field = this.focusedField;
        if (action.target !== undefined) {
          const t = this.resolveTarget(action.target.ref);
          if ('ok' in t) return t;
          field = t.role === 'textbox' ? (t.field ?? null) : null;
        }
        if (action.key === 'Enter' && field !== null) {
          const submit = this.firstActionNode();
          return submit === undefined ? { ok: true } : this.runAction(submit);
        }
        return { ok: true };
      }
      case 'select': {
        const t = this.resolveTarget(action.target.ref);
        return 'ok' in t ? t : fail('TARGET_NOT_FOUND', `"${t.name}" is not a select element`);
      }
      case 'check': {
        const t = this.resolveTarget(action.target.ref);
        return 'ok' in t ? t : fail('TARGET_NOT_FOUND', `"${t.name}" is not a checkbox`);
      }
    }
  }

  async request(req: { method: string; path: string; headers?: Record<string, string>; body?: JsonValue }): Promise<{ status: number; body: JsonValue | string }> {
    this.assertOpen();
    let path = req.path;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
      const check = checkNavigation(path, this.base.toString(), this.policy);
      if (!check.ok) throw new AiBddError('POLICY_DENIED', `request blocked: ${check.reason}`, { retryable: false });
      const u = new URL(check.url);
      path = u.pathname + u.search;
    }
    const res = handleTestApi(
      { method: req.method, path, headers: req.headers, body: req.body },
      { testToken: this.cfg.testToken || DEFAULT_TEST_TOKEN, state: this.state, now: this.now },
    );
    if (res.state !== undefined) this.state = res.state;
    return { status: res.status, body: res.body };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cfg.onClose();
  }
}
