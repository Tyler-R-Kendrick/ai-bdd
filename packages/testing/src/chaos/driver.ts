import {
  AiBddError,
  type ActionOutcome,
  type Driver,
  type DriverAction,
  type DriverContext,
  type DriverFactory,
  type DriverSession,
  type ErrorCode,
  type JsonValue,
  type Observation,
  type SessionOptions,
} from '@ai-bdd/sdk/contracts';
import { renderTree, sha256Hex, treeHash } from '@ai-bdd/sdk';
import {
  DRIVER_HOOKS,
  cursorsFor,
  createRecorder,
  decide,
  hang,
  validateDriverPlan,
  type ChaosEvent,
  type ChaosOptions,
  type DriverFault,
  type DriverFaultPlan,
  type DriverHook,
  type GarbleMode,
} from './plan.ts';
import { seededRandom, type SeededRandom } from './random.ts';

export interface ChaosDriverStats {
  /** Calls that reached the wrapper, per hook (faulted or not). */
  readonly calls: Record<DriverHook, number>;
  /** Injections per hook. */
  readonly faults: Record<DriverHook, number>;
  /** Drivers `create` produced / `dispose` was called on. */
  readonly driversCreated: number;
  readonly driversDisposed: number;
  /** Ids of the sessions the wrapped driver handed out, in order. */
  readonly sessionsOpened: readonly string[];
  /** Ids of the sessions whose `close()` was called at least once. */
  readonly sessionsClosed: readonly string[];
  /** Opened sessions `close()` was never called on: a leak. */
  openSessions(): string[];
  /** Total of the `latency` / `timeout` delays requested from the (virtual) sleep. */
  virtualDelayMs(): number;
}

export type ChaosDriverFactory = DriverFactory & {
  readonly plan: DriverFaultPlan;
  /** The plan's seed as text: print it when a chaos test fails. */
  readonly seed: string;
  readonly events: readonly ChaosEvent[];
  readonly stats: ChaosDriverStats;
};

const zeroHooks = (): Record<DriverHook, number> => Object.fromEntries(DRIVER_HOOKS.map((h) => [h, 0])) as Record<DriverHook, number>;

function errorFor(fault: Extract<DriverFault, { kind: 'throw' }>, hook: DriverHook): AiBddError {
  return new AiBddError(fault.code, fault.message ?? `chaos: injected ${fault.code} at ${hook}`, {
    ...(fault.retryable === undefined ? {} : { retryable: fault.retryable }),
    details: { chaos: true, hook },
  });
}

/** Damage an observation the way a buggy or racing driver would. `recompute` keeps `treeText` / `treeHash` in step with the damaged nodes. */
export function garbleObservation(obs: Observation, mode: Exclude<GarbleMode, 'stale'>, rng: SeededRandom): Observation {
  const out: Observation = { ...obs, nodes: obs.nodes.map((n) => ({ ...n, states: { ...n.states } })) };
  const nodes = out.nodes as unknown as Record<string, unknown>[];
  switch (mode) {
    case 'shuffle':
      out.nodes = rng.shuffle(out.nodes);
      break;
    case 'duplicate-refs': {
      const refs = obs.nodes.map((n) => n.ref);
      const count = Math.max(1, Math.floor(nodes.length / 2));
      for (let i = 0; i < count && nodes.length > 1; i += 1) {
        const victim = nodes[rng.int(nodes.length)] as Record<string, unknown>;
        victim['ref'] = rng.pick(refs);
      }
      break;
    }
    case 'drop-fields': {
      const fields = ['role', 'name', 'states', 'depth', 'ref'];
      nodes.forEach((n, i) => {
        if (i === 0 || rng.chance(0.5)) delete n[rng.pick(fields)];
      });
      break;
    }
    case 'wrong-types': {
      const damage: ((n: Record<string, unknown>) => void)[] = [
        (n) => void (n['name'] = 42),
        (n) => void (n['states'] = null),
        (n) => void (n['depth'] = 'deep'),
        (n) => void (n['role'] = null),
      ];
      nodes.forEach((n, i) => {
        if (i === 0 || rng.chance(0.5)) rng.pick(damage)(n);
      });
      break;
    }
    case 'drop-nodes':
      out.nodes = out.nodes.filter((_, i) => (i === 0 ? false : rng.chance(0.5)));
      break;
    case 'empty':
      out.nodes = [];
      break;
  }
  try {
    out.treeText = renderTree(out.nodes, { refs: true });
    out.treeHash = treeHash(out.nodes);
  } catch {
    // damaged beyond rendering: keep the hash consistent with the damage anyway
    out.treeText = `<garbled ${mode}>`;
    out.treeHash = sha256Hex(JSON.stringify(out.nodes));
  }
  return out;
}

/**
 * Wraps a `DriverFactory` so that a seeded plan of faults strikes `create`, `openSession`, `observe`, `perform`, `request`,
 * `close`, `selfCheck` and `dispose`. The wrapper keeps the inner factory's `id` (recordings stay under the same driver id),
 * counts calls, and records every injected fault in `events`; it never mocks the inner driver, it only decorates it.
 *
 * `close` and `dispose` faults of kind `throw`, `throw-raw` and `hang` strike AFTER the real call, so injected failures can
 * never leak the wrapped driver's own resources.
 */
export function chaosDriver(factory: DriverFactory, plan: DriverFaultPlan, options: ChaosOptions = {}): ChaosDriverFactory {
  validateDriverPlan(plan);
  const cursors = cursorsFor(plan);
  const rng = seededRandom(plan.seed).fork('driver');
  const rec = createRecorder(options);
  const calls = zeroHooks();
  const faults = zeroHooks();
  const opened: string[] = [];
  const closed = new Set<string>();
  const stats = { driversCreated: 0, driversDisposed: 0 };

  interface Fired {
    index: number;
    fault: DriverFault;
  }

  /** Evaluates every rule for one call, in plan order. All matching rules consume their draws, whatever fires. */
  function strike(hook: DriverHook, ctx: { verb?: string; ordinal?: number; sessionId?: string } = {}): Fired[] {
    calls[hook] += 1;
    const fired: Fired[] = [];
    plan.rules.forEach((rule, index) => {
      if (rule.at !== hook) return;
      if (rule.verb !== undefined && rule.verb !== ctx.verb) return;
      if (rule.session !== undefined && rule.session !== ctx.ordinal) return;
      const cursor = cursors[index];
      if (cursor !== undefined && decide(rule, cursor)) fired.push({ index, fault: rule.fault });
    });
    return fired;
  }

  function note(hook: DriverHook, f: Fired, sessionId?: string, detail?: string): void {
    faults[hook] += 1;
    rec.record({ at: hook, rule: f.index, fault: f.fault.kind, ...(sessionId === undefined ? {} : { session: sessionId }), ...(detail === undefined ? {} : { detail }) });
  }

  /** Runs the latency faults, then returns the first terminal fault (if any). */
  async function delay(hook: DriverHook, fired: Fired[], sessionId?: string): Promise<Fired | undefined> {
    for (const f of fired) {
      if (f.fault.kind === 'latency') {
        note(hook, f, sessionId, `${f.fault.ms} ms`);
        await rec.sleep(f.fault.ms);
      }
    }
    return fired.find((f) => f.fault.kind !== 'latency');
  }

  /** Raise (or hang on) a terminal throw-like fault. Returns normally for the other kinds. */
  async function raise(hook: DriverHook, f: Fired | undefined, sessionId?: string): Promise<void> {
    if (f === undefined) return;
    const fault = f.fault;
    if (fault.kind === 'throw') {
      note(hook, f, sessionId, fault.code);
      throw errorFor(fault, hook);
    }
    if (fault.kind === 'throw-raw') {
      note(hook, f, sessionId);
      throw new Error(fault.message ?? `chaos: injected raw error at ${hook}`);
    }
    if (fault.kind === 'hang') {
      note(hook, f, sessionId);
      await hang();
    }
  }

  function wrapSession(inner: DriverSession, ordinal: number): DriverSession {
    let dropped: AiBddError | undefined;
    let lastObservation: Observation | undefined;
    const sid = inner.id;

    const lost = (): AiBddError => dropped as AiBddError;
    const drop = (f: Fired, hook: DriverHook): never => {
      const fault = f.fault as Extract<DriverFault, { kind: 'drop-session' }>;
      note(hook, f, sid, 'session dropped');
      dropped = new AiBddError(fault.code ?? 'DRIVER_ERROR', fault.message ?? `chaos: session ${sid} was lost`, { details: { chaos: true, hook } });
      throw dropped;
    };

    const session: DriverSession = {
      get id() {
        return inner.id;
      },
      get driverId() {
        return inner.driverId;
      },
      get driverVersion() {
        return inner.driverVersion;
      },
      get capabilities() {
        return inner.capabilities;
      },
      async observe(opts) {
        if (dropped !== undefined) {
          calls.observe += 1;
          throw lost();
        }
        const fired = strike('observe', { ordinal, sessionId: sid });
        const terminal = await delay('observe', fired, sid);
        await raise('observe', terminal, sid);
        if (terminal?.fault.kind === 'drop-session') drop(terminal, 'observe');
        if (terminal?.fault.kind === 'garble') {
          const mode = terminal.fault.mode;
          if (mode === 'stale') {
            note('observe', terminal, sid, lastObservation === undefined ? 'stale (nothing to replay yet)' : 'stale');
            if (lastObservation !== undefined) return structuredClone(lastObservation);
          } else {
            const real = await inner.observe(opts);
            lastObservation = real;
            note('observe', terminal, sid, mode);
            return garbleObservation(real, mode, rng.fork(`observe-${calls.observe}`));
          }
        }
        const real = await inner.observe(opts);
        lastObservation = real;
        return real;
      },
      async perform(action: DriverAction): Promise<ActionOutcome> {
        if (dropped !== undefined) {
          calls.perform += 1;
          throw lost();
        }
        const fired = strike('perform', { verb: action.verb, ordinal, sessionId: sid });
        const terminal = await delay('perform', fired, sid);
        await raise('perform', terminal, sid);
        if (terminal?.fault.kind === 'drop-session') drop(terminal, 'perform');
        if (terminal?.fault.kind === 'fail') {
          const fault = terminal.fault;
          const code: ErrorCode = fault.code ?? 'DRIVER_ERROR';
          note('perform', terminal, sid, code);
          const error = new AiBddError(code, fault.message ?? `chaos: injected ${code} outcome`, {
            ...(fault.retryable === undefined ? {} : { retryable: fault.retryable }),
          });
          return { ok: false, error: error.toPayload() };
        }
        return inner.perform(action);
      },
      async close() {
        closed.add(sid);
        const terminal = await delay('close', strike('close', { ordinal, sessionId: sid }), sid);
        await inner.close();
        await raise('close', terminal, sid);
      },
    };

    if (inner.request !== undefined) {
      const innerRequest = inner.request.bind(inner);
      session.request = async (req) => {
        if (dropped !== undefined) {
          calls.request += 1;
          throw lost();
        }
        const fired = strike('request', { ordinal, sessionId: sid });
        const terminal = await delay('request', fired, sid);
        await raise('request', terminal, sid);
        if (terminal?.fault.kind === 'drop-session') drop(terminal, 'request');
        if (terminal?.fault.kind === 'fail') {
          note('request', terminal, sid, String(terminal.fault.status ?? 503));
          return { status: terminal.fault.status ?? 503, body: (terminal.fault.message ?? 'chaos: injected request failure') as JsonValue };
        }
        return innerRequest(req);
      };
    }
    return session;
  }

  function wrapDriver(inner: Driver): Driver {
    return {
      get id() {
        return inner.id;
      },
      get version() {
        return inner.version;
      },
      get capabilities() {
        return inner.capabilities;
      },
      async openSession(so: SessionOptions) {
        const fired = strike('openSession');
        await raise('openSession', await delay('openSession', fired));
        const session = await inner.openSession(so);
        opened.push(session.id);
        return wrapSession(session, opened.length);
      },
      async selfCheck() {
        const fired = strike('selfCheck');
        const terminal = await delay('selfCheck', fired);
        await raise('selfCheck', terminal);
        if (terminal?.fault.kind === 'fail') {
          note('selfCheck', terminal);
          return { ok: false, problems: [terminal.fault.message ?? 'chaos: injected selfCheck failure'] };
        }
        return inner.selfCheck();
      },
      async dispose() {
        stats.driversDisposed += 1;
        const terminal = await delay('dispose', strike('dispose'));
        await inner.dispose();
        await raise('dispose', terminal);
      },
    };
  }

  const chaos: ChaosDriverFactory = {
    id: factory.id,
    plan,
    seed: seededRandom(plan.seed).seed,
    events: rec.events,
    stats: {
      calls,
      faults,
      get driversCreated() {
        return stats.driversCreated;
      },
      get driversDisposed() {
        return stats.driversDisposed;
      },
      get sessionsOpened() {
        return opened;
      },
      get sessionsClosed() {
        return opened.filter((id) => closed.has(id));
      },
      openSessions: () => opened.filter((id) => !closed.has(id)),
      virtualDelayMs: rec.virtualDelayMs,
    },
    async create(ctx: DriverContext) {
      const fired = strike('create');
      await raise('create', await delay('create', fired));
      const inner = await factory.create(ctx);
      stats.driversCreated += 1;
      return wrapDriver(inner);
    },
  };
  return chaos;
}
