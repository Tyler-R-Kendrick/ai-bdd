import type {
  Action,
  ActionResult,
  Capabilities,
  DriverFactory,
  DriverSession,
  JsonValue,
  Observation,
  ObservedNode,
} from '@ai-bdd/contracts';
import { AiBddError, hashJson } from '@ai-bdd/contracts';
import { CUA_VERB_MAP, capabilitiesFromTools, isElementToken, mapCuaError, mapVerifyState, type CuaNode } from './tools.js';
import type { McpCaller } from './mcp.js';

export interface CuaSessionOptions {
  caller: McpCaller;
  sessionLabel: string;
  app: string;
  windowTitle?: string;
  displayId?: string;
  backgroundOnly?: boolean;
  allowApps: string[];
  driverMajor: number;
  now?: () => Date;
}

interface WindowTarget {
  pid: number;
  windowId: string;
  title: string;
  app: string;
}

/**
 * One Cua Driver session.
 *
 * Type text goes to the foreground application, so the driver declares an
 * exclusive resource and one session unless `backgroundOnly` is set, in which case
 * every action must use `delivery_mode: 'background'` with a window target and the
 * foreground-only verbs are refused with POLICY_DENIED (R-K13, R-K16).
 */
export class CuaSession implements DriverSession {
  readonly id: string;
  readonly driverId = 'cua';
  readonly driverMajor: number;
  readonly target?: JsonValue;
  readonly capabilities: Capabilities;

  private readonly caller: McpCaller;
  private readonly options: CuaSessionOptions;
  private readonly now: () => Date;
  private readonly catalog: string[];
  private revision = 0;
  private tainted = false;
  private closed = false;
  private window: WindowTarget | undefined;
  private tokens = new Map<string, ObservedNode>();

  constructor(catalog: string[], options: CuaSessionOptions) {
    this.caller = options.caller;
    this.options = options;
    this.catalog = catalog;
    this.driverMajor = options.driverMajor;
    this.id = options.sessionLabel;
    this.now = options.now ?? (() => new Date());
    this.capabilities = capabilitiesFromTools(catalog, options.backgroundOnly === true);
    this.target = {
      app: options.app,
      ...(options.windowTitle !== undefined ? { windowTitle: options.windowTitle } : {}),
      ...(options.displayId !== undefined ? { displayId: options.displayId } : {}),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new AiBddError('NO_SESSION', 'the Cua session is closed');
  }

  private delivery(): 'background' | 'foreground' {
    return this.options.backgroundOnly === true ? 'background' : 'foreground';
  }

  /** Resolves the target window through list_apps/list_windows and the allowlist. */
  async resolveWindow(): Promise<WindowTarget> {
    if (this.window) return this.window;
    const apps = (await this.callChecked('list_apps', {})) as JsonValue;
    const appMatch = findApp(apps, this.options.app);
    if (!appMatch) {
      throw new AiBddError('POLICY_DENIED', `the application \`${this.options.app}\` is not running`);
    }
    this.checkAppAllowed(appMatch.app, appMatch.bundleId);
    const windows = (await this.callChecked('list_windows', { pid: appMatch.pid })) as JsonValue;
    const windowMatch = findWindow(windows, this.options.windowTitle);
    if (!windowMatch) {
      throw new AiBddError('DRIVER_INCOMPATIBLE', `no window of \`${this.options.app}\` matches the configured title`);
    }
    this.window = { pid: appMatch.pid, windowId: windowMatch.id, title: windowMatch.title, app: appMatch.app };
    return this.window;
  }

  private checkAppAllowed(app: string, bundleId?: string): void {
    const allow = this.options.allowApps;
    if (allow.length === 0) {
      throw new AiBddError('POLICY_DENIED', 'policy.cua.allowApps is empty, so no application may be driven');
    }
    const allowed = allow.some((entry) => entry === app || (bundleId !== undefined && entry === bundleId));
    if (!allowed) {
      throw new AiBddError('POLICY_DENIED', `policy.cua.allowApps does not include ${bundleId ?? app}`, {
        details: { allowApps: allow },
      });
    }
  }

  async observe(options: { pixels?: boolean } = {}): Promise<Observation> {
    this.assertOpen();
    const target = await this.resolveWindow();
    this.revision += 1;
    const includeScreenshot = options.pixels === true && !this.tainted;
    const state = (await this.callChecked('get_window_state', {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: true,
      include_screenshot: includeScreenshot,
    })) as Record<string, JsonValue>;

    const nodes = toObservedNodes(state.tree as JsonValue, this.revision, this.tokens);
    const screenshotSha = typeof state.screenshot_sha256 === 'string' ? state.screenshot_sha256 : undefined;
    const screenshotPath = typeof state.screenshot_path === 'string' ? state.screenshot_path : undefined;
    return {
      revision: this.revision,
      nodes,
      treeHash: hashJson(nodes as unknown as JsonValue),
      ...(typeof state.url === 'string' ? { url: state.url } : {}),
      ...(typeof state.route === 'string' ? { route: state.route } : {}),
      ...(target.title.length > 0 ? { title: target.title } : {}),
      ...(screenshotSha !== undefined
        ? {
            screenshot: {
              sha256: screenshotSha,
              ext: 'png',
              mediaType: 'image/png',
              path: screenshotPath ?? `artifacts/${screenshotSha}.png`,
            },
          }
        : {}),
      tainted: this.tainted,
      maskingProven: false,
      settled: true,
      capturedAt: this.now().toISOString(),
    };
  }

  async perform(action: Action): Promise<ActionResult> {
    this.assertOpen();
    const entry = CUA_VERB_MAP[action.verb];
    if (!entry || entry.tool === null || !this.catalog.includes(entry.tool)) {
      return {
        ok: false,
        verb: action.verb,
        error: `the Cua target does not support ${action.verb}`,
        code: 'DRIVER_INCOMPATIBLE',
      };
    }
    const tool = entry.tool;
    if (this.options.backgroundOnly === true && entry.foregroundOnly) {
      return {
        ok: false,
        verb: action.verb,
        error: `backgroundOnly refuses ${action.verb} (it types into the foreground application)`,
        code: 'POLICY_DENIED',
      };
    }
    try {
      const target = await this.resolveWindow();
      const args: Record<string, JsonValue> = {
        delivery_mode: this.delivery(),
      };
      if (this.delivery() === 'foreground' && action.delivery === 'background') {
        args.delivery_mode = 'background';
      }
      const token = resolveToken(action, this.tokens);
      if (tool === 'click' || tool === 'move_cursor') {
        args.target = { kind: 'window', pid: target.pid, window_id: target.windowId };
        if (token) {
          args.element_token = token;
        } else if (action.coords) {
          args.x = action.coords.x;
          args.y = action.coords.y;
        } else {
          return { ok: false, verb: action.verb, error: 'click needs an element token or coordinates', code: 'DRIVER_INCOMPATIBLE' };
        }
      }
      if (tool === 'type_text') args.text = action.secretName !== undefined ? '' : (action.value ?? '');
      if (tool === 'type_text' && action.secretName !== undefined) {
        // The value is filled by the driver, never read back into a prompt or a log.
        args.text = this.secretFor(action.secretName);
        this.tainted = true;
      }
      if (tool === 'press_key') args.key = action.value ?? 'Return';
      if (tool === 'hotkey') args.keys = (action.value ?? '').split('+').filter((part) => part.length > 0);
      if (tool === 'scroll') {
        args.target = { kind: 'window', pid: target.pid, window_id: target.windowId };
        args.direction = action.value ?? 'down';
      }
      if (tool === 'drag' || tool === 'move_cursor') {
        args.target = { kind: 'window', pid: target.pid, window_id: target.windowId };
      }
      await this.callChecked(tool, args);
      return {
        ok: true,
        verb: action.verb,
        ...(this.tainted ? { tainted: true } : {}),
      };
    } catch (error) {
      const aiBdd = AiBddError.from(error);
      return { ok: false, verb: action.verb, error: aiBdd.message, code: String(aiBdd.code) };
    }
  }

  private secretFor(name: string): string {
    const value = process.env[name] ?? process.env[`AI_BDD_SECRET_${name.toUpperCase()}`];
    if (value === undefined) {
      throw new AiBddError('POLICY_DENIED', `the secret \`${name}\` is not present in the environment`);
    }
    return value;
  }

  /** Deterministic predicate evaluation through `verify_state`. `unknown` fails. */
  async verifyNative(predicates: JsonValue): Promise<Array<'satisfied' | 'unsatisfied' | 'unknown'>> {
    this.assertOpen();
    if (!this.catalog.includes('verify_state')) {
      throw new AiBddError('DRIVER_INCOMPATIBLE', 'this Cua target has no verify_state tool');
    }
    const target = await this.resolveWindow();
    const payload = (await this.callChecked('verify_state', {
      pid: target.pid,
      window_id: target.windowId,
      predicates,
    })) as { results?: string[] };
    return mapVerifyState(payload.results ?? []);
  }

  maskingProven(): boolean {
    return false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.caller.call('end_session', { session: this.id });
    } catch {
      // closing is best effort
    }
  }

  private async callChecked(tool: string, args: Record<string, JsonValue>): Promise<JsonValue> {
    try {
      return await this.caller.call(tool, args as JsonValue);
    } catch (error) {
      if (error instanceof AiBddError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = mapCuaError(/\b([A-Z_]{4,})\b/u.exec(message)?.[1]) ?? 'DRIVER_UNAVAILABLE';
      throw new AiBddError(code, message, { cause: error });
    }
  }
}

function resolveToken(action: Action, tokens: Map<string, ObservedNode>): string | undefined {
  if (action.ref !== undefined) {
    const node = tokens.get(action.ref);
    if (node?.testId && isElementToken(node.testId)) return node.testId;
    if (isElementToken(action.ref)) return action.ref;
  }
  if (action.selector?.testId && isElementToken(action.selector.testId)) return action.selector.testId;
  return undefined;
}

function toObservedNodes(tree: JsonValue, revision: number, tokens: Map<string, ObservedNode>): ObservedNode[] {
  tokens.clear();
  let counter = 0;
  const visit = (nodes: CuaNode[]): ObservedNode[] =>
    nodes.map((node) => {
      counter += 1;
      const ref = `r${revision}-${counter}`;
      const token = node.token ?? '';
      const observed: ObservedNode = {
        ref,
        role: node.role,
        name: node.name,
        ...(isElementToken(token) ? { testId: token } : {}),
        ...(node.state ? { state: node.state } : {}),
        ...(node.children ? { children: visit(node.children) } : {}),
      };
      tokens.set(ref, observed);
      if (isElementToken(token)) tokens.set(token, observed);
      return observed;
    });
  return visit(Array.isArray(tree) ? (tree as unknown as CuaNode[]) : []);
}

interface AppMatch {
  app: string;
  pid: number;
  bundleId?: string;
}

function findApp(apps: JsonValue, wanted: string): AppMatch | undefined {
  if (!Array.isArray(apps)) return undefined;
  for (const entry of apps) {
    const record = entry as { name?: string; app?: string; pid?: number; bundle_id?: string; bundleId?: string };
    const name = record.name ?? record.app ?? '';
    const bundleId = record.bundle_id ?? record.bundleId;
    if (name === wanted || bundleId === wanted) {
      return { app: name, pid: Number(record.pid ?? 0), ...(bundleId !== undefined ? { bundleId } : {}) };
    }
  }
  return undefined;
}

function findWindow(windows: JsonValue, titlePattern?: string): { id: string; title: string } | undefined {
  if (!Array.isArray(windows)) return undefined;
  const candidates = windows.map((entry) => {
    const record = entry as { id?: number | string; window_id?: number | string; title?: string };
    return { id: String(record.window_id ?? record.id ?? ''), title: record.title ?? '' };
  });
  if (titlePattern === undefined) return candidates[0];
  let regexp: RegExp;
  try {
    regexp = new RegExp(titlePattern, 'u');
  } catch {
    throw new AiBddError('CONFIG_INVALID', `the window title pattern is not a valid regular expression: ${titlePattern}`);
  }
  return candidates.find((candidate) => regexp.test(candidate.title));
}

export function createCuaSessionFactory(catalog: string[], options: CuaSessionOptions): DriverSession {
  return new CuaSession(catalog, options);
}

export type { WindowTarget };
export { findApp, findWindow };
export interface CuaDriverOptions extends Omit<CuaSessionOptions, 'caller' | 'sessionLabel' | 'driverMajor' | 'allowApps'> {
  allowApps?: string[];
}

export function cuaFactory(caller: McpCaller, options: CuaDriverOptions): DriverFactory {
  const allowApps = options.allowApps ?? [options.app];
  return {
    id: 'cua',
    target: options.app,
    async create() {
      const catalog = await caller.listTools();
      return {
        id: 'cua',
        major: 1,
        capabilities: capabilitiesFromTools(catalog, options.backgroundOnly === true),
        concurrency: options.backgroundOnly === true
          ? { maxSessions: 4 }
          : { maxSessions: 1, exclusiveResource: `desktop:${options.displayId ?? 'main'}` },
        async selfCheck() {
          const problems = REQUIRED_TOOLS_MISSING(catalog);
          return { ok: problems.length === 0, driver: 'cua', problems };
        },
        async openSession(ctx) {
          await caller.call('start_session', { label: `aibdd-${ctx.sessionId}` });
          return new CuaSession(catalog, {
            ...options,
            caller,
            sessionLabel: `aibdd-${ctx.sessionId}`,
            driverMajor: 1,
            allowApps,
          });
        },
      };
    },
  };
}

function REQUIRED_TOOLS_MISSING(catalog: string[]): string[] {
  const required = ['start_session', 'end_session', 'list_apps', 'list_windows', 'get_window_state', 'click'];
  return required.filter((tool) => !catalog.includes(tool)).map((tool) => `the Cua tool list is missing \`${tool}\``);
}
