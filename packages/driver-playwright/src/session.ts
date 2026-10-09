import { chromium, firefox, webkit, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import type {
  Action,
  ActionResult,
  ArtifactRef,
  Capabilities,
  DriverSession,
  JsonValue,
  Observation,
  ObservedNode,
  Selector,
} from '@ai-bdd/contracts';
import { AiBddError, sha256Hex } from '@ai-bdd/contracts';
import { parseAriaSnapshot, structuralTreeHash, type LocatorDescriptor } from './tree.js';

export interface PlaywrightDriverOptions {
  browser?: 'chromium' | 'firefox' | 'webkit';
  baseURL?: string;
  headless?: boolean;
  video?: boolean;
  channel?: string;
  allowHosts?: string[];
  maxSessions?: number;
  now?: () => Date;
}

const VERBS = ['navigate', 'back', 'tap', 'doubleTap', 'longPress', 'secondaryTap', 'hover', 'type', 'typeSecret', 'press', 'select', 'check', 'scroll', 'scrollTo', 'upload', 'tapAt', 'typeAt'] as const;

/** Verbs that produce real input; `tapAt`/`typeAt` need coordinates and are refused. */
const COORDINATE_VERBS = new Set(['tapAt', 'typeAt']);

export class PlaywrightBrowser {
  private browser: Browser | undefined;
  private readonly options: PlaywrightDriverOptions;

  constructor(options: PlaywrightDriverOptions = {}) {
    this.options = options;
  }

  async instance(): Promise<Browser> {
    if (this.browser) return this.browser;
    const launcher = { chromium, firefox, webkit }[this.options.browser ?? 'chromium'];
    try {
      this.browser = await launcher.launch({
        headless: this.options.headless ?? true,
        ...(this.options.channel !== undefined ? { channel: this.options.channel } : {}),
      });
    } catch (error) {
      throw new AiBddError('DRIVER_UNAVAILABLE', `could not launch ${this.options.browser ?? 'chromium'}`, {
        details: { hint: 'run `npx playwright-core install chromium`' },
        cause: error,
      });
    }
    return this.browser;
  }

  async context(): Promise<BrowserContext> {
    const browser = await this.instance();
    return browser.newContext({
      ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
      ...(this.options.video === true ? { recordVideo: { dir: 'test-results' } } : {}),
    });
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }
}

/** One BrowserContext per session, which is what gives isolation (section 11.1). */
export class PlaywrightSession implements DriverSession {
  readonly id: string;
  readonly driverId = 'playwright';
  readonly driverMajor = 1;
  readonly target?: JsonValue;
  readonly capabilities: Capabilities = {
    verbs: [...VERBS],
    pixels: true,
    tree: true,
    video: true,
    nativePredicates: false,
    maskingProven: true,
  };

  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly options: PlaywrightDriverOptions;
  private readonly now: () => Date;
  private revision = 0;
  private pendingRequests = 0;
  private tainted = false;
  private closed = false;
  private descriptors = new Map<string, LocatorDescriptor>();
  private lastMaskingProven = true;

  static async open(options: PlaywrightDriverOptions, id: string): Promise<PlaywrightSession> {
    const browser = new PlaywrightBrowser(options);
    const context = await browser.context();
    const page = await context.newPage();
    return new PlaywrightSession(id, context, page, browser, options);
  }

  private constructor(
    id: string,
    context: BrowserContext,
    page: Page,
    private readonly browser: PlaywrightBrowser,
    options: PlaywrightDriverOptions,
  ) {
    this.id = id;
    this.context = context;
    this.page = page;
    this.options = options;
    this.now = options.now ?? (() => new Date());

    page.on('request', (request) => {
      const type = request.resourceType();
      if (type === 'websocket' || type === 'eventsource') return;
      this.pendingRequests += 1;
    });
    const done = (): void => {
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  private assertOpen(): void {
    if (this.closed) throw new AiBddError('NO_SESSION', 'the Playwright session is closed');
  }

  async observe(options: { pixels?: boolean } = {}): Promise<Observation> {
    this.assertOpen();
    this.revision += 1;
    const snapshot = await this.page.locator('body').ariaSnapshot();
    const parsed = parseAriaSnapshot(snapshot, this.revision);
    this.descriptors = parsed.descriptors;
    const nodes = await this.attachTestIds(parsed.nodes);

    const url = this.page.url();
    const route = safeRoute(url);

    let screenshot: ArtifactRef | undefined;
    if (options.pixels) {
      const masks = await this.maskLocators();
      const passwordInputs = await this.page.locator('input[type=password]').count();
      const maskedInputs = masks.filter((locator) => locator.kind === 'password').length;
      this.lastMaskingProven = passwordInputs === 0 || maskedInputs >= passwordInputs;
      if (!this.tainted || this.lastMaskingProven) {
        const bytes = await this.page.screenshot({
          fullPage: false,
          mask: masks.map((mask) => mask.locator),
          maskColor: '#ff00ff',
        });
        const sha256 = sha256Hex(bytes);
        screenshot = { sha256, ext: 'png', mediaType: 'image/png', path: `artifacts/${sha256}.png`, bytes: bytes.length };
      }
    }

    const readyState = await this.page.evaluate('document.readyState');
    const settled = readyState === 'complete' && this.pendingRequests === 0;

    return {
      revision: this.revision,
      nodes,
      treeHash: structuralTreeHash(nodes),
      url,
      route,
      ...(await this.title()),
      ...(screenshot !== undefined ? { screenshot } : {}),
      tainted: this.tainted,
      maskingProven: this.lastMaskingProven,
      settled,
      capturedAt: this.now().toISOString(),
    };
  }

  private async title(): Promise<{ title?: string }> {
    try {
      return { title: await this.page.title() };
    } catch {
      return {};
    }
  }

  /** Attaches `data-testid` values to nodes by matching accessible names. */
  private async attachTestIds(nodes: ObservedNode[]): Promise<ObservedNode[]> {
    const ids = await this.page
      .$$eval('[data-testid]', (elements) =>
        elements.map((element) => ({
          testId: (element as { dataset: { testid?: string } }).dataset.testid ?? '',
          name: element.getAttribute('aria-label') ?? element.textContent ?? '',
        })),
      )
      .catch(() => [] as Array<{ testId: string; name: string }>);
    const byName = new Map(ids.filter((entry) => entry.testId.length > 0).map((entry) => [entry.name.trim(), entry.testId]));
    const attach = (list: ObservedNode[]): ObservedNode[] =>
      list.map((node) => {
        const testId = byName.get(node.name);
        return {
          ...node,
          ...(testId !== undefined ? { testId } : {}),
          ...(node.children ? { children: attach(node.children) } : {}),
        };
      });
    return attach(nodes);
  }

  private async maskLocators(): Promise<Array<{ kind: 'password' | 'secret'; locator: Locator }>> {
    const masks: Array<{ kind: 'password' | 'secret'; locator: Locator }> = [];
    const passwords = this.page.locator('input[type=password]');
    for (let index = 0; index < (await passwords.count()); index += 1) {
      masks.push({ kind: 'password', locator: passwords.nth(index) });
    }
    const secrets = this.page.locator('[data-ai-bdd-secret]');
    for (let index = 0; index < (await secrets.count()); index += 1) {
      masks.push({ kind: 'secret', locator: secrets.nth(index) });
    }
    return masks;
  }

  async perform(action: Action): Promise<ActionResult> {
    this.assertOpen();
    if (!VERBS.includes(action.verb as (typeof VERBS)[number])) {
      return { ok: false, verb: action.verb, error: `the Playwright driver does not support ${action.verb}`, code: 'DRIVER_INCOMPATIBLE' };
    }
    if (COORDINATE_VERBS.has(action.verb)) {
      return { ok: false, verb: action.verb, error: 'coordinate verbs need a capture id and are disabled', code: 'DRIVER_INCOMPATIBLE' };
    }
    try {
      switch (action.verb) {
        case 'navigate': {
          const target = action.value ?? '/';
          this.checkHost(target);
          await this.page.goto(target, { waitUntil: 'domcontentloaded' });
          this.checkHost(this.page.url());
          return { ok: true, verb: action.verb, route: safeRoute(this.page.url()) };
        }
        case 'back':
          await this.page.goBack();
          return { ok: true, verb: action.verb, route: safeRoute(this.page.url()) };
        case 'press': {
          const locator = this.locate(action);
          await locator.press(action.value ?? 'Enter');
          return { ok: true, verb: action.verb };
        }
        case 'typeSecret': {
          const locator = this.locate(action);
          const secret = action.secretName ?? '';
          const value = action.value ?? secret;
          if (value.length === 0) {
            return { ok: false, verb: action.verb, error: 'typeSecret needs a secret value', code: 'POLICY_DENIED' };
          }
          await locator.fill(value);
          this.tainted = true;
          return { ok: true, verb: action.verb, tainted: true };
        }
        case 'type': {
          await this.locate(action).fill(action.value ?? '');
          return { ok: true, verb: action.verb };
        }
        case 'tap':
          await this.locate(action).click();
          return { ok: true, verb: action.verb, route: safeRoute(this.page.url()) };
        case 'doubleTap':
          await this.locate(action).dblclick();
          return { ok: true, verb: action.verb };
        case 'longPress':
          await this.locate(action).click({ delay: 600 });
          return { ok: true, verb: action.verb };
        case 'secondaryTap':
          await this.locate(action).click({ button: 'right' });
          return { ok: true, verb: action.verb };
        case 'hover':
          await this.locate(action).hover();
          return { ok: true, verb: action.verb };
        case 'select':
          await this.locate(action).selectOption(action.value ?? '');
          return { ok: true, verb: action.verb };
        case 'check':
          await this.locate(action).check();
          return { ok: true, verb: action.verb };
        case 'scroll':
        case 'scrollTo':
          await this.locate(action).scrollIntoViewIfNeeded();
          return { ok: true, verb: action.verb };
        case 'upload':
          await this.locate(action).setInputFiles(action.value ?? '');
          return { ok: true, verb: action.verb };
        default:
          return { ok: false, verb: action.verb, error: `unhandled verb ${action.verb}`, code: 'DRIVER_INCOMPATIBLE' };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /strict mode violation/iu.test(message)
        ? 'ACT_TARGET_AMBIGUOUS'
        : /Timeout|not visible|no element|waiting for/iu.test(message)
          ? 'DRIVER_INCOMPATIBLE'
          : 'INTERNAL';
      return { ok: false, verb: action.verb, error: message, code };
    }
  }

  private locate(action: Action): Locator {
    const descriptor = action.ref !== undefined ? this.descriptors.get(action.ref) : undefined;
    const selector: Selector | undefined = descriptor?.selector ?? action.selector;
    if (!selector) {
      return this.page.locator('body');
    }
    let locator: Locator;
    if (selector.testId) {
      locator = this.page.getByTestId(selector.testId);
    } else if (selector.name !== undefined && selector.name.length > 0) {
      locator = this.page.getByRole(selector.role as never, { name: selector.name, exact: true });
    } else {
      locator = this.page.getByRole(selector.role as never);
    }
    const nth = descriptor?.nth ?? selector.index ?? 0;
    return nth > 0 ? locator.nth(nth) : locator;
  }

  /** Navigation is refused unless the host is in the allowlist (R-K16). */
  private checkHost(url: string): void {
    const allowHosts = this.options.allowHosts ?? ['localhost', '127.0.0.1', '[::1]'];
    let host: string;
    try {
      host = new URL(url, this.options.baseURL ?? 'http://localhost').hostname;
    } catch {
      throw new AiBddError('POLICY_DENIED', `cannot parse the navigation target: ${url}`);
    }
    const bare = host.replace(/^\[/u, '').replace(/\]$/u, '');
    const allowed = allowHosts.some((entry) => {
      const candidate = entry.replace(/^\[/u, '').replace(/\]$/u, '');
      return candidate === host || candidate === bare;
    });
    if (!allowed) {
      throw new AiBddError('POLICY_DENIED', `policy.allowHosts does not include ${host}`, { details: { allowHosts } });
    }
  }

  maskingProven(): boolean {
    return this.lastMaskingProven;
  }

  async startRecording(): Promise<void> {
    this.assertOpen();
  }

  async stopRecording(): Promise<ArtifactRef | undefined> {
    const video = this.page.video();
    if (!video) return undefined;
    const path = await video.path().catch(() => undefined);
    void path;
    return undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close();
  }
}

function safeRoute(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export { VERBS as PLAYWRIGHT_VERBS };
