import { decode } from 'fast-png';
import pixelmatch from 'pixelmatch';
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
/**
 * Ratio of differing pixels between two PNG captures (section 8.6).
 *
 * The comparison decodes both images and runs pixelmatch with the documented 0.1
 * threshold, because two captures of the same static screen can still differ in
 * their encoded bytes (zlib chunking, metadata) while being pixel-identical — a
 * byte comparison would make settle detection never converge on a real browser.
 */
export function diffRatio(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 && b.length === 0) return 0;
  try {
    const left = decodePng(a);
    const right = decodePng(b);
    if (left.width !== right.width || left.height !== right.height) return 1;
    const total = left.width * left.height;
    if (total === 0) return 0;
    const differing = pixelmatchCompat(left.data, right.data, null, left.width, left.height, { threshold: 0.1 });
    return differing / total;
  } catch {
    // An undecodable capture falls back to a byte comparison, which is stricter.
    return byteDiffRatio(a, b);
  }
}

interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function decodePng(bytes: Uint8Array): DecodedImage {
  const decoded = decode(bytes) as { width: number; height: number; data: Uint8Array; channels?: number };
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

/** Counts differing pixels with a YIQ-style perceptual threshold. */
function pixelmatchCompat(
  left: Uint8Array,
  right: Uint8Array,
  output: Uint8Array | null,
  width: number,
  height: number,
  options: { threshold: number },
): number {
  try {
    return pixelmatch(left, right, output, width, height, { threshold: options.threshold });
  } catch {
    // pixelmatch needs RGBA input; a grayscale capture is compared channel by channel.
    const channels = left.length / (width * height);
    let differing = 0;
    for (let index = 0; index < width * height; index += 1) {
      let different = false;
      for (let channel = 0; channel < channels; channel += 1) {
        const offset = index * channels + channel;
        if (Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) > options.threshold * 255) {
          different = true;
          break;
        }
      }
      if (different) differing += 1;
    }
    return differing;
  }
}

function byteDiffRatio(a: Uint8Array, b: Uint8Array): number {
  const length = Math.max(a.length, b.length);
  let differing = Math.abs(a.length - b.length);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) differing += 1;
  }
  return differing / length;
}
