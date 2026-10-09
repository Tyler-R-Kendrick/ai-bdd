import type { ActActor, ActRequest, ActResult, HandoffReason, RecordedAction } from '@ai-bdd/contracts';

/**
 * A scripted actor: the recorded actions come from a table rather than a model.
 *
 * It is what CI runs, and it is the actor a *deterministic* spec uses by design — the
 * table is the reproduction, so every run performs exactly the same actions.
 */
export interface ScriptedStep {
  /** Matches the intent text exactly, after normalization. */
  intent: string;
  actions: RecordedAction[];
  route?: string;
  landmarks?: Array<{ role: string; name?: string }>;
  blocked?: HandoffReason;
}

export interface ScriptedActorOptions {
  id?: string;
  version?: string;
  steps: ScriptedStep[];
  onAction?: (action: RecordedAction) => void;
}

export function scriptedActor(options: ScriptedActorOptions): ActActor {
  const steps = new Map(options.steps.map((step) => [step.intent, step]));
  return {
    id: options.id ?? 'scripted',
    version: options.version ?? '0.1.0',
    capabilities: { drivesUi: false, records: true, handoff: false, video: false, evidence: ['action-log'] },
    async act(request: ActRequest): Promise<ActResult> {
      const step = steps.get(request.intent.text);
      if (!step) {
        return {
          status: 'handoff',
          actions: [],
          modelCalls: 0,
          handoff: {
            reason: 'stuck',
            intent: request.intent.text,
            message: `the scripted actor has no entry for "${request.intent.text}"`,
            attempted: [],
            observation: request.observation,
          },
        };
      }
      if (step.blocked) {
        return {
          status: 'handoff',
          actions: [],
          modelCalls: 0,
          handoff: {
            reason: step.blocked,
            intent: request.intent.text,
            message: `the scripted actor is blocked (${step.blocked})`,
            attempted: [],
            observation: request.observation,
          },
        };
      }
      for (const action of step.actions) {
        options.onAction?.(action);
        await request.onAction?.(action, 'will-perform');
        await request.onAction?.(action, 'performed');
      }
      return {
        status: 'done',
        actions: step.actions,
        modelCalls: 0,
        determinism: 'deterministic',
        start: { landmarks: step.landmarks ?? [], ...(step.route !== undefined ? { route: step.route } : {}) },
      };
    },
  };
}
