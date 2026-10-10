import type {
  ActProgram,
  ActRequest,
  ActResult,
  Actor,
  ArtifactKind,
  ArtifactRef,
  Asserter,
  CheckEvaluation,
  CheckGenRequest,
  CheckGenResult,
  CheckProgram,
  Clock,
  DriverSession,
  EvidenceStore,
  FuzzyReason,
  JsonObject,
  JsonValue,
  Judge,
  JudgeRequest,
  JudgeVerdict,
  Observation,
  PerformedAction,
  Predicate,
  PredicateResult,
  Recorder,
  RecordingStore,
  RecordingsMode,
  Redactor,
  ReplayOutcome,
  ReplayResult,
  ScenarioRecording,
  SettleOptions,
  SettleResult,
  Settler,
  Step,
} from '../../../src/contracts/index.ts';
import { AiBddError } from '../../../src/contracts/index.ts';
import { sha256Hex, stableJson } from '../../../src/util/index.ts';
import type { FakeSession } from './world.ts';
import type { FakeWorld } from './world.ts';

// ───────────────────────── clock

export class FakeClock implements Clock {
  t = 1_000;
  sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}

// ───────────────────────── redactor

export class FakeRedactor implements Redactor {
  readonly secretNames: string[];
  private readonly secrets: Record<string, string>;
  constructor(secrets: Record<string, string> = {}) {
    this.secrets = secrets;
    this.secretNames = Object.keys(secrets);
  }
  redact(text: string): string {
    let out = text;
    for (const [name, value] of Object.entries(this.secrets)) {
      for (const v of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
        out = out.split(v).join(`<secret:${name}>`);
      }
    }
    return out;
  }
  redactJson<T extends JsonValue>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }
}

// ───────────────────────── settler

export class FakeSettler implements Settler {
  calls: { pixels: boolean }[] = [];
  /** When this returns false for a poll the observation is reported unsettled. */
  settledWhen: (obs: Observation, n: number) => boolean = () => true;
  async settle(session: DriverSession, _opts: SettleOptions, extra?: { pixels?: boolean }): Promise<SettleResult> {
    const pixels = extra?.pixels === true;
    this.calls.push({ pixels });
    const observation = await session.observe(pixels ? { pixels: true } : undefined);
    return { settled: this.settledWhen(observation, this.calls.length), observation, polls: 1 };
  }
}

// ───────────────────────── recording store

export class MemoryRecordingStore implements RecordingStore {
  readonly dir = '/mem/recordings';
  mode: RecordingsMode;
  files = new Map<string, string>();
  saves: ScenarioRecording[] = [];
  loads: { driverId: string; scenarioId: string }[] = [];
  constructor(mode: RecordingsMode = 'read-write') {
    this.mode = mode;
  }
  private key(driverId: string, scenarioId: string): string {
    return `${driverId}/${scenarioId}`;
  }
  seed(driverId: string, rec: ScenarioRecording): void {
    this.files.set(this.key(driverId, rec.scenarioId), stableJson(rec as unknown as JsonValue));
  }
  read(driverId: string, scenarioId: string): ScenarioRecording | null {
    const raw = this.files.get(this.key(driverId, scenarioId));
    return raw === undefined ? null : (JSON.parse(raw) as ScenarioRecording);
  }
  load(driverId: string, scenarioId: string): Promise<ScenarioRecording | null> {
    this.loads.push({ driverId, scenarioId });
    if (this.mode === 'off') return Promise.resolve(null);
    return Promise.resolve(this.read(driverId, scenarioId));
  }
  save(rec: ScenarioRecording): Promise<'created' | 'updated' | 'unchanged'> {
    if (this.mode !== 'read-write') return Promise.reject(new AiBddError('RECORDING_READ_ONLY', 'recordings are read-only'));
    this.saves.push(structuredClone(rec));
    const key = this.key(rec.driver.id, rec.scenarioId);
    const next = stableJson(rec as unknown as JsonValue);
    const prev = this.files.get(key);
    this.files.set(key, next);
    return Promise.resolve(prev === undefined ? 'created' : prev === next ? 'unchanged' : 'updated');
  }
  remove(driverId: string, scenarioId: string): Promise<void> {
    this.files.delete(this.key(driverId, scenarioId));
    return Promise.resolve();
  }
  list(): Promise<{ driverId: string; scenarioId: string }[]> {
    return Promise.resolve([...this.files.keys()].map((k) => ({ driverId: k.split('/')[0] ?? '', scenarioId: k.split('/').slice(1).join('/') })));
  }
}

// ───────────────────────── evidence

export class MemoryEvidence implements EvidenceStore {
  readonly runId = 'run-test';
  readonly dir = '/mem/run';
  artifacts: { kind: ArtifactKind; text?: string; bytes?: Uint8Array; ref: ArtifactRef }[] = [];
  records: JsonObject[] = [];
  putArtifact(kind: ArtifactKind, data: Uint8Array | string): Promise<ArtifactRef> {
    const sha = sha256Hex(data);
    const ref: ArtifactRef = { sha256: sha, path: `artifacts/${sha}.txt`, kind, bytes: typeof data === 'string' ? data.length : data.length };
    this.artifacts.push(typeof data === 'string' ? { kind, text: data, ref } : { kind, bytes: data, ref });
    return Promise.resolve(ref);
  }
  record(entry: JsonObject): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }
  finalize(): Promise<{ runId: string; artifacts: ArtifactRef[]; digest: string }> {
    return Promise.resolve({ runId: this.runId, artifacts: this.artifacts.map((a) => a.ref), digest: 'd' });
  }
}

// ───────────────────────── actor

export const ZERO = { modelCalls: 0, inputTokens: 0, outputTokens: 0 } as const;

export class ScriptedActor implements Actor {
  calls: { req: ActRequest; session: DriverSession }[] = [];
  /** Replace to script failures; the default applies the step's effect and reports `done`. */
  handler: (req: ActRequest, session: DriverSession, n: number, world: FakeWorld) => Promise<ActResult> | ActResult;
  private readonly world: () => FakeWorld;

  constructor(world: () => FakeWorld) {
    this.world = world;
    this.handler = (req, session, _n, w) => this.succeed(req, session, w);
  }

  /** The default behaviour: apply the step's effect to the page and report `done`. */
  async succeed(req: ActRequest, session: DriverSession, world?: FakeWorld): Promise<ActResult> {
    (world ?? (session as FakeSession).world).apply(req.step.text);
    const obs = await session.observe();
    const performed: PerformedAction = { action: { verb: 'click', target: { ref: 'e0' } }, chosenFrom: obs, outcome: { ok: true } };
    return { status: 'done', actions: [performed], finalObservation: obs, summary: 'done', usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5 } };
  }

  async act(req: ActRequest, session: DriverSession): Promise<ActResult> {
    this.calls.push({ req, session });
    const w = (session as FakeSession).world ?? this.world();
    return this.handler(req, session, this.calls.length, w);
  }

  async failWith(req: ActRequest, session: DriverSession, code: 'ACT_BUDGET_EXHAUSTED' | 'ACT_TARGET_AMBIGUOUS' | 'ACT_BLOCKED'): Promise<ActResult> {
    const obs = await session.observe();
    return {
      status: code === 'ACT_BLOCKED' ? 'blocked' : 'failed',
      error: { code, message: `${code} for ${req.step.text}`, retryable: false },
      actions: [],
      finalObservation: obs,
      summary: code,
      usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1 },
    };
  }
}

// ───────────────────────── recorder

export function selectorFor(name: string): ActProgram['actions'][number] {
  return { verb: 'click', target: { role: 'button', name, ancestors: [], index: 0, of: 1 } };
}

export function actProgramFor(effectName: string, route = '/'): ActProgram {
  return {
    startRoute: route,
    startLandmarks: 'landmarks',
    actions: [selectorFor(effectName)],
    effect: { routeBefore: route, routeAfter: route, appeared: [], disappeared: [], changed: [] },
  };
}

function effectNames(act: ActProgram): string[] {
  const names: string[] = [];
  for (const a of act.actions) if ('target' in a && a.target) names.push(a.target.name);
  return names;
}

interface Divergence {
  outcome: ReplayOutcome;
  completedActions: number;
}

export class ScriptedRecorder implements Recorder {
  recordings: { performed: readonly PerformedAction[]; before: Observation; after: Observation; probe: Observation | undefined; step: Step }[] = [];
  replays: { act: ActProgram }[] = [];
  /** Fuzzy reasons toRecording reports, by step text. */
  reasons = new Map<string, FuzzyReason[]>();
  /** Forced replay divergence by effect name (the first action's target name). */
  private diverged = new Map<string, Divergence>();
  /** Per-call override: return a ReplayOutcome to force it for that (1-based) global replay call. */
  forceCall: ((n: number, act: ActProgram) => Divergence | undefined) | undefined;

  diverge(effectName: string, outcome: ReplayOutcome, completedActions = 0): void {
    this.diverged.set(effectName, { outcome, completedActions });
  }
  heal(effectName: string): void {
    this.diverged.delete(effectName);
  }

  toRecording(performed: readonly PerformedAction[], before: Observation, after: Observation, afterProbe: Observation | undefined, step: Step): { act: ActProgram; fuzzyReasons: FuzzyReason[] } {
    this.recordings.push({ performed, before, after, probe: afterProbe, step });
    return { act: actProgramFor(step.text, before.route), fuzzyReasons: [...(this.reasons.get(step.text) ?? [])] };
  }

  async replay(act: ActProgram, session: DriverSession): Promise<ReplayResult> {
    this.replays.push({ act });
    const world = (session as FakeSession).world;
    const names = effectNames(act);
    const forced = this.forceCall?.(this.replays.length, act) ?? this.diverged.get(names[0] ?? '');
    const before = await session.observe();
    if (forced && forced.outcome !== 'replayed') {
      for (const n of names.slice(0, forced.completedActions)) world.apply(n);
      const after = await session.observe();
      return { outcome: forced.outcome, completedActions: forced.completedActions, before, after, detail: `forced ${forced.outcome}` };
    }
    for (const n of names) world.apply(n);
    const after = await session.observe();
    return { outcome: 'replayed', completedActions: act.actions.length, before, after };
  }
}

// ───────────────────────── asserter

export function existsProgram(role: string, name: string, over: Partial<CheckProgram> = {}): CheckProgram {
  return {
    classification: 'change',
    predicates: [{ op: 'exists', query: { role, name } }],
    generatedBy: { modelId: 'fake:checkgen', promptVersion: 'checkgen-v1' },
    verified: { afterTrue: true, probeTrue: true, beforeFalse: true, judgePassed: false },
    ...over,
  };
}

function evalPredicate(p: Predicate, obs: Observation): PredicateResult {
  const match = (q: { role?: string; name?: string }) =>
    obs.nodes.filter((n) => (q.role === undefined || n.role === q.role) && (q.name === undefined || n.name === q.name));
  switch (p.op) {
    case 'exists': {
      const found = match(p.query).length > 0;
      return { predicate: p, satisfied: p.negate === true ? !found : found, actual: match(p.query).length };
    }
    case 'count': {
      const c = match(p.query).length;
      const ok = p.cmp === 'eq' ? c === p.value : p.cmp === 'gte' ? c >= p.value : c <= p.value;
      return { predicate: p, satisfied: ok, actual: c };
    }
    case 'route':
      return { predicate: p, satisfied: p.match === 'equals' ? obs.route === p.value : obs.route.startsWith(p.value), actual: obs.route };
    default:
      return { predicate: p, satisfied: 'unknown' };
  }
}

export class ScriptedAsserter implements Asserter {
  evaluations: { program: CheckProgram; obs: Observation }[] = [];
  generations: CheckGenRequest[] = [];
  /** Replace to script generation outcomes. The default builds an `exists` check for a node that appeared. */
  generateHandler: ((req: CheckGenRequest) => CheckGenResult) | undefined;

  evaluate(program: CheckProgram, obs: Observation): CheckEvaluation {
    this.evaluations.push({ program, obs });
    const results = program.predicates.map((p) => evalPredicate(p, obs));
    return { passed: results.every((r) => r.satisfied === true), results };
  }

  generate(req: CheckGenRequest): Promise<CheckGenResult> {
    this.generations.push(req);
    if (this.generateHandler) return Promise.resolve(this.generateHandler(req));
    const key = (n: { role: string; name: string }) => `${n.role}|${n.name}`;
    const before = new Set(req.before.nodes.map(key));
    const appeared = req.after.nodes.find((n) => !before.has(key(n)));
    const target = req.actionPreceded ? (appeared ?? req.after.nodes[0]) : req.after.nodes[0];
    if (!target) return Promise.resolve({ fuzzyReasons: ['check-generation-failed'], attempts: 1, usage: { modelCalls: 1, inputTokens: 5, outputTokens: 5 }, errors: ['empty page'] });
    const classification = req.actionPreceded && appeared ? 'change' : 'invariant';
    return Promise.resolve({
      program: existsProgram(target.role, target.name, { classification, verified: { afterTrue: true, probeTrue: true, beforeFalse: classification === 'change' ? true : null, judgePassed: false } }),
      fuzzyReasons: [],
      attempts: 1,
      usage: { modelCalls: 1, inputTokens: 5, outputTokens: 5 },
      errors: [],
    });
  }
}

// ───────────────────────── judge

export class ScriptedJudge implements Judge {
  requests: JudgeRequest[] = [];
  /** Verdict per request; the default passes everything. */
  verdictFor: (req: JudgeRequest, n: number) => 'pass' | 'fail' | 'inconclusive' = () => 'pass';
  judge(req: JudgeRequest): Promise<JudgeVerdict> {
    this.requests.push(req);
    const v = this.verdictFor(req, this.requests.length);
    const p = v === 'pass' ? 0.95 : v === 'fail' ? 0.05 : 0.55;
    const verdict: JudgeVerdict = {
      verdict: v,
      score: p,
      spread: v === 'inconclusive' ? 0.1 : 0,
      samples: [{ probability: p, verdict: v === 'pass' ? 'holds' : v === 'fail' ? 'fails' : 'cannot_tell', explanation: `scripted ${v}`, observed: 'page' }],
      modelId: 'fake:judge',
      promptVersion: 'judge-v1',
      cached: false,
      usage: { modelCalls: 3, inputTokens: 30, outputTokens: 15 },
    };
    if (v === 'inconclusive') verdict.reason = 'band';
    return Promise.resolve(verdict);
  }
}
