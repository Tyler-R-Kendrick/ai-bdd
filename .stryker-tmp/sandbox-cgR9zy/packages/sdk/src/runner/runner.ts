// @ts-nocheck
import type {
  CreateRunner,
  Driver,
  Runner,
  RunnerDeps,
  ScenarioResult,
  ScenarioRunOptions,
  ScenarioTarget,
} from '../contracts/index.ts';
import { executeScenario } from './scenario.ts';
import { Semaphore } from './sync.ts';
import { makePayload, errorPayload, redactPayload } from './support.ts';

/**
 * The scenario runner (§9). All collaborators arrive through `deps`; nothing here knows a concrete
 * driver, model or store.
 */
export const createRunner: CreateRunner = (deps: RunnerDeps): Runner => {
  /** `exclusiveResource` serializes all sessions declaring the same resource string (R-RN2). */
  const exclusive = new Map<string, Semaphore>();
  /** `capabilities.maxSessions` caps one driver's concurrent scenarios. */
  const perDriver = new Map<string, Semaphore>();

  function semaphore(map: Map<string, Semaphore>, key: string, limit: number): Semaphore {
    let s = map.get(key);
    if (s === undefined) {
      s = new Semaphore(limit);
      map.set(key, s);
    }
    return s;
  }

  function driverNameFor(target: ScenarioTarget, opts: ScenarioRunOptions): string | undefined {
    return target.scenario.driver ?? opts.driver ?? deps.config.defaultDriver;
  }

  /**
   * Gate order is fixed (resource mutex, then driver slots) so two scenarios can never wait on each other.
   * Confirm runs happen inside the same hold: a scenario never has two sessions open at once.
   */
  async function withGate<T>(name: string | undefined, driver: Driver | undefined, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    try {
      if (name !== undefined && driver !== undefined) {
        const caps = driver.capabilities;
        if (caps.exclusiveResource !== undefined) {
          releases.push(await semaphore(exclusive, caps.exclusiveResource, 1).acquire(signal));
        }
        if (Number.isFinite(caps.maxSessions) && caps.maxSessions > 0) {
          releases.push(await semaphore(perDriver, name, caps.maxSessions).acquire(signal));
        }
      }
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async function runScenario(target: ScenarioTarget, opts: ScenarioRunOptions): Promise<ScenarioResult> {
    const name = driverNameFor(target, opts);
    const driver = name === undefined ? undefined : deps.drivers.get(name);
    try {
      return await withGate(name, driver, opts.signal, () => executeScenario(deps, target, opts, driver, name));
    } catch (err) {
      // Only reachable when the gate itself failed (abort while queued) or an internal invariant broke.
      const payload = redactPayload(deps.redactor, err instanceof Error ? errorPayload(err) : makePayload('INTERNAL', String(err)));
      return executeScenario(deps, target, opts, driver, name, payload);
    }
  }

  async function runAll(
    targets: readonly ScenarioTarget[],
    opts: ScenarioRunOptions & { workers: number },
  ): Promise<ScenarioResult[]> {
    const results = new Array<ScenarioResult | undefined>(targets.length).fill(undefined);
    const workers = Math.max(1, Math.min(Math.floor(opts.workers) || 1, targets.length));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        const target = targets[i];
        if (target === undefined) return;
        results[i] = await runScenario(target, opts);
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    return results.filter((r): r is ScenarioResult => r !== undefined);
  }

  return { runScenario, runAll };
};
