import type {
  Action,
  ActionResult,
  ArtifactRef,
  Capabilities,
  Driver,
  DriverContext,
  DriverFactory,
  DriverSession,
  JsonValue,
  Observation,
  ObservedNode,
  Selector,
} from '@ai-bdd/contracts';
import { AiBddError, hashJson, sha256Hex } from '@ai-bdd/contracts';
import { loadFakeModel, renderPng, type FakeModel, type FakeNode, type FakeScreen, type FakeState } from './model.js';

export interface FakeFaultOptions {
  spinnerMs?: number;
  flakyNode?: boolean;
  secureField?: boolean;
  duplicateForms?: boolean;
}

export interface FakeDriverOptions {
  modelPath?: string;
  model?: FakeModel;
  fault?: FakeFaultOptions;
  /** Deterministic clock. */
  now?: () => Date;
  /** Polls needed for a spinner to resolve (settle detection). */
  spinnerPollMs?: number;
}

const VERBS = ['navigate', 'tap', 'type', 'typeSecret', 'press', 'select', 'check', 'scroll', 'hover', 'back'] as const;

export class FakeSession implements DriverSession {
  readonly id: string;
  readonly driverId = 'fake';
  readonly driverMajor = 1;
  readonly target?: JsonValue;

  private readonly model: FakeModel;
  private readonly fault: FakeFaultOptions;
  private readonly now: () => Date;
  private readonly spinnerPollMs: number;
  private state: FakeState;
  private route: string;
  private revision = 0;
  private paused = 0;
  private tainted = false;
  private closed = false;
  private polls = 0;
  private flakyRevealed = false;
  private nodeIndex = new Map<string, ObservedNode>();

  constructor(options: FakeDriverOptions & { sessionId: string }) {
    this.model = options.model ?? loadFakeModel(options.modelPath ?? 'fixtures/app/model.json');
    this.fault = options.fault ?? {};
    this.now = options.now ?? (() => new Date());
    this.spinnerPollMs = options.spinnerPollMs ?? 100;
    this.state = { ...this.model.initial, ...(this.fault.secureField ? {} : {}) };
    this.id = options.sessionId;
    // An unseeded session has no screen: the first navigate is a real change,
    // which is what makes record/replay meaningful in tests.
    this.route = '';
  }

  get capabilities(): Capabilities {
    return {
      verbs: [...VERBS],
      pixels: true,
      tree: true,
      video: false,
      nativePredicates: false,
      maskingProven: true,
    };
  }

  /** Seeds driver state directly, used by fixture setup bindings. */
  seedState(seed: Partial<FakeState>): void {
    this.state = { ...this.state, ...seed };
  }

  private screen(): FakeScreen | null {
    return this.model.screens.find((candidate) => candidate.route === this.route) ?? null;
  }

  private visible(node: FakeNode): boolean {
    if (!node.visibleWhen) return true;
    const [key, expected] = node.visibleWhen.split(':');
    switch (key) {
      case 'plan':
        return this.state.plan === expected;
      case 'toast':
        return this.state.toast === expected;
      case 'blocked':
        return this.state.unpaid > 0;
      case 'loading':
        return this.state.loading;
      case 'loaded':
        return !this.state.loading && this.paused <= 0;
      default:
        return Boolean((this.state as unknown as Record<string, JsonValue>)[key ?? '']);
    }
  }

  private interpolate(name: string): string {
    return name.replace(/\{\{(\w+)\}\}/gu, (_all, key: string) => {
      if (key === 'planLabel') return this.state.plan === 'pro' ? 'Pro plan' : 'Free plan';
      if (key === 'workspaceLabel') return this.state.workspace ?? 'none';
      if (key === 'prorated') return '12.00';
      if (key === 'user') return this.state.user;
      if (key === 'now') return this.state.now ?? '2026-10-09T00:00:00.000Z';
      return String((this.state as unknown as Record<string, JsonValue>)[key] ?? '');
    });
  }

  private buildNodes(): ObservedNode[] {
    const screen = this.screen();
    if (!screen) return [];
    const nodes: FakeNode[] = [...screen.nodes];
    if (this.state.dialog && screen.dialogs?.[this.state.dialog]) nodes.push(...screen.dialogs[this.state.dialog]!);
    if (this.fault.duplicateForms && !screen.nodes.some((node) => node.testId === 'submit-extra')) {
      nodes.push({ role: 'form', name: 'Extra form' });
      nodes.push({ role: 'button', name: 'Submit', testId: 'submit-extra' });
    }
    if (this.fault.flakyNode && this.flakyRevealed && !nodes.some((node) => node.testId === 'flaky')) {
      nodes.push({ role: 'text', name: 'Flaky node', testId: 'flaky' });
    }
    const out: ObservedNode[] = [];
    this.nodeIndex = new Map();
    let counter = 0;
    for (const node of nodes) {
      if (!this.visible(node)) continue;
      counter += 1;
      const ref = `r${this.revision}-${counter}`;
      const observed: ObservedNode = {
        ref,
        role: node.role,
        name: this.interpolate(node.name),
        ...(node.testId ? { testId: node.testId } : {}),
        ...(node.role === 'text' || node.role === 'heading' || node.role === 'alert' ? { text: this.interpolate(node.name) } : {}),
        ...(node.ancestors ? { ancestors: node.ancestors } : {}),
      };
      out.push(observed);
      this.nodeIndex.set(ref, observed);
      if (node.testId) this.nodeIndex.set(`testid:${node.testId}`, observed);
    }
    return out;
  }

  async observe(options: { pixels?: boolean } = {}): Promise<Observation> {
    if (this.closed) throw new AiBddError('NO_SESSION', 'the fake session is closed');
    this.revision += 1;
    this.polls += 1;
    if (this.paused > 0) {
      this.paused -= this.spinnerPollMs;
      this.state.loading = this.paused > 0;
    }
    if (this.fault.flakyNode && this.polls > 2) this.flakyRevealed = true;
    const nodes = this.buildNodes();
    const settled = !this.state.loading;

    let screenshot: ArtifactRef | undefined;
    if (options.pixels && !this.tainted) {
      // The screenshot seed is the structural hash, so identical screens produce
      // identical bytes across runs and across revisions.
      const seed = structuralTreeHash(nodes);
      const bytes = renderPng(32, 8, seed);
      const sha256 = sha256Hex(bytes);
      screenshot = { sha256, ext: 'png', mediaType: 'image/png', path: `artifacts/${sha256}.png`, bytes: bytes.length };
    }
    return {
      revision: this.revision,
      nodes,
      treeHash: structuralTreeHash(nodes),
      route: this.route,
      url: `http://localhost:3000${this.route}`,
      title: this.screen()?.title ?? 'unseeded',
      ...(screenshot ? { screenshot } : {}),
      tainted: this.tainted,
      maskingProven: true,
      settled,
      capturedAt: this.now().toISOString(),
    };
  }

  async perform(action: Action): Promise<ActionResult> {
    if (this.closed) throw new AiBddError('NO_SESSION', 'the fake session is closed');
    if (!VERBS.includes(action.verb as (typeof VERBS)[number])) {
      return { ok: false, verb: action.verb, error: `the fake driver does not support ${action.verb}`, code: 'DRIVER_INCOMPATIBLE' };
    }
    switch (action.verb) {
      case 'navigate': {
        const value = action.value ?? '/';
        const [path, query] = value.split('?');
        const screen = this.model.screens.find((candidate) => candidate.route === path);
        if (!screen) return { ok: false, verb: action.verb, error: `no screen ${path}`, code: 'POLICY_DENIED' };
        this.route = path ?? '/settings/billing';
        const params = new URLSearchParams(query ?? '');
        if (params.has('unpaid')) this.state.unpaid = Number(params.get('unpaid'));
        if (params.has('plan')) this.state.plan = String(params.get('plan'));
        if (params.has('toast')) this.state.toast = String(params.get('toast'));
        if (params.has('now')) this.state.now = String(params.get('now'));
        this.state.dialog = params.get('dialog');
        if (this.route === '/slow') {
          const ms = Number(params.get('ms') ?? screen.spinnerMs ?? this.fault.spinnerMs ?? 0);
          this.paused = ms;
          this.state.loading = ms > 0;
        }
        return { ok: true, verb: action.verb, route: this.route };
      }
      case 'tap': {
        const node = this.resolve(action);
        if (typeof node === 'string') {
          return {
            ok: false,
            verb: action.verb,
            error: `target ${node}`,
            code: node === 'ambiguous' ? 'ACT_TARGET_AMBIGUOUS' : 'DRIVER_INCOMPATIBLE',
          };
        }
        const transition = this.transitionFor(node);
        if (!transition) return { ok: false, verb: action.verb, error: `no transition for ${node.name}`, code: 'DRIVER_INCOMPATIBLE' };
        this.applyTransition(transition);
        return { ok: true, verb: action.verb, route: this.route };
      }
      case 'type':
        return { ok: true, verb: action.verb };
      case 'typeSecret':
        this.tainted = true;
        return { ok: true, verb: action.verb, tainted: true };
      case 'back':
        this.route = this.model.screens[0]?.route ?? '/settings/billing';
        return { ok: true, verb: action.verb, route: this.route };
      default:
        return { ok: true, verb: action.verb };
    }
  }

  private transitionFor(node: ObservedNode): FakeTransitionLike | null {
    for (const screen of this.model.screens) {
      const pool: FakeNode[] = [...screen.nodes, ...Object.values(screen.dialogs ?? {}).flat()];
      const match = pool.find(
        (candidate) =>
          (node.testId && candidate.testId === node.testId) ||
          (candidate.role === node.role && candidate.name === node.name),
      );
      if (match?.transition) return match.transition;
    }
    return null;
  }

  private applyTransition(transition: FakeTransitionLike): void {
    if (transition.dialog !== undefined) this.state.dialog = transition.dialog;
    if (transition.toast !== undefined) this.state.toast = transition.toast;
    switch (transition.action) {
      case 'upgrade':
      case 'confirmUpgrade':
        this.state.plan = 'pro';
        this.state.dialog = null;
        break;
      case 'downgrade':
        if (this.state.unpaid === 0) this.state.plan = 'free';
        break;
      case 'cancelUpgrade':
        this.state.dialog = null;
        break;
      case 'signIn':
        this.state.signedIn = true;
        this.route = '/dashboard';
        break;
      default:
        break;
    }
  }

  private resolve(action: Action): ObservedNode | string {
    if (action.ref) {
      const node = this.nodeIndex.get(action.ref);
      return node ?? 'missing';
    }
    if (action.selector) {
      const selector: Selector = action.selector;
      const matches = [...this.nodeIndex.values()].filter((node) => matchesSelector(node, selector));
      const unique = [...new Map(matches.map((node) => [node.ref, node])).values()];
      if (unique.length === 0) return 'missing';
      if (unique.length > 1) return 'ambiguous';
      return unique[0]!;
    }
    return 'missing';
  }

  maskingProven(): boolean {
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface FakeTransitionLike {
  dialog?: string | null;
  action?: string;
  toast?: string | null;
  route?: string;
}

export function matchesSelector(node: ObservedNode, selector: Selector): boolean {
  if (selector.role && node.role !== selector.role) return false;
  if (selector.testId !== undefined && node.testId !== selector.testId) return false;
  if (selector.name !== undefined && node.name !== selector.name) return false;
  if (selector.text !== undefined && (node.text ?? '') !== selector.text) return false;
  return true;
}

export function fakeDriver(options: FakeDriverOptions = {}): DriverFactory {
  return {
    id: 'fake',
    target: 'fake',
    async create(ctx: DriverContext): Promise<Driver> {
      return {
        id: 'fake',
        major: 1,
        capabilities: {
          verbs: [...VERBS],
          pixels: true,
          tree: true,
          video: false,
          nativePredicates: false,
          maskingProven: true,
        },
        concurrency: { maxSessions: 8 },
        async selfCheck() {
          return { ok: true, driver: 'fake', problems: [] };
        },
        async openSession(openCtx: DriverContext): Promise<DriverSession> {
          return new FakeSession({ ...options, sessionId: openCtx.sessionId });
        },
      };
    },
  };
}

/** Tree hash over role/name/testId only: refs are revision scoped by design. */
function structuralTreeHash(nodes: ObservedNode[]): string {
  const shape = (list: ObservedNode[]): JsonValue[] =>
    list.map((node) => ({
      role: node.role,
      name: node.name,
      testId: node.testId ?? null,
      children: node.children ? shape(node.children) : [],
    }));
  return hashJson(shape(nodes) as unknown as JsonValue);
}
