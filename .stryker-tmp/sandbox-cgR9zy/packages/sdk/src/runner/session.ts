// @ts-nocheck
import {
  AiBddError,
  type DriverSession,
  type Observation,
  type SessionOptions,
  type SettleResult,
  type ValueSource,
} from '../contracts/index.ts';
import { checkNavigation } from '../util/index.ts';
import type { ResolveHolder, ScenarioEnv, SessionState } from './types.ts';
import { ObservationRing } from './support.ts';

/** Wants a screenshot with the settled observation: only when a judge could use it. */
export function wantsPixels(env: ScenarioEnv, st: SessionState): boolean {
  return env.deps.config.judge.vision && st.session.capabilities.pixels;
}

export async function settleState(
  env: ScenarioEnv,
  st: { session: DriverSession; ring: ObservationRing },
  pixels: boolean,
): Promise<SettleResult> {
  const extra: { pixels?: boolean; signal?: AbortSignal } = {};
  if (pixels) extra.pixels = true;
  if (env.opts.signal) extra.signal = env.opts.signal;
  const result = await env.deps.settler.settle(st.session, env.settleOpts, extra);
  st.ring.remember(result.observation, result.settled);
  return result;
}

/**
 * A settled observation without needless re-observing (§9.6 ring). `settled` is false when the screen never reached the
 * quiet window; callers decide what an unsettled observation may be used for (it is never silently treated as settled).
 */
export async function settledObservation(
  env: ScenarioEnv, st: SessionState, pixels: boolean,
): Promise<{ observation: Observation; settled: boolean }> {
  const cached = st.ring.take(pixels);
  if (cached !== undefined) return { observation: cached, settled: true };
  const r = await settleState(env, st, pixels);
  return { observation: r.observation, settled: r.settled };
}

function makeResolver(env: ScenarioEnv, holder: ResolveHolder): (v: ValueSource) => string {
  return (v) => {
    if ('literal' in v) return v.literal;
    if ('param' in v) {
      const value = holder.params[v.param];
      if (value === undefined) {
        const err = new AiBddError('INTERNAL', `step has no parameter "${v.param}"`, { details: { param: v.param } });
        holder.secretError ??= err;
        throw err;
      }
      return value;
    }
    const secret = env.deps.secretValue(v.secret);
    if (secret === undefined) {
      const envVar = env.deps.config.secrets[v.secret]?.env;
      const err = new AiBddError('SECRET_MISSING', `secret "${v.secret}" has no value${envVar ? ` (set ${envVar})` : ''}`, {
        details: { secret: v.secret },
      });
      holder.secretError ??= err;
      throw err;
    }
    return secret;
  };
}

/**
 * Open a session (§9.2): adopt `sessionFactory` or use the resolved driver, navigate to the start URL
 * through `checkNavigation`, then settle the scenario's first observation. Closes the session on failure.
 */
export async function prepareSession(env: ScenarioEnv): Promise<SessionState> {
  const { deps, target, opts } = env;
  const { config } = deps;
  const holder: ResolveHolder = { params: {}, secretError: undefined };
  const sessionOpts: SessionOptions = {
    scenarioId: target.scenario.id,
    policy: config.policy,
    resolveValue: makeResolver(env, holder),
  };
  if (config.baseURL !== undefined) sessionOpts.baseURL = config.baseURL;

  let session: DriverSession;
  if (opts.sessionFactory) session = await opts.sessionFactory(sessionOpts);
  else if (env.driver) session = await env.driver.openSession(sessionOpts);
  else throw new AiBddError('CONFIG_INVALID', 'no driver available to open a session');

  const ring = new ObservationRing();
  try {
    const startUrl = target.scenario.startUrl ?? config.baseURL;
    if (startUrl !== undefined && session.capabilities.verbs.includes('navigate')) {
      const nav = checkNavigation(startUrl, config.baseURL, config.policy);
      if (!nav.ok) {
        throw new AiBddError('POLICY_DENIED', `start URL ${startUrl} denied: ${nav.reason}`, { details: { url: startUrl } });
      }
      const outcome = await session.perform({ verb: 'navigate', url: nav.url });
      if (!outcome.ok) {
        throw new AiBddError(outcome.error?.code ?? 'DRIVER_ERROR', outcome.error?.message ?? `navigation to ${nav.url} failed`, {
          ...(outcome.error?.details !== undefined ? { details: outcome.error.details } : {}),
        });
      }
    }
    const firstObs = (await settleState(env, { session, ring }, false)).observation;
    return { session, holder, ring, firstObs, lastRunBefore: undefined, lastRunBeforeSettled: true, inRun: false, cleanups: [], priorSteps: [] };
  } catch (err) {
    await closeQuietly(session);
    throw err;
  }
}

async function closeQuietly(session: { close(): Promise<void> }): Promise<void> {
  try {
    await session.close();
  } catch {
    // closing is best effort on a failed setup
  }
}

/** Fixture cleanups in reverse order, then close the session (§9.7.5). Never throws. */
export async function teardownSession(env: ScenarioEnv, st: SessionState): Promise<void> {
  const scenarioId = env.target.scenario.id;
  for (const cleanup of [...st.cleanups].reverse()) {
    try {
      await cleanup.run();
    } catch (err) {
      env.emit({
        type: 'log',
        level: 'warn',
        scenarioId,
        message: env.deps.redactor.redact(
          `cleanup of fixture "${cleanup.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    }
  }
  st.cleanups.length = 0;
  try {
    await st.session.close();
  } catch (err) {
    env.emit({
      type: 'log',
      level: 'warn',
      scenarioId,
      message: env.deps.redactor.redact(`closing session failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  }
}
