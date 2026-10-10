import { AiBddError } from '@ai-bdd/sdk/contracts';
import type {
  ActionOutcome, AiBddErrorPayload, DriverAction, DriverCapabilities, DriverSession, JsonValue, ObservedNode, Observation,
  Policy, SessionOptions, ValueSource, Verb,
} from '@ai-bdd/sdk/contracts';
import { checkNavigation, renderTree, sha256Hex, treeHash, uuidv7 } from '@ai-bdd/sdk';
import type { BrowserContext, Frame, Locator, Page, Route } from 'playwright-core';
import { parseAriaSnapshot, pruneWrappers } from './aria.ts';

export const DRIVER_ID = 'playwright';
/** Bump when the observation grammar or ref scheme changes (recordings key on it). */
export const DRIVER_VERSION = '1.0.0';
/** Policy-independent upper bound for the `wait` verb. */
export const MAX_WAIT_MS = 5000;
const SCROLL_DELTA = 600;
const ALL_VERBS: Verb[] = ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'];

export const CAPABILITIES: DriverCapabilities = {
  verbs: ALL_VERBS, pixels: true, maskingProven: true, request: true, maxSessions: 8,
};

/** Elements whose content must never reach an observation, screenshot or log. */
export const SECRET_SELECTOR = 'input[type=password], [data-ai-bdd-secret]';
const BUSY_EXPRESSION = '!!document.querySelector(\'[aria-busy="true"],[role="progressbar"],progress\')';
const SECRET_MATCH_FN = `el => el.closest(${JSON.stringify(SECRET_SELECTOR)}) !== null`;
const SECRET_TEXTS_EXPRESSION = `[...document.querySelectorAll('[data-ai-bdd-secret]')].map(e => ('value' in e && typeof e.value === 'string' && e.value) || e.textContent || '')`;
const ARIA_REF = /^(?:f\d+)?e\d+$/;
const REVISIONED = /^r(\d+):(.+)$/;
const MIN_SECRET_REPLACE_LENGTH = 4;

export interface SessionInternals {
  /** Close the context on `close()` (sessions created by the driver) or leave it alone (`sessionFromPage`). */
  ownsContext: boolean;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
}

type Target =
  | { kind: 'aria'; id: string }
  | { kind: 'role'; role: string; name: string; nth: number };

interface Denial { url: string; reason: string }

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function errorPayload(code: AiBddErrorPayload['code'], message: string, retryable?: boolean, details?: JsonValue): AiBddErrorPayload {
  return new AiBddError(code, message, {
    ...(retryable === undefined ? {} : { retryable }),
    ...(details === undefined ? {} : { details }),
  }).toPayload();
}

function failure(code: AiBddErrorPayload['code'], message: string, retryable?: boolean, details?: JsonValue): ActionOutcome {
  return { ok: false, error: errorPayload(code, message, retryable, details) };
}

function routeOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.pathname}${u.search}`;
  } catch {
    // fall through
  }
  return url;
}

function isClosedError(msg: string): boolean {
  return /Target (page, context or browser|closed)|has been closed|Browser has been closed|browser.*disconnected/i.test(msg);
}

export class PlaywrightSession implements DriverSession {
  readonly id = uuidv7();
  readonly driverId = DRIVER_ID;
  readonly driverVersion = DRIVER_VERSION;
  readonly capabilities = CAPABILITIES;

  private readonly page: Page;
  private readonly context: BrowserContext;
  private readonly policy: Policy;
  private readonly baseURL: string | undefined;
  private readonly resolveValue: (v: ValueSource) => string;
  private readonly internals: SessionInternals;
  private readonly actionTimeout: number;
  private readonly navTimeout: number;
  private revision = 0;
  private targets = new Map<string, Target>();
  private tainted = false;
  private closed = false;
  private readonly secrets = new Set<string>();
  private readonly denials: Denial[] = [];
  private readonly onClose: (() => void) | undefined;
  private readonly routeHandler: (route: Route) => Promise<void>;
  private readonly pageHandler: (p: Page) => void;
  private readonly navHandler: (f: Frame) => void;

  constructor(page: Page, opts: SessionOptions, ctx: { policy: Policy; baseURL?: string }, internals: SessionInternals, onClose?: () => void) {
    this.page = page;
    this.context = page.context();
    this.policy = ctx.policy;
    this.baseURL = ctx.baseURL ?? opts.baseURL;
    this.resolveValue = opts.resolveValue;
    this.internals = internals;
    this.actionTimeout = internals.actionTimeoutMs ?? 5000;
    this.navTimeout = internals.navigationTimeoutMs ?? 15_000;
    this.onClose = onClose;

    this.routeHandler = async (route: Route): Promise<void> => {
      try {
        const req = route.request();
        let topLevel = false;
        let framePage: Page | undefined;
        try {
          const frame = req.frame();
          topLevel = req.isNavigationRequest() && frame.parentFrame() === null;
          framePage = frame.page();
        } catch {
          // service-worker or detached requests have no frame
        }
        if (topLevel) {
          const verdict = checkNavigation(req.url(), undefined, this.policy);
          if (!verdict.ok) {
            this.denials.push({ url: req.url(), reason: verdict.reason });
            await route.abort('blockedbyclient');
            if (framePage !== undefined && framePage !== this.page) await framePage.close().catch(() => undefined);
            return;
          }
        }
        await route.continue();
      } catch {
        // page or context closed while routing
      }
    };
    this.pageHandler = (popup: Page): void => {
      if (popup === this.page) return;
      void this.vetPopup(popup);
    };
    this.navHandler = (frame: Frame): void => {
      if (frame !== this.page.mainFrame()) return;
      void this.guardMainFrame(frame.url());
    };
  }

  async install(): Promise<void> {
    await this.context.route('**/*', this.routeHandler);
    this.context.on('page', this.pageHandler);
    this.page.on('framenavigated', this.navHandler);
  }

  // ───────────────────────── policy helpers

  private async vetPopup(popup: Page): Promise<void> {
    const allowed = (): boolean => {
      const u = popup.url();
      return u === '' || u === 'about:blank' || checkNavigation(u, undefined, this.policy).ok;
    };
    if (!allowed()) {
      this.denials.push({ url: popup.url(), reason: 'popup to a disallowed URL' });
      await popup.close().catch(() => undefined);
      return;
    }
    popup.on('framenavigated', (f) => {
      if (f !== popup.mainFrame()) return;
      if (!allowed()) {
        this.denials.push({ url: popup.url(), reason: 'popup navigated to a disallowed URL' });
        void popup.close().catch(() => undefined);
      }
    });
  }

  private async guardMainFrame(url: string): Promise<void> {
    if (this.closed || url === 'about:blank' || url === '') return;
    if (checkNavigation(url, undefined, this.policy).ok) return;
    if (!url.startsWith('chrome-error:')) this.denials.push({ url, reason: 'main frame navigated to a disallowed URL' });
    await this.page.goto('about:blank', { timeout: this.navTimeout }).catch(() => undefined);
  }

  // ───────────────────────── observe

  private async snapshotText(): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (isClosedError(msg) || !/context was destroyed|navigat|detached/i.test(msg)) break;
        await new Promise<void>((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  private async isBusy(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return (await this.page.evaluate(BUSY_EXPRESSION)) === true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isClosedError(msg)) throw err;
        await new Promise<void>((r) => setTimeout(r, 30));
      }
    }
    // The document is navigating: treat it as busy so callers keep polling.
    return true;
  }

  private locatorFor(target: Target): Locator {
    if (target.kind === 'aria') return this.page.getByRef(target.id);
    if (target.role === 'text') return this.page.getByText(target.name, { exact: true }).nth(target.nth);
    const role = target.role as Parameters<Page['getByRole']>[0];
    return (target.name.length > 0 ? this.page.getByRole(role, { name: target.name, exact: true }) : this.page.getByRole(role)).nth(target.nth);
  }

  private async isSecretElement(target: Target): Promise<boolean> {
    try {
      return (await this.locatorFor(target).evaluate(SECRET_MATCH_FN, undefined, { timeout: 1500 })) === true;
    } catch {
      return true; // fail closed
    }
  }

  private scrub(text: string, secretTexts: readonly string[]): string {
    let out = text;
    for (const s of [...this.secrets, ...secretTexts]) {
      if (s.length >= MIN_SECRET_REPLACE_LENGTH && out.includes(s)) out = out.split(s).join('[secret]');
    }
    return out;
  }

  async observe(opts?: { pixels?: boolean }): Promise<Observation> {
    this.assertOpen();
    try {
      const revision = ++this.revision;
      const text = await this.snapshotText();
      const raw = parseAriaSnapshot(text);

      const counts = new Map<string, number>();
      const targets = new Map<string, Target>();
      for (const n of raw) {
        const key = `${n.role}\u0000${n.name}`;
        const nth = counts.get(key) ?? 0;
        counts.set(key, nth + 1);
        targets.set(n.ref, ARIA_REF.test(n.ref) ? { kind: 'aria', id: n.ref } : { kind: 'role', role: n.role, name: n.name, nth });
      }
      const pruned = pruneWrappers(raw);

      // Secret hygiene (V4): the snapshot exposes password values, so strip them at the source.
      let secretTexts: string[] = [];
      try {
        const found = (await this.page.evaluate(SECRET_TEXTS_EXPRESSION)) as unknown;
        if (Array.isArray(found)) secretTexts = found.filter((s): s is string => typeof s === 'string');
      } catch {
        secretTexts = [];
      }
      const candidates = pruned.filter((n) => n.value !== undefined && n.value.length > 0);
      const flags = await Promise.all(candidates.map(async (n) => {
        const t = targets.get(n.ref);
        return t === undefined ? true : this.isSecretElement(t);
      }));
      const secretRefs = new Set<string>();
      candidates.forEach((n, i) => { if (flags[i] === true) secretRefs.add(n.ref); });
      // An empty password field also gets `value` removed so password nodes are uniform.
      const passwordLike = await Promise.all(pruned
        .filter((n) => n.role === 'textbox' && n.value === '' && ARIA_REF.test(n.ref))
        .map(async (n) => ((await this.isSecretElement(targets.get(n.ref) as Target)) ? n.ref : undefined)));
      for (const r of passwordLike) if (r !== undefined) secretRefs.add(r);

      const prefix = (ref: string): string => `r${revision}:${ref}`;
      const nodes: ObservedNode[] = pruned.map((n) => {
        const out: ObservedNode = { ...n, ref: prefix(n.ref) };
        if (n.parentRef !== undefined) out.parentRef = prefix(n.parentRef);
        if (secretRefs.has(n.ref)) delete out.value;
        else if (out.value !== undefined) out.value = this.scrub(out.value, secretTexts);
        out.name = this.scrub(out.name, secretTexts);
        if (out.text !== undefined) out.text = this.scrub(out.text, secretTexts);
        return out;
      });
      this.targets = targets;

      const [busy, title] = await Promise.all([this.isBusy(), this.page.title().catch(() => '')]);
      const url = this.page.url();
      const obs: Observation = {
        revision, route: routeOf(url), url, nodes, busy, tainted: this.tainted,
        treeText: renderTree(nodes, { refs: true }), treeHash: treeHash(nodes),
      };
      if (title.length > 0) obs.title = title;
      if (opts?.pixels === true) {
        const buf = await this.page.screenshot({
          type: 'png', animations: 'disabled', caret: 'hide', mask: [this.page.locator(SECRET_SELECTOR)],
        });
        const png = new Uint8Array(buf);
        obs.screenshot = { png, sha256: sha256Hex(png), masked: true };
      }
      return obs;
    } catch (err) {
      throw this.asThrown(err);
    }
  }

  // ───────────────────────── perform

  private parseRef(ref: string): { target: Target } | { error: ActionOutcome } {
    const m = REVISIONED.exec(ref);
    if (m === null) return { error: failure('STALE_REF', `ref ${JSON.stringify(ref)} is not of the form r<revision>:<id>; use a ref from the latest observation`, false) };
    const rev = Number(m[1]);
    if (rev !== this.revision) {
      return { error: failure('STALE_REF', `ref ${JSON.stringify(ref)} belongs to revision ${rev} but the latest observation is revision ${this.revision}`, false) };
    }
    const target = this.targets.get(m[2] as string);
    if (target === undefined) return { error: failure('TARGET_NOT_FOUND', `ref ${JSON.stringify(ref)} is not in the latest observation`, false) };
    return { target };
  }

  private sanitize(err: unknown): string {
    let msg = err instanceof Error ? err.message : String(err);
    msg = (msg.split('\n')[0] ?? '').replace(ANSI, '');
    for (const s of this.secrets) if (s.length > 0) msg = msg.split(s).join('***');
    return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
  }

  private asThrown(err: unknown): AiBddError {
    if (err instanceof AiBddError) return err;
    const msg = this.sanitize(err);
    return new AiBddError(isClosedError(msg) ? 'DRIVER_UNAVAILABLE' : 'DRIVER_ERROR', msg, { cause: err });
  }

  private async classify(err: unknown, locator?: Locator): Promise<ActionOutcome> {
    const msg = this.sanitize(err);
    if (isClosedError(msg)) return failure('DRIVER_UNAVAILABLE', msg);
    const name = err instanceof Error ? err.name : '';
    if (locator !== undefined && (name === 'TimeoutError' || /waiting for|not found/i.test(msg))) {
      const n = await locator.count().catch(() => -1);
      if (n === 0) return failure('TARGET_NOT_FOUND', `target element no longer exists (${msg})`, false);
      if (n > 1) return failure('TARGET_NOT_FOUND', `target is ambiguous: ${n} elements match (${msg})`, false);
    }
    if (name === 'TimeoutError') return failure('DRIVER_ERROR', `timed out: ${msg}`);
    return failure('DRIVER_ERROR', msg);
  }

  private newDenial(since: number): Denial | undefined {
    return this.denials.length > since ? this.denials[this.denials.length - 1] : undefined;
  }

  private async recoverFromErrorPage(): Promise<void> {
    if (this.page.url().startsWith('chrome-error:')) await this.page.goto('about:blank', { timeout: this.navTimeout }).catch(() => undefined);
  }

  async perform(action: DriverAction): Promise<ActionOutcome> {
    if (this.closed) return failure('DRIVER_UNAVAILABLE', 'session is closed');
    if (this.policy.denyVerbs.includes(action.verb)) return failure('POLICY_DENIED', `verb ${action.verb} is denied by policy`, false);
    if (!ALL_VERBS.includes(action.verb)) return failure('VERB_UNSUPPORTED', `verb ${String((action as { verb: unknown }).verb)} is not supported`, false);

    let locator: Locator | undefined;
    const targetRef = 'target' in action && action.target !== undefined ? action.target.ref : undefined;
    if (targetRef !== undefined) {
      const parsed = this.parseRef(targetRef);
      if ('error' in parsed) return parsed.error;
      locator = this.locatorFor(parsed.target);
    }

    const urlBefore = this.page.url();
    const deniedBefore = this.denials.length;
    const timeout = this.actionTimeout;
    try {
      switch (action.verb) {
        case 'navigate': {
          const verdict = checkNavigation(action.url, this.baseURL, this.policy);
          if (!verdict.ok) {
            this.denials.push({ url: action.url, reason: verdict.reason });
            return failure('POLICY_DENIED', `navigation to ${JSON.stringify(action.url)} denied: ${verdict.reason}`, false, { url: action.url, reason: verdict.reason });
          }
          try {
            await this.page.goto(verdict.url, { waitUntil: 'load', timeout: this.navTimeout });
          } catch (err) {
            const denied = this.newDenial(deniedBefore);
            await this.recoverFromErrorPage();
            if (denied !== undefined) return failure('POLICY_DENIED', `navigation blocked: ${denied.reason} (${denied.url})`, false, { url: denied.url, reason: denied.reason });
            return await this.classify(err);
          }
          break;
        }
        case 'click':
          await (locator as Locator).click({ timeout });
          break;
        case 'hover':
          await (locator as Locator).hover({ timeout });
          break;
        case 'fill': {
          const value = this.resolveValue(action.value);
          if ('secret' in action.value) {
            this.tainted = true; // set before the fill so a failing fill still taints
            if (value.length > 0) this.secrets.add(value);
          }
          await (locator as Locator).fill(value, { timeout });
          break;
        }
        case 'press':
          if (locator === undefined) await this.page.keyboard.press(action.key);
          else await locator.press(action.key, { timeout });
          break;
        case 'select': {
          const option = this.resolveValue(action.option);
          if ('secret' in action.option) {
            this.tainted = true;
            if (option.length > 0) this.secrets.add(option);
          }
          await (locator as Locator).selectOption(option, { timeout });
          break;
        }
        case 'check':
          await (locator as Locator).setChecked(action.checked, { timeout });
          break;
        case 'scroll': {
          if (locator !== undefined) await locator.hover({ timeout });
          await this.page.mouse.wheel(0, action.direction === 'down' ? SCROLL_DELTA : -SCROLL_DELTA);
          break;
        }
        case 'back': {
          const res = await this.page.goBack({ timeout: this.navTimeout, waitUntil: 'load' });
          if (res === null && this.page.url() === urlBefore) return failure('TARGET_NOT_FOUND', 'there is no earlier history entry to go back to', false);
          break;
        }
        case 'wait': {
          const ms = Number.isFinite(action.ms) ? Math.min(Math.max(0, action.ms), MAX_WAIT_MS) : 0;
          await this.page.waitForTimeout(ms);
          break;
        }
      }
    } catch (err) {
      const denied = this.newDenial(deniedBefore);
      if (denied !== undefined) return failure('POLICY_DENIED', `navigation blocked: ${denied.reason} (${denied.url})`, false, { url: denied.url, reason: denied.reason });
      return await this.classify(err, locator);
    }

    if (action.verb !== 'wait' && action.verb !== 'navigate') await new Promise<void>((r) => setTimeout(r, 60));
    const denied = this.newDenial(deniedBefore);
    if (denied !== undefined) {
      await this.recoverFromErrorPage();
      return failure('POLICY_DENIED', `navigation blocked: ${denied.reason} (${denied.url})`, false, { url: denied.url, reason: denied.reason });
    }
    const urlAfter = this.page.url();
    return urlAfter !== urlBefore ? { ok: true, navigatedTo: urlAfter } : { ok: true };
  }

  // ───────────────────────── request

  async request(req: { method: string; path: string; headers?: Record<string, string>; body?: JsonValue }): Promise<{ status: number; body: JsonValue | string }> {
    this.assertOpen();
    let url: URL;
    try {
      url = new URL(req.path, this.baseURL);
    } catch {
      throw new AiBddError('DRIVER_ERROR', `cannot resolve request path ${JSON.stringify(req.path)} without a baseURL`, { retryable: false });
    }
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let data: string | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === 'string') data = req.body;
      else {
        data = JSON.stringify(req.body);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
    }
    let method = req.method.toUpperCase();
    try {
      for (let hop = 0; hop <= 5; hop += 1) {
        const verdict = checkNavigation(url.toString(), undefined, this.policy);
        if (!verdict.ok) throw new AiBddError('POLICY_DENIED', `request to ${url.toString()} denied: ${verdict.reason}`, { details: { url: url.toString(), reason: verdict.reason } });
        const res = await this.context.request.fetch(verdict.url, {
          method, headers, ...(data === undefined ? {} : { data }), maxRedirects: 0, timeout: this.navTimeout, failOnStatusCode: false,
        });
        const loc = res.headers()['location'];
        if ([301, 302, 303, 307, 308].includes(res.status()) && loc !== undefined && hop < 5) {
          url = new URL(loc, url);
          if (res.status() === 303 || ((res.status() === 301 || res.status() === 302) && method === 'POST')) { method = 'GET'; data = undefined; }
          continue;
        }
        const text = await res.text();
        const type = res.headers()['content-type'] ?? '';
        if (/json/i.test(type)) {
          try { return { status: res.status(), body: JSON.parse(text) as JsonValue }; } catch { /* fall through to text */ }
        }
        return { status: res.status(), body: text };
      }
      throw new AiBddError('DRIVER_ERROR', 'too many redirects', { retryable: false });
    } catch (err) {
      throw this.asThrown(err);
    }
  }

  // ───────────────────────── lifecycle

  private assertOpen(): void {
    if (this.closed) throw new AiBddError('DRIVER_UNAVAILABLE', 'session is closed');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.page.off('framenavigated', this.navHandler);
    this.context.off('page', this.pageHandler);
    try {
      if (this.internals.ownsContext) await this.context.close();
      else await this.context.unroute('**/*', this.routeHandler);
    } catch {
      // already closed
    } finally {
      this.onClose?.();
    }
  }
}
