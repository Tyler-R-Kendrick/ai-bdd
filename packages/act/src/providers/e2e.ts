import type { ActActor, ActRequest, ActResult, HandoffRequest, RecordedAction, Selector } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';

/**
 * The minimal surface of e2e's public agent fixture (`e2e`, `e2e/agent`).
 *
 * Only these members are used, and the caller injects them: `@ai-bdd/e2e-host` passes the
 * fixture e2e hands to a test body, so nothing here imports an e2e internal path (N5).
 */
export interface E2eAgentLike {
  act(text: string, options?: Record<string, unknown>): Promise<unknown>;
  assert?(text: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** The e2e fixture surface the actor can also read, when a project exposes it. */
export interface E2eScreenLike {
  screenshot?(): Promise<Uint8Array | undefined>;
  route?(): Promise<string | undefined>;
}

export interface E2eActorOptions {
  id?: string;
  version?: string;
  /** The agent fixture e2e passes into a test body. */
  agent: E2eAgentLike;
  /** Optional: the screen/device fixture, when the project exposes one. */
  screen?: E2eScreenLike;
  /** Recorded by e2e's own cache; this actor does not keep its own reproduction. */
  records?: boolean;
}

interface AgentOutcome {
  actions?: Array<{ verb?: string; selector?: Selector; description?: string }>;
  summary?: string;
  status?: string;
  finalizedBy?: string;
}

/**
 * An act actor that delegates to e2e's own agent.
 *
 * This is the swap-in the specification calls for: `When` never mentions e2e, and the
 * e2e-specific behaviour (its replay cache, its self-finalised hand-off) lives entirely
 * in this provider. A project using `--actor e2e` gets e2e's native cache; a project
 * using `--actor model` gets ai-bdd's own. The spec does not change.
 */
export function e2eActor(options: E2eActorOptions): ActActor {
  return {
    id: options.id ?? 'e2e',
    version: options.version ?? '0.1.0',
    capabilities: {
      drivesUi: true,
      records: options.records ?? true,
      handoff: true,
      video: false,
      evidence: ['action-log', 'observation'],
    },
    async act(request: ActRequest): Promise<ActResult> {
      const params = request.intent.params;
      try {
        const raw = await options.agent.act(request.intent.text, {
          params,
          ...(request.context !== undefined ? { context: request.context } : {}),
          ...(request.correction?.guidance !== undefined ? { guidance: request.correction.guidance } : {}),
        });
        const outcome = (raw ?? {}) as AgentOutcome;
        const actions: RecordedAction[] = (outcome.actions ?? []).map((action) => ({
          verb: (action.verb ?? 'tap') as RecordedAction['verb'],
          ...(action.selector !== undefined ? { selector: action.selector } : {}),
        }));
        const finalizedBy = outcome.finalizedBy ?? outcome.status;
        // e2e reports a replay that had to finish with the agent as `agent-concluded` or
        // `missed`; ai-bdd reports that as `healed`, never as a plain pass (R-K22).
        const healed = finalizedBy === 'agent-concluded' || finalizedBy === 'missed';
        const route = await options.screen?.route?.().catch(() => undefined);
        return {
          status: 'done',
          actions,
          modelCalls: 0,
          determinism: healed ? 'unknown' : 'deterministic',
          start: { landmarks: [], ...(route !== undefined ? { route } : {}) },
          ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
          ...(healed ? { summary: outcome.summary ?? 'e2e completed the step with its agent after a cache miss' } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const handoff: HandoffRequest = {
          reason: /budget|limit|exhaust/iu.test(message) ? 'budget-exhausted' : 'stuck',
          intent: request.intent.text,
          message: `e2e's agent could not complete the step: ${message}`,
          attempted: [],
          observation: request.observation,
        };
        const correction = await request.onHandoff?.(handoff);
        if (correction !== undefined) {
          return this.act({ ...request, correction });
        }
        return {
          status: 'handoff',
          actions: [],
          modelCalls: 0,
          handoff,
          error: { code: 'ACT_BLOCKED', message, retryable: false },
        };
      }
    },
  };
}

export function requireE2eAgent(agent: E2eAgentLike | undefined): E2eAgentLike {
  if (!agent || typeof agent.act !== 'function') {
    throw new AiBddError(
      'CONFIG_INVALID',
      'the e2e actor needs the agent fixture e2e passes into a test body; use it from @ai-bdd/e2e-host',
    );
  }
  return agent;
}
