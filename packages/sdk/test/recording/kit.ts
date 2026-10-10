import type {
  ActionOutcome,
  DriverAction,
  DriverCapabilities,
  DriverSession,
  NodeStates,
  ObservedNode,
  Observation,
  Policy,
  SettleOptions,
  SettleResult,
  Settler,
  Step,
} from '../../src/contracts/index.ts';
import { renderTree, treeHash } from '../../src/util/index.ts';

let counter = 0;

export function node(role: string, name: string, extra: Partial<Omit<ObservedNode, 'role' | 'name'>> = {}): ObservedNode {
  counter++;
  return { ref: extra.ref ?? `e${counter}`, role, name, states: {}, depth: 0, ...extra };
}

/** Build an observation; computes treeText/treeHash with the real util so hashes are realistic. */
export function observation(nodes: ObservedNode[], route = '/', extra: Partial<Observation> = {}): Observation {
  return {
    revision: 0,
    route,
    nodes,
    busy: false,
    tainted: false,
    treeText: renderTree(nodes, { refs: false }),
    treeHash: treeHash(nodes),
    ...extra,
  };
}

/** Pre-order nodes from a nested spec; sets depth and parentRef. */
export interface Tree { role: string; name: string; states?: NodeStates; value?: string; testId?: string; level?: number; children?: Tree[] }
export function fromTrees(trees: Tree[]): ObservedNode[] {
  const out: ObservedNode[] = [];
  const visit = (t: Tree, depth: number, parent: ObservedNode | undefined): void => {
    const n: ObservedNode = { ref: `r${out.length + 1}-${counter++}`, role: t.role, name: t.name, states: t.states ?? {}, depth };
    if (t.value !== undefined) n.value = t.value;
    if (t.testId !== undefined) n.testId = t.testId;
    if (t.level !== undefined) n.level = t.level;
    if (parent !== undefined) n.parentRef = parent.ref;
    out.push(n);
    for (const c of t.children ?? []) visit(c, depth + 1, n);
  };
  for (const t of trees) visit(t, 0, undefined);
  return out;
}

export const POLICY: Policy = { allowHosts: ['localhost', '127.0.0.1'], denyVerbs: [] };

export const CAPS: DriverCapabilities = {
  verbs: ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'],
  pixels: false,
  maskingProven: false,
  request: false,
  maxSessions: 4,
};

export function step(params: Record<string, string> = {}, text = 'the user does a thing'): Step {
  return { key: 'when:abc', kind: 'when', text, grounding: 'inferred', sources: [], params };
}

/** Settler double: one observe() per settle() call; records how many were requested. */
export function immediateSettler(): Settler & { calls: number; opts: SettleOptions[] } {
  const s = {
    calls: 0,
    opts: [] as SettleOptions[],
    async settle(session: DriverSession, opts: SettleOptions): Promise<SettleResult> {
      s.calls++;
      s.opts.push(opts);
      return { settled: true, observation: await session.observe(), polls: 1 };
    },
  };
  return s;
}

export interface AppState { route: string; nodes: ObservedNode[] }

/** DriverSession double driven by a reducer over a mutable app state. */
export class FakeSession implements DriverSession {
  readonly id = 'fake-session';
  readonly driverId = 'fake';
  readonly driverVersion = '1.0.0';
  readonly capabilities: DriverCapabilities = CAPS;
  readonly performed: DriverAction[] = [];
  observations = 0;
  revision = 0;
  state: AppState;
  private readonly reduce: (action: DriverAction, state: AppState) => ActionOutcome | void;
  constructor(state: AppState, reduce: (action: DriverAction, state: AppState) => ActionOutcome | void = () => undefined) {
    this.state = state;
    this.reduce = reduce;
  }
  async observe(): Promise<Observation> {
    this.observations++;
    return observation(this.state.nodes.map((n) => ({ ...n })), this.state.route, { revision: this.revision++ });
  }
  async perform(action: DriverAction): Promise<ActionOutcome> {
    this.performed.push(action);
    return this.reduce(action, this.state) ?? { ok: true };
  }
  async close(): Promise<void> {}
}
