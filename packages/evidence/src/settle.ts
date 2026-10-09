import type { DriverSession, Observation, SettleOptions, SettleResult } from '@ai-bdd/contracts';
import { DEFAULT_SETTLE } from '@ai-bdd/contracts';

export type Sleep = (ms: number) => Promise<void>;

/**
 * Driver-agnostic settle detection (section 8.6).
 *
 * The screen is settled when the tree hash is unchanged across a quiet window and
 * the pixel diff ratio stays under the tolerance. A driver without pixels decides
 * on the tree hash alone. On timeout the last observation is returned with
 * `settled: false`, which becomes SCREEN_NOT_SETTLED when `evidence.requireSettled`
 * is set.
 */
export async function settle(
  session: DriverSession,
  options: Partial<SettleOptions> = {},
  deps: { sleep?: Sleep; now?: () => number; diffRatio?: (a: Uint8Array, b: Uint8Array) => number; readArtifact?: (ref: string) => Promise<Uint8Array | undefined> } = {},
): Promise<SettleResult> {
  const config: SettleOptions = { ...DEFAULT_SETTLE, ...options };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const diff = deps.diffRatio ?? diffRatio;
  const started = now();

  let attempts = 0;
  let last: Observation | undefined;
  let quietStart = started;

  while (now() - started <= config.timeoutMs) {
    attempts += 1;
    const observation = await session.observe({ pixels: true });
    // A driver that knows it is mid-transition (a spinner, an in-flight request)
    // reports settled: false; a stable hash alone must not override that.
    const sameTree = last !== undefined && observation.treeHash === last.treeHash && observation.settled;
    let samePixels = true;
    if (last?.screenshot && observation.screenshot) {
      const [before, after] = await Promise.all([
        deps.readArtifact?.(last.screenshot.sha256),
        deps.readArtifact?.(observation.screenshot.sha256),
      ]);
      if (before && after) samePixels = diff(before, after) <= config.pixelTolerance;
      else samePixels = last.screenshot.sha256 === observation.screenshot.sha256;
    }

    if (sameTree && samePixels) {
      if (now() - quietStart >= config.quietMs) {
        return { settled: true, observation, attempts, elapsedMs: now() - started };
      }
    } else {
      quietStart = now();
    }
    last = observation;
    if (now() - started + config.intervalMs > config.timeoutMs) break;
    await sleep(config.intervalMs);
  }

  const observation = last ?? (await session.observe());
  return {
    settled: false,
    observation: { ...observation, settled: false },
    attempts,
    elapsedMs: now() - started,
    reason: 'the screen did not settle within the quiet window before the deadline',
  };
}

/**
 * Ratio of differing bytes between two images. The real driver layer compares
 * decoded pixels (pixelmatch); this byte-level fallback keeps the contract
 * honest for drivers that hand back undecoded captures.
 */
export function diffRatio(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 && b.length === 0) return 0;
  const length = Math.max(a.length, b.length);
  let differing = Math.abs(a.length - b.length);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) differing += 1;
  }
  return differing / length;
}
