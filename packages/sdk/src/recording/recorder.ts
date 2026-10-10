import {
  AiBddError,
  type ActProgram,
  type ActionOutcome,
  type CreateRecorder,
  type DriverAction,
  type DriverCapabilities,
  type DriverSession,
  type FuzzyReason,
  type Observation,
  type PerformedAction,
  type Policy,
  type RecordedAction,
  type Recorder,
  type Redactor,
  type ReplayOutcome,
  type ReplayResult,
  type Selector,
  type SettleOptions,
  type Settler,
  type Step,
  type ValueSource,
} from '../contracts/index.ts';
import { checkNavigation, normalizeText, sha256Hex } from '../util/index.ts';
import { compareStrings, computeEffect } from './effect.ts';
import { scrubActProgram } from './secrets.ts';
import { deriveSelector, findBySelector } from './selector.ts';
import { verifyEffect } from './verify.ts';

const LANDMARK_ROLES: ReadonlySet<string> = new Set(['banner', 'navigation', 'main', 'region', 'form', 'dialog']);
const DEFAULT_SETTLE: SettleOptions = { quietMs: 300, intervalMs: 100, timeoutMs: 5000 };
/** Roles whose replay needs the `select` verb. */
const SELECT_ROLES: ReadonlySet<string> = new Set(['combobox', 'listbox', 'option']);

/** Optional extras: a runner that knows the driver capabilities can pass them for `agent-only-driver` detection. */
export interface RecorderDeps {
  settler: Settler;
  config: { settle?: Partial<SettleOptions> | undefined };
  capabilities?: DriverCapabilities;
  /**
   * When given, recordings are scrubbed of secrets as they are made (R-SE1): a literal equal to a secret value becomes
   * `{secret: name}`, and effect entries, selector names or routes that hold any secret variant are dropped or redacted.
   * The runner scrubs again with its own redactor, so this is defense in depth.
   */
  redactor?: Redactor;
  secretValue?: (name: string) => string | undefined;
}
export interface ToRecordingOptions { capabilities?: DriverCapabilities }
/** `Recorder` plus the optional capabilities argument of `toRecording` (still assignable to `Recorder`). */
export interface CapabilityAwareRecorder extends Recorder {
  toRecording(
    performed: readonly PerformedAction[], before: Observation, after: Observation, afterProbe: Observation | undefined, step: Step, opts?: ToRecordingOptions,
  ): { act: ActProgram; fuzzyReasons: FuzzyReason[] };
}

/** sha256 over the sorted, unique `role|name` of landmark nodes and level-1 headings. */
export function landmarkHash(obs: Observation): string {
  const set = new Set<string>();
  for (const n of obs.nodes) {
    if (LANDMARK_ROLES.has(n.role) || (n.role === 'heading' && n.level === 1)) set.add(`${n.role}|${normalizeText(n.name)}`);
  }
  return sha256Hex([...set].sort(compareStrings).join('\n'));
}

function slotValue(v: ValueSource, params: Readonly<Record<string, string>>): ValueSource {
  if (!('literal' in v)) return v;
  const wanted = normalizeText(v.literal);
  for (const name of Object.keys(params).sort(compareStrings)) {
    const value = params[name];
    if (value !== undefined && normalizeText(value) === wanted) return { param: name };
  }
  return v;
}

const EMPTY_SELECTOR: Selector = { role: '', name: '', ancestors: [], index: 0, of: 1 };

function targetSelector(p: PerformedAction, ref: string): { selector: Selector; coordinate: boolean } {
  const node = p.target ?? p.chosenFrom.nodes.find((n) => n.ref === ref);
  if (node === undefined) return { selector: { ...EMPTY_SELECTOR, ancestors: [] }, coordinate: true };
  const selector = deriveSelector(node, p.chosenFrom);
  return { selector, coordinate: node.role === '' || normalizeText(node.name) === '' };
}

function recordAction(p: PerformedAction, params: Readonly<Record<string, string>>): { action: RecordedAction; coordinate: boolean; role: string } {
  const a = p.action;
  const role = (): string => p.target?.role ?? '';
  switch (a.verb) {
    case 'navigate':
      return { action: { verb: 'navigate', url: a.url }, coordinate: false, role: '' };
    case 'back':
      return { action: { verb: 'back' }, coordinate: false, role: '' };
    case 'wait':
      return { action: { verb: 'wait', ms: a.ms }, coordinate: false, role: '' };
    case 'click':
    case 'hover': {
      const t = targetSelector(p, a.target.ref);
      return { action: { verb: a.verb, target: t.selector }, coordinate: t.coordinate, role: t.selector.role };
    }
    case 'fill': {
      const t = targetSelector(p, a.target.ref);
      return { action: { verb: 'fill', target: t.selector, value: slotValue(a.value, params) }, coordinate: t.coordinate, role: t.selector.role };
    }
    case 'select': {
      const t = targetSelector(p, a.target.ref);
      return { action: { verb: 'select', target: t.selector, option: slotValue(a.option, params) }, coordinate: t.coordinate, role: t.selector.role };
    }
    case 'check': {
      const t = targetSelector(p, a.target.ref);
      return { action: { verb: 'check', target: t.selector, checked: a.checked }, coordinate: t.coordinate, role: t.selector.role };
    }
    case 'press': {
      if (a.target === undefined) return { action: { verb: 'press', key: a.key }, coordinate: false, role: role() };
      const t = targetSelector(p, a.target.ref);
      return { action: { verb: 'press', key: a.key, target: t.selector }, coordinate: t.coordinate, role: t.selector.role };
    }
    case 'scroll': {
      if (a.target === undefined) return { action: { verb: 'scroll', direction: a.direction }, coordinate: false, role: '' };
      const t = targetSelector(p, a.target.ref);
      return { action: { verb: 'scroll', direction: a.direction, target: t.selector }, coordinate: t.coordinate, role: t.selector.role };
    }
  }
}

function selectorOf(a: RecordedAction): Selector | undefined {
  return 'target' in a ? a.target : undefined;
}

function toDriverAction(a: RecordedAction, ref: string | undefined): DriverAction {
  const target = ref === undefined ? undefined : { ref };
  switch (a.verb) {
    case 'navigate':
    case 'back':
    case 'wait':
      return a;
    case 'click':
    case 'hover':
      return { verb: a.verb, target: { ref: ref ?? '' } };
    case 'fill':
      return { verb: 'fill', target: { ref: ref ?? '' }, value: a.value };
    case 'select':
      return { verb: 'select', target: { ref: ref ?? '' }, option: a.option };
    case 'check':
      return { verb: 'check', target: { ref: ref ?? '' }, checked: a.checked };
    case 'press':
      return target === undefined ? { verb: 'press', key: a.key } : { verb: 'press', key: a.key, target };
    case 'scroll':
      return target === undefined ? { verb: 'scroll', direction: a.direction } : { verb: 'scroll', direction: a.direction, target };
  }
}

function agentOnly(actions: readonly RecordedAction[], roles: readonly string[], caps: DriverCapabilities | undefined): boolean {
  if (caps === undefined) return false;
  const verbs = new Set(caps.verbs);
  if (actions.some((a) => !verbs.has(a.verb))) return true;
  return !verbs.has('select') && roles.some((r) => SELECT_ROLES.has(r));
}

export function createRecorder(deps: RecorderDeps): CapabilityAwareRecorder {
  const settleOpts: SettleOptions = {
    quietMs: deps.config.settle?.quietMs ?? DEFAULT_SETTLE.quietMs,
    intervalMs: deps.config.settle?.intervalMs ?? DEFAULT_SETTLE.intervalMs,
    timeoutMs: deps.config.settle?.timeoutMs ?? DEFAULT_SETTLE.timeoutMs,
  };
  const settle = async (session: DriverSession, signal: AbortSignal | undefined): Promise<{ observation: Observation; settled: boolean }> => {
    const r = await deps.settler.settle(session, settleOpts, signal === undefined ? undefined : { signal });
    return { observation: r.observation, settled: r.settled };
  };

  return {
    toRecording(performed, before, after, afterProbe, step: Step, opts?: ToRecordingOptions) {
      const actions: RecordedAction[] = [];
      const roles: string[] = [];
      let coordinate = false;
      for (const p of performed) {
        if (!p.outcome.ok) continue;
        const r = recordAction(p, step.params);
        actions.push(r.action);
        roles.push(r.role);
        coordinate ||= r.coordinate;
      }
      const effect = computeEffect(before, after, afterProbe);
      const reasons: FuzzyReason[] = [];
      if (coordinate) reasons.push('coordinate-action');
      const empty = effect.appeared.length === 0 && effect.disappeared.length === 0 && effect.changed.length === 0;
      if (empty && effect.routeBefore === effect.routeAfter) reasons.push('no-observable-effect');
      if (agentOnly(actions, roles, opts?.capabilities ?? deps.capabilities)) reasons.push('agent-only-driver');
      const act: ActProgram = { startRoute: before.route, startLandmarks: landmarkHash(before), actions, effect };
      if (deps.redactor === undefined) return { act, fuzzyReasons: reasons };
      const scrubbed = scrubActProgram(act, { redactor: deps.redactor, secretValue: deps.secretValue });
      return { act: scrubbed.act, fuzzyReasons: [...new Set([...reasons, ...scrubbed.fuzzyReasons])] };
    },

    async replay(act, session, ctx): Promise<ReplayResult> {
      const policy: Policy = ctx.policy;
      const aborted = (): void => {
        if (ctx.signal?.aborted) throw new AiBddError('ABORTED', 'replay aborted');
      };
      aborted();
      const beforeR = await settle(session, ctx.signal);
      const before = beforeR.observation;
      // `beforeSettled` extends ReplayResult: the runner must not treat an unsettled start as a baseline for checks (F-14).
      const finish = (outcome: ReplayOutcome, completedActions: number, after: Observation, detail?: string): ReplayResult & { beforeSettled: boolean } =>
        detail === undefined
          ? { outcome, completedActions, before, after, beforeSettled: beforeR.settled }
          : { outcome, completedActions, before, after, detail, beforeSettled: beforeR.settled };

      if (before.route !== act.startRoute) return finish('start-mismatch', 0, before, `route ${before.route} !== ${act.startRoute}`);
      if (landmarkHash(before) !== act.startLandmarks) return finish('start-mismatch', 0, before, 'landmark structure differs from recording');

      let obs = before;
      let done = 0;
      for (const action of act.actions) {
        aborted();
        if (policy.denyVerbs.includes(action.verb)) return finish('policy-denied', done, obs, `verb ${action.verb} is denied by policy`);
        if (action.verb === 'navigate') {
          const nav = checkNavigation(action.url, ctx.baseURL, policy);
          if (!nav.ok) return finish('policy-denied', done, obs, nav.reason);
        }
        const sel = selectorOf(action);
        let ref: string | undefined;
        if (sel !== undefined) {
          const found = findBySelector(sel, obs);
          if (found.status === 'missing') return finish('target-missing', done, obs, `${sel.role} "${sel.name}" not found`);
          if (found.status === 'ambiguous') return finish('target-ambiguous', done, obs, `${sel.role} "${sel.name}": ${found.count} candidates, expected ${sel.of}`);
          ref = found.node.ref;
        }
        let outcome: ActionOutcome;
        try {
          outcome = await session.perform(toDriverAction(action, ref));
        } catch (err) {
          if (err instanceof AiBddError && err.code === 'ABORTED') throw err;
          return finish('action-failed', done, obs, err instanceof Error ? err.message : String(err));
        }
        if (!outcome.ok) return finish('action-failed', done, obs, outcome.error?.message ?? 'driver reported failure');
        done++;
        obs = (await settle(session, ctx.signal)).observation;
      }

      const verdict = verifyEffect(act.effect, before, obs);
      if (!verdict.ok) return finish('effect-unverified', done, obs, verdict.detail);
      return finish('replayed', done, obs);
    },
  };
}

/** Compile-time proof that the implementation satisfies the frozen factory contract. */
export const createRecorderContract: CreateRecorder = createRecorder;
