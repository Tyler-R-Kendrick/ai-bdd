import { AiBddError, type CreateSettler, type DriverSession, type Observation, type SettleOptions, type SettleResult } from '../contracts/index.ts';
import { systemClock } from './clock.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first way an observation breaks the driver contract (`ObservedNode`, `Observation`), or undefined when it is sound. */
function observationProblem(obs: unknown): string | undefined {
  if (!isObject(obs)) return 'it is not an object';
  if (typeof obs['route'] !== 'string') return 'route is not a string';
  if (typeof obs['treeHash'] !== 'string') return 'treeHash is not a string';
  if (typeof obs['treeText'] !== 'string') return 'treeText is not a string';
  if (typeof obs['busy'] !== 'boolean') return 'busy is not a boolean';
  const nodes = obs['nodes'];
  if (!Array.isArray(nodes)) return 'nodes is not an array';
  const refs = new Set<string>();
  for (const [i, node] of (nodes as unknown[]).entries()) {
    if (!isObject(node)) return `nodes[${i}] is not an object`;
    for (const field of ['ref', 'role', 'name'] as const) {
      if (typeof node[field] !== 'string') return `nodes[${i}].${field} is not a string`;
    }
    if (typeof node['depth'] !== 'number' || !Number.isFinite(node['depth'])) return `nodes[${i}].depth is not a number`;
    if (!isObject(node['states'])) return `nodes[${i}].states is not an object`;
    const ref = node['ref'] as string;
    if (refs.has(ref)) return `nodes[${i}].ref "${ref.slice(0, 40)}" duplicates an earlier node (refs must be unique within an observation)`;
    refs.add(ref);
  }
  return undefined;
}

/**
 * Every observation enters the engine here. A driver that breaks the contract (a missing field, a duplicate ref) is a driver bug;
 * it is reported as one, instead of surfacing later as a `TypeError` from deep inside the engine or, worse, as a click on the wrong element.
 */
function checkObservation(obs: Observation): Observation {
  const problem = observationProblem(obs);
  if (problem !== undefined) {
    throw new AiBddError('DRIVER_ERROR', `the driver returned a malformed observation: ${problem}`, { retryable: false, details: { problem } });
  }
  return obs;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AiBddError('ABORTED', 'settle aborted');
}

/**
 * Settle detection (SPEC 10.3, R-RN1).
 *
 * Polls `observe({pixels:false})` every `intervalMs` on the injected clock. The screen is stable when the
 * observation is not busy and its tree hash has been unchanged for at least `quietMs`. A busy observation
 * resets stability. When stable and pixels were requested, one more observation with pixels is taken; if its
 * tree hash differs (or it is busy) polling continues. On timeout the last observation is returned with
 * `settled: false` (with pixels when requested).
 */
export const createSettler: CreateSettler = (opts = {}) => {
  const clock = opts.clock ?? systemClock;
  return {
    async settle(session: DriverSession, so: SettleOptions, extra = {}): Promise<SettleResult> {
      const wantPixels = extra.pixels === true;
      const signal = extra.signal;
      const start = clock.now();
      let polls = 0;
      let lastHash: string | undefined;
      let stableSince: number | undefined;
      let last: Observation | undefined;

      for (;;) {
        throwIfAborted(signal);
        const obs = checkObservation(await session.observe({ pixels: false }));
        polls += 1;
        throwIfAborted(signal);
        const now = clock.now();
        last = obs;

        if (obs.busy) {
          stableSince = undefined;
        } else if (stableSince === undefined || obs.treeHash !== lastHash) {
          stableSince = now;
        }
        lastHash = obs.treeHash;

        if (!obs.busy && stableSince !== undefined && now - stableSince >= so.quietMs) {
          if (!wantPixels) return { settled: true, observation: obs, polls };
          const withPixels = checkObservation(await session.observe({ pixels: true }));
          polls += 1;
          throwIfAborted(signal);
          if (!withPixels.busy && withPixels.treeHash === obs.treeHash) {
            return { settled: true, observation: withPixels, polls };
          }
          // The screen moved while we were taking the screenshot: restart the quiet window from here.
          last = withPixels;
          lastHash = withPixels.treeHash;
          stableSince = withPixels.busy ? undefined : clock.now();
        }

        const remaining = so.timeoutMs - (clock.now() - start);
        if (remaining <= 0) break;
        await clock.sleep(Math.max(1, Math.min(so.intervalMs, remaining)), signal);
      }

      let observation = last;
      if (wantPixels && observation.screenshot === undefined) {
        observation = checkObservation(await session.observe({ pixels: true }));
        polls += 1;
      }
      return { settled: false, observation, polls };
    },
  };
};
