import { AiBddError } from '@ai-bdd/sdk/contracts';
import type {
  ActionOutcome, AiBddErrorPayload, DriverAction, DriverCapabilities, DriverSession, JsonValue, Observation, Policy,
  SessionOptions, ValueSource, Verb,
} from '@ai-bdd/sdk/contracts';
import { checkNavigation, renderTree, sha256Hex, treeHash, uuidv7 } from '@ai-bdd/sdk';
import type { CuaClient, CuaToolResult } from './client.ts';
import { parseKey } from './keys.ts';
import { buildNodes, parseElements, settleHash } from './nodes.ts';
import type { BuiltNodes } from './nodes.ts';

export const DRIVER_ID = 'cua';
/** Bump when the observation grammar or ref scheme changes (recordings key on it). */
export const DRIVER_VERSION = '1.0.0';
/** Policy-independent upper bound for the `wait` verb. */
export const MAX_WAIT_MS = 5000;
const SCROLL_STEPS = 5;
const REVISIONED = /^r(\d+):e(\d+)$/;

export type Delivery = 'auto' | 'background' | 'foreground';

export interface WindowRef { pid: number; windowId: number }

export interface SessionConfig {
  kind: 'browser' | 'app';
  scope: 'content' | 'window';
  delivery: Delivery;
  /** Time budget of one accessibility-tree walk. */
  treeTimeoutMs: number;
  /** Time budget of one input action. */
  actionTimeoutMs: number;
  /** Pause after an input action so the app can react before the next observation. */
  settleMs: number;
  /** Matches the product name browsers append to the window title; removed from the title to form the route. */
  titleSuffix: RegExp | undefined;
}

export const DEFAULT_TITLE_SUFFIX = /\s+[-–—]\s+(?:Google Chrome(?: for Testing)?|Chromium|Mozilla Firefox|Microsoft Edge|Brave|Opera|Vivaldi)\s*$/;

export function capabilitiesFor(kind: 'browser' | 'app', maxSessions: number): DriverCapabilities {
  const verbs: Verb[] = ['click', 'fill', 'press', 'check', 'scroll', 'wait'];
  if (kind === 'browser') verbs.push('navigate', 'back');
  // Real pointer and keyboard input is global to the desktop: sessions share one screen unless the caller proves otherwise.
  return { verbs, pixels: true, maskingProven: false, request: false, maxSessions, exclusiveResource: 'cua-desktop' };
}

function errorPayload(code: AiBddErrorPayload['code'], message: string, retryable?: boolean, details?: JsonValue): AiBddErrorPayload {
  return new AiBddError(code, message, {
    ...(retryable === undefined ? {} : { retryable }),
    ...(details === undefined ? {} : { details }),
  }).toPayload();
}

function failure(code: AiBddErrorPayload['code'], message: string, retryable?: boolean, details?: JsonValue): ActionOutcome {
  return { ok: false, error: errorPayload(code, message, retryable, details) };
}

/**
 * The driver answers a call that names a window which no longer exists with the generic code `tool_invocation_failed` and says
 * why only in the message ("... is stale or no longer running; refresh list_windows."), so the message is part of the contract.
 */
export function isWindowGone(result: CuaToolResult): boolean {
  return result.failed && (/window[_ ](?:not[_ ]found|gone)|no_such_window|no_window|target_gone/i.test(result.code ?? '') || /(?:stale or no longer running|no such window|window .* (?:was )?closed)/i.test(result.text));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CuaSession implements DriverSession {
  readonly id = uuidv7();
  readonly driverId = DRIVER_ID;
  readonly driverVersion = DRIVER_VERSION;
  readonly capabilities: DriverCapabilities;

  private readonly client: CuaClient;
  private readonly win: WindowRef;
  private readonly cfg: SessionConfig;
  private readonly policy: Policy;
  private readonly baseURL: string | undefined;
  private readonly resolveValue: (v: ValueSource) => string;
  private readonly onClose: (() => Promise<void>) | undefined;
  private revision = 0;
  private built: BuiltNodes | undefined;
  private tainted = false;
  private closed = false;
  /** Set once a background delivery was refused (Chromium and Electron renderers): later input goes straight to the foreground. */
  private foregroundOnly = false;
  private readonly secrets = new Set<string>();

  constructor(
    client: CuaClient, win: WindowRef, opts: SessionOptions, ctx: { policy: Policy; baseURL?: string },
    cfg: SessionConfig, capabilities: DriverCapabilities, onClose?: () => Promise<void>,
  ) {
    this.client = client;
    this.win = win;
    this.cfg = cfg;
    this.policy = ctx.policy;
    this.baseURL = ctx.baseURL ?? opts.baseURL;
    this.resolveValue = opts.resolveValue;
    this.capabilities = capabilities;
    this.onClose = onClose;
  }

  // ───────────────────────── helpers

  private sanitize(text: string): string {
    let msg = (text.split('\n')[0] ?? '').trim();
    for (const s of this.secrets) if (s.length > 0) msg = msg.split(s).join('***');
    return msg.length > 300 ? `${msg.slice(0, 300)}...` : msg;
  }

  private assertOpen(): void {
    if (this.closed) throw new AiBddError('DRIVER_UNAVAILABLE', 'session is closed');
  }

  private async call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CuaToolResult> {
    return this.client.callTool(tool, args, timeoutMs === undefined ? {} : { timeoutMs });
  }

  /** An input tool call with the session's delivery policy: background first, the foreground once the app refuses it. */
  private async input(tool: string, args: Record<string, unknown>): Promise<CuaToolResult> {
    const timeoutMs = this.cfg.actionTimeoutMs;
    const base = { pid: this.win.pid, ...args };
    if (this.cfg.delivery === 'foreground' || (this.cfg.delivery === 'auto' && this.foregroundOnly)) {
      return this.call(tool, { ...base, delivery_mode: 'foreground' }, timeoutMs);
    }
    const first = await this.call(tool, { ...base, delivery_mode: 'background' }, timeoutMs);
    if (this.cfg.delivery === 'auto' && first.failed && first.code === 'background_unavailable') {
      this.foregroundOnly = true;
      return this.call(tool, { ...base, delivery_mode: 'foreground' }, timeoutMs);
    }
    return first;
  }

  private toFailure(result: CuaToolResult, what: string): ActionOutcome {
    const detail = this.sanitize(result.text);
    const code = result.code ?? '';
    if (isWindowGone(result)) return failure('DRIVER_UNAVAILABLE', `${what}: ${detail || 'the window is gone'}`);
    if (/stale/.test(code)) return failure('STALE_REF', `${what}: ${detail || 'the element handle is stale'}`, false);
    if (/not_found|no_such|missing_element/.test(code)) return failure('TARGET_NOT_FOUND', `${what}: ${detail || code}`, false);
    return failure('DRIVER_ERROR', `${what}: ${detail || code || 'cua-driver reported an error'}`);
  }

  private tokenOf(ref: string): { token: string; ref: string } | { error: ActionOutcome } {
    const m = REVISIONED.exec(ref);
    if (m === null) return { error: failure('STALE_REF', `ref ${JSON.stringify(ref)} is not of the form r<revision>:e<index>; use a ref from the latest observation`, false) };
    const rev = Number(m[1]);
    if (rev !== this.revision) {
      return { error: failure('STALE_REF', `ref ${JSON.stringify(ref)} belongs to revision ${rev} but the latest observation is revision ${this.revision}`, false) };
    }
    const token = this.built?.tokens.get(ref);
    if (token === undefined) return { error: failure('TARGET_NOT_FOUND', `ref ${JSON.stringify(ref)} is not in the latest observation`, false) };
    return { token, ref };
  }

  private routeOf(title: string): string {
    const stripped = this.cfg.titleSuffix === undefined ? title : title.replace(this.cfg.titleSuffix, '');
    return stripped.trim().length > 0 ? stripped.trim() : '/';
  }

  // ───────────────────────── observe

  async observe(opts?: { pixels?: boolean }): Promise<Observation> {
    this.assertOpen();
    const revision = ++this.revision;
    let timeout = this.cfg.treeTimeoutMs;
    let res: CuaToolResult;
    // A partial walk (cold start of a large app) is retried once with twice the budget.
    for (let attempt = 0; ; attempt += 1) {
      res = await this.call(
        'get_window_state',
        { pid: this.win.pid, window_id: this.win.windowId, include_screenshot: opts?.pixels === true, timeout_ms: timeout },
        timeout + 15_000,
      );
      if (res.failed) {
        throw new AiBddError(isWindowGone(res) || /not_found/.test(res.code ?? '') ? 'DRIVER_UNAVAILABLE' : 'DRIVER_ERROR', `get_window_state: ${this.sanitize(res.text) || res.code || 'failed'}`);
      }
      if (res.structured['truncated'] !== true || attempt >= 1 || timeout >= 120_000) break;
      timeout = Math.min(timeout * 2, 120_000);
    }

    const built = buildNodes(parseElements(res.structured), revision, { scope: this.cfg.scope, secrets: this.secrets });
    this.built = built;
    const rawTitle = typeof res.structured['window_title'] === 'string' ? res.structured['window_title'] : '';
    const title = this.sanitize(this.cfg.titleSuffix === undefined ? rawTitle : rawTitle.replace(this.cfg.titleSuffix, ''));
    const obs: Observation = {
      revision, route: this.routeOf(rawTitle), nodes: built.nodes, busy: built.busy, tainted: this.tainted,
      treeText: renderTree(built.nodes, { refs: true }), treeHash: settleHash(built.nodes, treeHash),
    };
    if (title.length > 0) obs.title = title;
    if (opts?.pixels === true) {
      const image = res.images[0];
      if (image !== undefined) obs.screenshot = { png: image.data, sha256: sha256Hex(image.data), masked: false };
    }
    return obs;
  }

  // ───────────────────────── perform

  async perform(action: DriverAction): Promise<ActionOutcome> {
    if (this.closed) return failure('DRIVER_UNAVAILABLE', 'session is closed');
    if (this.policy.denyVerbs.includes(action.verb)) return failure('POLICY_DENIED', `verb ${action.verb} is denied by policy`, false);
    if (!this.capabilities.verbs.includes(action.verb)) return failure('VERB_UNSUPPORTED', `verb ${String((action as { verb: unknown }).verb)} is not supported by the cua driver${this.cfg.kind === 'app' && (action.verb === 'navigate' || action.verb === 'back') ? ' for a native app (use kind "browser" for browser windows)' : ''}`, false);

    // Taint before anything can fail: a secret that was resolved (or attempted) must poison pixels for the whole session.
    if (action.verb === 'fill' && 'secret' in action.value) this.tainted = true;

    let token: string | undefined;
    let targetRef: string | undefined;
    if ('target' in action && action.target !== undefined) {
      const parsed = this.tokenOf(action.target.ref);
      if ('error' in parsed) return parsed.error;
      token = parsed.token;
      targetRef = parsed.ref;
    }

    try {
      const outcome = await this.run(action, token, targetRef);
      if (!outcome.ok) return outcome;
      if (action.verb !== 'wait') await sleep(this.cfg.settleMs);
      return outcome;
    } catch (err) {
      if (err instanceof AiBddError) return { ok: false, error: err.toPayload() };
      return failure('DRIVER_ERROR', this.sanitize(err instanceof Error ? err.message : String(err)));
    }
  }

  private async keys(spec: string, extra: Record<string, unknown> = {}): Promise<ActionOutcome> {
    const key = parseKey(spec);
    if (key === undefined) return failure('DRIVER_ERROR', `unknown key ${JSON.stringify(spec)}`, false);
    const res = await this.input('press_key', { window_id: this.win.windowId, key: key.key, ...(key.modifiers.length > 0 ? { modifiers: key.modifiers } : {}), ...extra });
    return res.failed ? this.toFailure(res, `press ${spec}`) : { ok: true };
  }

  private async typeText(text: string): Promise<ActionOutcome> {
    const res = await this.input('type_text', { window_id: this.win.windowId, text });
    return res.failed ? this.toFailure(res, 'type') : { ok: true };
  }

  private async clickToken(token: string): Promise<ActionOutcome> {
    const res = await this.input('click', { window_id: this.win.windowId, element_token: token });
    return res.failed ? this.toFailure(res, 'click') : { ok: true };
  }

  private async run(action: DriverAction, token: string | undefined, targetRef: string | undefined): Promise<ActionOutcome> {
    switch (action.verb) {
      case 'click':
        return this.clickToken(token as string);
      case 'fill': {
        const value = this.resolveValue(action.value);
        if ('secret' in action.value && value.length > 0) this.secrets.add(value);
        const focus = await this.clickToken(token as string);
        if (!focus.ok) return focus;
        const selectAll = await this.keys('Control+A');
        if (!selectAll.ok) return selectAll;
        return value.length === 0 ? this.keys('Backspace') : this.typeText(value);
      }
      case 'press': {
        if (token !== undefined) {
          const focus = await this.clickToken(token);
          if (!focus.ok) return focus;
        }
        return this.keys(action.key);
      }
      case 'check': {
        const current = targetRef === undefined ? undefined : this.built?.checked.get(targetRef);
        if (current === undefined) return failure('DRIVER_ERROR', 'the target has no checked state (it is not a check box, radio button or switch)', false);
        return current === action.checked ? { ok: true } : this.clickToken(token as string);
      }
      case 'scroll': {
        const res = await this.input('scroll', {
          window_id: this.win.windowId, direction: action.direction, amount: SCROLL_STEPS, ...(token === undefined ? {} : { element_token: token }),
        });
        return res.failed ? this.toFailure(res, 'scroll') : { ok: true };
      }
      case 'wait': {
        await sleep(Number.isFinite(action.ms) ? Math.min(Math.max(0, action.ms), MAX_WAIT_MS) : 0);
        return { ok: true };
      }
      case 'navigate': {
        const verdict = checkNavigation(action.url, this.baseURL, this.policy);
        if (!verdict.ok) {
          return failure('POLICY_DENIED', `navigation to ${JSON.stringify(action.url)} denied: ${verdict.reason}`, false, { url: action.url, reason: verdict.reason });
        }
        const focus = await this.keys('Control+L');
        if (!focus.ok) return focus;
        const typed = await this.typeText(verdict.url);
        if (!typed.ok) return typed;
        const enter = await this.keys('Enter');
        return enter.ok ? { ok: true, navigatedTo: verdict.url } : enter;
      }
      case 'back':
        return this.keys('Alt+Left');
      default:
        return failure('VERB_UNSUPPORTED', `verb ${action.verb} is not supported`, false);
    }
  }

  // ───────────────────────── lifecycle

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.onClose?.();
    } catch {
      // the app is already gone
    }
  }
}
