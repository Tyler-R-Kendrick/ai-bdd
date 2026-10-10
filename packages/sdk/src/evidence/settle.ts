import { AiBddError, type CreateSettler, type DriverSession, type Observation, type SettleOptions, type SettleResult } from '../contracts/index.ts';
import { systemClock } from './clock.ts';

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
        const obs = await session.observe({ pixels: false });
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
          const withPixels = await session.observe({ pixels: true });
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
        observation = await session.observe({ pixels: true });
        polls += 1;
      }
      return { settled: false, observation, polls };
    },
  };
};
