// @ts-nocheck
import type {
  ActionOutcome,
  DriverAction,
  DriverCapabilities,
  DriverSession,
  Driver,
  NodeStates,
  Observation,
  ObservedNode,
  SessionOptions,
} from '../../../src/contracts/index.ts';
import { renderTree, sha256Hex, treeHash } from '../../../src/util/index.ts';

export interface NodeSpec {
  role: string;
  name: string;
  depth?: number;
  states?: NodeStates;
  value?: string;
  text?: string;
  level?: number;
}

export function toNodes(specs: readonly NodeSpec[]): ObservedNode[] {
  const stack: { depth: number; ref: string }[] = [];
  return specs.map((s, i) => {
    const depth = s.depth ?? 0;
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop();
    const node: ObservedNode = { ref: `e${i}`, role: s.role, name: s.name, states: s.states ?? {}, depth };
    const parent = stack[stack.length - 1];
    if (parent) node.parentRef = parent.ref;
    if (s.value !== undefined) node.value = s.value;
    if (s.text !== undefined) node.text = s.text;
    if (s.level !== undefined) node.level = s.level;
    stack.push({ depth, ref: node.ref });
    return node;
  });
}

export function buildObservation(
  nodes: ObservedNode[],
  o: { route: string; revision: number; busy?: boolean; tainted?: boolean; pixels?: boolean; masked?: boolean },
): Observation {
  const obs: Observation = {
    revision: o.revision,
    route: o.route,
    nodes,
    busy: o.busy ?? false,
    tainted: o.tainted ?? false,
    treeText: renderTree(nodes, { refs: true }),
    treeHash: treeHash(nodes),
  };
  if (o.pixels) {
    const png = new Uint8Array([137, 80, 78, 71, nodes.length & 0xff]);
    obs.screenshot = { png, sha256: sha256Hex(png), masked: o.masked ?? false };
  }
  return obs;
}

/** The mutable "application" behind a fake session. `effects[stepText]` changes the page when that step is performed or replayed. */
export class FakeWorld {
  route = '/start';
  specs: NodeSpec[] = [{ role: 'heading', name: 'Start', level: 1 }];
  busy = false;
  tainted = false;
  masked = false;
  /** Names of effects applied, in order (acts, replays and heals alike). */
  applied: string[] = [];
  effects = new Map<string, (w: FakeWorld) => void>();

  on(effectName: string, fn: (w: FakeWorld) => void): this {
    this.effects.set(effectName, fn);
    return this;
  }

  apply(effectName: string): void {
    this.applied.push(effectName);
    this.effects.get(effectName)?.(this);
  }

  add(spec: NodeSpec): void {
    this.specs.push(spec);
  }

  remove(name: string): void {
    this.specs = this.specs.filter((s) => s.name !== name);
  }
}

export interface SessionLog {
  opened: string[];
  closed: string[];
  performed: DriverAction[];
}

export class FakeSession implements DriverSession {
  readonly id: string;
  readonly driverId: string;
  readonly driverVersion: string;
  readonly capabilities: DriverCapabilities;
  readonly world: FakeWorld;
  readonly options: SessionOptions;
  private revision = 0;
  closed = false;
  observeCalls: { pixels: boolean }[] = [];
  performed: DriverAction[] = [];
  performHook: ((action: DriverAction, s: FakeSession) => ActionOutcome | undefined) | undefined;

  constructor(opts: {
    id: string;
    driverId: string;
    driverVersion: string;
    capabilities: DriverCapabilities;
    world: FakeWorld;
    options: SessionOptions;
  }) {
    this.id = opts.id;
    this.driverId = opts.driverId;
    this.driverVersion = opts.driverVersion;
    this.capabilities = opts.capabilities;
    this.world = opts.world;
    this.options = opts.options;
  }

  observe(opts?: { pixels?: boolean }): Promise<Observation> {
    this.revision += 1;
    const pixels = opts?.pixels === true;
    this.observeCalls.push({ pixels });
    return Promise.resolve(
      buildObservation(toNodes(this.world.specs), {
        route: this.world.route,
        revision: this.revision,
        busy: this.world.busy,
        tainted: this.world.tainted,
        pixels: pixels && this.capabilities.pixels,
        masked: this.world.masked,
      }),
    );
  }

  perform(action: DriverAction): Promise<ActionOutcome> {
    this.performed.push(action);
    const hooked = this.performHook?.(action, this);
    if (hooked) return Promise.resolve(hooked);
    if (action.verb === 'navigate') this.world.route = new URL(action.url).pathname;
    return Promise.resolve({ ok: true });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export interface FakeDriverOptions {
  id?: string;
  version?: string;
  maxSessions?: number;
  exclusiveResource?: string;
  pixels?: boolean;
  maskingProven?: boolean;
  verbs?: DriverCapabilities['verbs'];
  /** Delay (real ms) while opening a session; used by the concurrency tests. */
  openDelayMs?: number;
  /** Shared world factory; by default every session gets a fresh world from `makeWorld`. */
  makeWorld?: () => FakeWorld;
  onOpen?: (s: FakeSession) => void;
  onClose?: (s: FakeSession) => void;
}

export class FakeDriver implements Driver {
  readonly id: string;
  readonly version: string;
  readonly capabilities: DriverCapabilities;
  sessions: FakeSession[] = [];
  private seq = 0;
  private readonly opts: FakeDriverOptions;

  constructor(opts: FakeDriverOptions = {}) {
    this.opts = opts;
    this.id = opts.id ?? 'fake';
    this.version = opts.version ?? '1.0.0';
    this.capabilities = {
      verbs: opts.verbs ?? ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'],
      pixels: opts.pixels ?? true,
      maskingProven: opts.maskingProven ?? true,
      request: true,
      maxSessions: opts.maxSessions ?? 8,
      ...(opts.exclusiveResource !== undefined ? { exclusiveResource: opts.exclusiveResource } : {}),
    };
  }

  async openSession(options: SessionOptions): Promise<FakeSession> {
    if (this.opts.openDelayMs) await new Promise((r) => setTimeout(r, this.opts.openDelayMs));
    this.seq += 1;
    const world = this.opts.makeWorld?.() ?? new FakeWorld();
    const session = new FakeSession({
      id: `${this.id}-${this.seq}`,
      driverId: this.id,
      driverVersion: this.version,
      capabilities: this.capabilities,
      world,
      options,
    });
    const realClose = session.close.bind(session);
    session.close = async () => {
      this.opts.onClose?.(session);
      await realClose();
    };
    this.sessions.push(session);
    this.opts.onOpen?.(session);
    return session;
  }

  selfCheck(): Promise<{ ok: boolean; problems: string[] }> {
    return Promise.resolve({ ok: true, problems: [] });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
