import type { ActActor, ActActorRegistry, ActCapabilities } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';

/**
 * The actor registry.
 *
 * A project selects an actor by id and the runtime resolves it at step time, so the
 * provider behind an intent is a configuration value rather than a code path. The four
 * shipped actors are `model` (a model loop over a driver), `e2e` (e2e's own
 * `agent.act`, via `@ai-bdd/e2e-host`), `scripted` (a deterministic recorded actor) and
 * any third party implementation of the interface.
 */
export function createActorRegistry(options: { defaultActorId?: string } = {}): ActActorRegistry {
  const actors = new Map<string, ActActor>();
  let defaultId = options.defaultActorId;
  return {
    register(actor) {
      if (actor.id.length === 0) throw new AiBddError('CONFIG_INVALID', 'an actor needs an id');
      actors.set(actor.id, actor);
      if (defaultId === undefined) defaultId = actor.id;
    },
    get(id) {
      return actors.get(id);
    },
    list() {
      return [...actors.values()].map((actor) => ({ id: actor.id, version: actor.version, capabilities: actor.capabilities }));
    },
    default() {
      return defaultId !== undefined ? actors.get(defaultId) : undefined;
    },
    setDefault(id) {
      if (!actors.has(id)) throw new AiBddError('CONFIG_INVALID', `unknown actor "${id}"`);
      defaultId = id;
    },
  };
}

/**
 * Wraps an actor so every call is observable, which is what the runtime uses to log a
 * step's provider without every provider repeating the bookkeeping.
 */
export function withTelemetry(
  actor: ActActor,
  onCall: (event: { actorId: string; intent: string; status: string; modelCalls: number; actions: number; ms: number }) => void,
): ActActor {
  return {
    ...actor,
    async act(request) {
      const started = Date.now();
      const result = await actor.act(request);
      onCall({
        actorId: actor.id,
        intent: request.intent.text,
        status: result.status,
        modelCalls: result.modelCalls,
        actions: result.actions.length,
        ms: Date.now() - started,
      });
      return result;
    },
  };
}

/** The capabilities a scripted actor declares, reused by the fakes in tests. */
export const SCRIPTED_CAPABILITIES: ActCapabilities = {
  drivesUi: false,
  records: true,
  handoff: false,
  video: false,
  evidence: ['action-log'],
};
