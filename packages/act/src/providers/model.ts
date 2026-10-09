import type { ActActor, ActRequest, ActResult, ChatModel, DriverSession, GroundingScorer, RecordedAction } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { createActor } from '../actor.js';
import { computeEffect, deriveSelector, findBySelector, effectSatisfied } from '../selectors.js';

/**
 * The model actor: our own loop over a driver.
 *
 * It is the default provider, and it is driver-agnostic — Playwright, Cua and the fake
 * driver all work through it, because the loop only uses the `DriverSession` contract.
 * e2e can be swapped in by registering the `e2e` actor instead.
 */
export interface ModelActorOptions {
  id?: string;
  version?: string;
  model: ChatModel;
  grounding?: GroundingScorer;
  cache: {
    getAct(key: string): Promise<{ program: never; invalidation: unknown[] } | null>;
    putAct(program: never, ctx: unknown): Promise<void>;
  };
  evidence?: { write(input: { kind: 'action-log' | 'act-program' | 'observation'; data: never; ext: string; stepId?: string; scenarioId?: string }): Promise<unknown> };
  config: {
    maxActions: number;
    maxModelCalls: number;
    grounding: { threshold: number; margin: number };
    policy: { allowHosts: string[]; denyVerbs: string[]; cua?: { allowApps: string[] } };
  };
  /** The driver session a step runs against. */
  session(request: ActRequest): DriverSession;
  now?: () => Date;
}

export function modelActor(options: ModelActorOptions): ActActor {
  return {
    id: options.id ?? 'model',
    version: options.version ?? '0.1.0',
    capabilities: { drivesUi: true, records: true, handoff: true, video: true, evidence: ['action-log', 'observation'] },
    async act(request: ActRequest): Promise<ActResult> {
      const session = options.session(request);
      const loop = createActor({
        model: options.model,
        cache: options.cache as never,
        config: {
          maxActions: request.budget.maxActions,
          maxModelCalls: request.budget.maxModelCalls,
          grounding: options.config.grounding,
          policy: options.config.policy,
        },
        ...(options.grounding !== undefined ? { grounding: options.grounding } : {}),
        ...(options.evidence !== undefined ? { evidence: options.evidence as never } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });

      const outcome = await loop.act(
        { id: request.intent.text, text: request.intent.text, options: {} },
        session,
        {
          params: request.intent.params,
          before: request.observation,
          key: request.previous?.key ?? request.intent.text,
          driver: request.session.driverId,
          driverMajor: request.session.driverMajor,
          ...(request.session.target !== undefined ? { target: String(request.session.target) } : {}),
          ...(request.secrets !== undefined ? { secrets: request.secrets } : {}),
        },
      );

      const actions: RecordedAction[] = outcome.actions.map((action) => ({
        verb: action.verb,
        ...(action.selector !== undefined ? { selector: action.selector } : {}),
        ...(action.value !== undefined ? { value: action.value } : {}),
        ...(action.delivery !== undefined ? { delivery: action.delivery } : {}),
      }));

      if (outcome.status === 'failed') {
        const code = outcome.error?.code ?? 'ACT_BLOCKED';
        const handoff = {
          reason: code === 'ACT_BUDGET_EXHAUSTED' ? ('budget-exhausted' as const) : code === 'ACT_TARGET_AMBIGUOUS' ? ('ambiguous-target' as const) : ('stuck' as const),
          intent: request.intent.text,
          message: outcome.error?.message ?? 'the act loop could not complete the step',
          attempted: actions,
          observation: await session.observe().catch(() => request.observation),
        };
        const correction = await request.onHandoff?.(handoff);
        if (correction !== undefined) {
          // The human's guidance goes back into the loop as a fresh attempt.
          return this.act({
            ...request,
            correction,
          });
        }
        return {
          status: code === 'ACT_BUDGET_EXHAUSTED' ? 'budget-exhausted' : 'handoff',
          actions,
          modelCalls: outcome.modelCalls,
          handoff,
          error: { code, message: handoff.message, retryable: false },
        };
      }

      return {
        status: 'done',
        actions,
        modelCalls: outcome.modelCalls,
        ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        // A replay is deterministic; a fresh recording is not yet proven.
        determinism: outcome.cache.mode === 'replayed' ? 'deterministic' : 'unknown',
        ...(outcome.pending !== undefined ? {} : {}),
      };
    },
  };
}

/**
 * Replays a recorded reproduction against a session and verifies its effect.
 *
 * The rule that makes a reproduction trustworthy: at least one recorded effect element
 * must become **newly** true during the replay. An element that was already present
 * proves nothing, which is what stops a cache from passing when the screen never
 * changed.
 */
export async function replayReproduction(
  reproduction: { start: { route?: string; landmarks: Array<{ role: string; name?: string }> }; actions: RecordedAction[]; effect: { elements: Array<{ selector: import('@ai-bdd/contracts').Selector; change: 'appeared' | 'disappeared' | 'state'; detail?: string }>; route?: { before?: string; after?: string } } },
  session: DriverSession,
  params: Record<string, string> = {},
): Promise<{ status: 'replayed' | 'partial' | 'missed'; performed: number; reason?: string }> {
  const first = await session.observe({ pixels: false });
  if (reproduction.start.route !== undefined && first.route !== undefined && reproduction.start.route !== first.route) {
    return { status: 'missed', performed: 0, reason: `the start route is ${first.route}, expected ${reproduction.start.route}` };
  }
  for (const landmark of reproduction.start.landmarks) {
    const found = findBySelector({ role: landmark.role, ...(landmark.name !== undefined ? { name: landmark.name } : {}) }, first);
    if (found === 'missing') return { status: 'missed', performed: 0, reason: `the start landmark ${landmark.role} is missing` };
  }

  let performed = 0;
  for (const action of reproduction.actions) {
    const observation = await session.observe({ pixels: false });
    const selector = action.selector;
    let ref: string | undefined;
    if (selector) {
      const node = findBySelector(selector, observation);
      if (node === 'missing' || node === 'ambiguous') {
        return { status: 'partial', performed, reason: `the target is ${node}` };
      }
      ref = node.ref;
    }
    const value = action.value === undefined ? undefined : 'literal' in action.value ? action.value.literal : 'param' in action.value ? params[action.value.param] : undefined;
    const result = await session.perform({
      verb: action.verb,
      ...(ref !== undefined ? { ref } : {}),
      ...(value !== undefined ? { value } : {}),
      ...('secret' in (action.value ?? {}) ? { secretName: (action.value as { secret: string }).secret } : {}),
      ...(action.delivery !== undefined ? { delivery: action.delivery } : {}),
    });
    if (!result.ok) return { status: 'partial', performed, reason: result.error ?? `${action.verb} failed` };
    performed += 1;
  }

  const after = await session.observe({ pixels: false });
  const verified = effectSatisfied(reproduction.effect as never, first, after);
  if (!verified) {
    return { status: 'partial', performed, reason: 'the recorded effect was not newly true during the replay' };
  }
  return { status: 'replayed', performed };
}

export { computeEffect, deriveSelector };
export { AiBddError };
