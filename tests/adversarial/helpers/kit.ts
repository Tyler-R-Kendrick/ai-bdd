// Shared building blocks for the red-team suite. Everything here is offline: scripted ChatModels, the fake Acme driver,
// stub sessions and the acceptance harness' project/engine/cli helpers (reused through relative imports).
import { rmSync } from 'node:fs';
import {
  AiBddError,
  type ChatModel,
  type DriverSession,
  type JsonObject,
  type JsonValue,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
  type ModelSet,
  type ObservedNode,
  type Observation,
  type ActionOutcome,
  type DriverAction,
  type DriverCapabilities,
} from '@ai-bdd/sdk/contracts';
import { createEngine, loadConfig, renderTree, sha256Hex, treeHash } from '@ai-bdd/sdk';
import type { Clock, DriverFactory, Engine, FixtureDefinition, ResolvedConfig, RunEvent } from '@ai-bdd/sdk/contracts';
import { fakeDriver } from '@ai-bdd/testing';
import { virtualClock } from '../../acceptance/helpers/clock.ts';
import { ACME_DEFAULT_ADMIN_PASSWORD as DEFAULT_PW } from '../../acceptance/helpers/paths.ts';
import type { Project } from '../../acceptance/helpers/project.ts';

export { createProject, type Project } from '../../acceptance/helpers/project.ts';
export { openEngine, type EngineHandle } from '../../acceptance/helpers/engine.ts';
export { runCli, cliOutput } from '../../acceptance/helpers/cli.ts';
export { fakeTarget, playwrightTarget, playwrightUnavailableReason } from '../../acceptance/helpers/targets.ts';
export { walkFiles, findSecret, secretForms } from '../../acceptance/helpers/scan.ts';
export { latestRunDir, runDirs, readRunReport, readManifest } from '../../acceptance/helpers/runs.ts';
export { readPlans, readRecordings, allScenarios, findScenario, scenarioId, planFiles } from '../../acceptance/helpers/plans.ts';
export { ACME_DEFAULT_ADMIN_PASSWORD, WORK_ROOT, REPO_ROOT } from '../../acceptance/helpers/paths.ts';

// ───────────────────────── scripted models

export type ModelFn = (req: ModelRequest) => Partial<ModelResponse> | Promise<Partial<ModelResponse>>;

export interface ScriptedCall {
  purpose: ModelPurpose;
  req: ModelRequest;
  res: ModelResponse;
}

/** A ChatModel driven by a plain function; every request/response pair is appended to `log`. */
export function scripted(purpose: ModelPurpose, fn: ModelFn, log: ScriptedCall[]): ChatModel {
  return {
    id: `scripted:${purpose}`,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      const part = await fn(req);
      const res: ModelResponse = {
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: (part.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop',
        modelId: `scripted:${purpose}`,
        ...part,
      };
      log.push({ purpose, req, res });
      return res;
    },
  };
}

export const noRule = (purpose: ModelPurpose): ModelFn => (req) => {
  throw new AiBddError('MODEL_NO_RULE', `no scripted ${purpose} rule`, { details: { context: req.context } });
};

/** A ModelSet from per-purpose functions; purposes without a function throw MODEL_NO_RULE when called. */
export function modelSet(fns: Partial<Record<ModelPurpose, ModelFn>>): ModelSet & { log: ScriptedCall[] } {
  const log: ScriptedCall[] = [];
  const mk = (p: ModelPurpose): ChatModel => scripted(p, fns[p] ?? noRule(p), log);
  return Object.assign({ extract: mk('extract'), act: mk('act'), checkgen: mk('checkgen'), judge: mk('judge') }, { log });
}

export const callsOf = (m: { log: ScriptedCall[] }, purpose: ModelPurpose): ScriptedCall[] => m.log.filter((c) => c.purpose === purpose);

/** All user-visible text of a request (system + messages), as the provider would see it. */
export function requestText(req: ModelRequest): string {
  const parts: string[] = [req.system];
  for (const m of req.messages) {
    if (m.role === 'tool') parts.push(JSON.stringify(m.result));
    else {
      for (const p of m.content) parts.push(p.type === 'text' ? p.text : `[image ${p.sha256}]`);
      if (m.role === 'assistant' && m.toolCalls) parts.push(JSON.stringify(m.toolCalls));
    }
  }
  return parts.join('\n');
}

/** Only the user-role text of a request (the system prompt excluded). */
export function userText(req: ModelRequest): string {
  const parts: string[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') for (const p of m.content) parts.push(p.type === 'text' ? p.text : `[image ${p.sha256}]`);
  }
  return parts.join('\n');
}

/** The first user text block of a request. */
export function firstUserText(req: ModelRequest): string {
  const m = req.messages[0];
  if (m === undefined || m.role === 'tool') return '';
  return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

export interface PromptChunk { handle: string; kind: string; text: string }

/** Parse the `[cN] (kind) text` lines of an extraction user message, split by the context / section headings. */
export function promptChunks(req: ModelRequest): { context: PromptChunk[]; section: PromptChunk[] } {
  const text = firstUserText(req);
  const ctxStart = text.indexOf('Context chunks');
  const secStart = text.indexOf('Section chunks (extract from these):');
  const fixStart = text.indexOf('Fixture catalog');
  const grab = (from: number, to: number): PromptChunk[] => {
    const out: PromptChunk[] = [];
    const body = text.slice(from, to);
    const re = /^\[(c\d+)\] \(([a-zA-Z]+)\) (.*(?:\n {4}.*)*)/gm;
    for (const m of body.matchAll(re)) out.push({ handle: m[1] ?? '', kind: m[2] ?? '', text: (m[3] ?? '').replace(/\n {4}/g, '\n') });
    return out;
  };
  return { context: grab(ctxStart, secStart), section: grab(secStart, fixStart) };
}

/** A verbatim quote (first `len` chars of the chunk containing `needle`) with its handle, or null when this section has no such chunk. */
export function quoteFrom(req: ModelRequest, needle: string, len = 40): { handle: string; quote: string } | null {
  const c = promptChunks(req).section.find((x) => x.text.includes(needle));
  return c === undefined ? null : { handle: c.handle, quote: c.text.slice(0, len) };
}

// ───────────────────────── extraction output builders

export interface XStep {
  kind: 'given' | 'when' | 'then';
  text: string;
  grounding?: 'quoted' | 'inferred';
  sources?: { handle: string; relation?: 'source' | 'context'; quote: string | null }[];
  nature?: 'objective' | 'subjective' | null;
  requiresState?: boolean | null;
  fixture?: { name: string; args: { name: string; value: string | number | boolean }[] } | null;
  params?: { name: string; value: string }[];
}

export interface XScenario { title: string; tags?: string[]; sources?: XStep['sources']; steps: XStep[] }
export interface XFeature { title: string; tags?: string[]; sources?: XStep['sources']; scenarios: XScenario[] }

const srcs = (s: XStep['sources']): JsonObject[] =>
  (s ?? []).map((x) => ({ handle: x.handle, relation: x.relation ?? 'source', quote: x.quote }));

/** The strict extraction JSON of spec 7.2 from compact builders. */
export function extraction(features: XFeature[], notTestable: { handle: string; reason: string }[] = []): JsonObject {
  return {
    features: features.map((f) => ({
      title: f.title,
      story: null,
      description: null,
      tags: f.tags ?? [],
      sources: srcs(f.sources),
      scenarios: f.scenarios.map((s) => ({
        title: s.title,
        tags: s.tags ?? [],
        sources: srcs(s.sources),
        steps: s.steps.map((st) => ({
          kind: st.kind,
          text: st.text,
          grounding: st.grounding ?? 'inferred',
          sources: srcs(st.sources),
          nature: st.nature ?? null,
          requiresState: st.requiresState ?? null,
          fixture: st.fixture ?? null,
          params: st.params ?? [],
        })),
      })),
    })),
    notTestable,
  } as unknown as JsonObject;
}

// ───────────────────────── stub driver session

export const FULL_CAPS: DriverCapabilities = {
  verbs: ['navigate', 'click', 'fill', 'press', 'select', 'check', 'hover', 'scroll', 'back', 'wait'],
  pixels: false,
  maskingProven: false,
  request: false,
  maxSessions: 8,
};

export function node(partial: Partial<ObservedNode> & { role: string; name: string }, i = 0): ObservedNode {
  return { ref: `n${i}`, states: {}, depth: 0, ...partial };
}

/** Build an Observation from a flat node list; refs are re-assigned `r<rev>:e<i>`. */
export function observation(nodes: Omit<ObservedNode, 'ref'>[] | ObservedNode[], opts: { revision?: number; route?: string; busy?: boolean; tainted?: boolean } = {}): Observation {
  const revision = opts.revision ?? 1;
  const ns: ObservedNode[] = nodes.map((n, i) => ({ ...(n as ObservedNode), ref: `r${revision}:e${i + 1}` }));
  return {
    revision,
    route: opts.route ?? '/',
    nodes: ns,
    busy: opts.busy ?? false,
    tainted: opts.tainted ?? false,
    treeText: renderTree(ns, { refs: true }),
    treeHash: treeHash(ns),
  };
}

/**
 * A DriverSession whose observations come from a function of the number of observe() calls and the performed-action log.
 * `onPerform` may mutate the page model the `view` function reads.
 */
export class StubSession implements DriverSession {
  readonly id = 'stub-1';
  readonly driverId: string;
  readonly driverVersion = '1.0.0';
  readonly capabilities: DriverCapabilities;
  readonly performed: DriverAction[] = [];
  observes = 0;
  closed = false;
  constructor(
    private readonly view: (self: StubSession) => { nodes: Omit<ObservedNode, 'ref'>[]; route?: string; busy?: boolean; tainted?: boolean },
    private readonly onPerform: (a: DriverAction, self: StubSession) => ActionOutcome | void = () => ({ ok: true }),
    opts: { driverId?: string; caps?: Partial<DriverCapabilities> } = {},
  ) {
    this.driverId = opts.driverId ?? 'stub';
    this.capabilities = { ...FULL_CAPS, ...(opts.caps ?? {}) };
  }
  async observe(): Promise<Observation> {
    this.observes += 1;
    const v = this.view(this);
    return observation(v.nodes, { revision: this.observes, ...(v.route === undefined ? {} : { route: v.route }), ...(v.busy === undefined ? {} : { busy: v.busy }), ...(v.tainted === undefined ? {} : { tainted: v.tainted }) });
  }
  async perform(a: DriverAction): Promise<ActionOutcome> {
    this.performed.push(a);
    return this.onPerform(a, this) ?? { ok: true };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A Settler that returns one observation of the session per call (no waiting), good enough for recorder-level attacks. */
export const instantSettler = {
  async settle(session: DriverSession): Promise<{ settled: boolean; observation: Observation; polls: number }> {
    return { settled: true, observation: await session.observe(), polls: 1 };
  },
};

export function sha(s: string): string {
  return sha256Hex(s);
}

export function safeRm(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

// ───────────────────────── engine factory with fully custom models / drivers / fixtures


export interface MadeEngine {
  engine: Engine;
  config: ResolvedConfig;
  events: RunEvent[];
  clock: Clock;
  driverId: string;
  close(): Promise<void>;
}

export interface MakeEngineOptions {
  models: ModelSet;
  driver?: DriverFactory;
  /** additional driver factories registered next to `driver` (keyed by their ids) */
  extraDrivers?: DriverFactory[];
  /** replaces the corpus fixtures (default: the corpus config's acmeFixtures) */
  fixtures?: FixtureDefinition[];
  config?: (c: ResolvedConfig) => ResolvedConfig;
  env?: Record<string, string | undefined>;
  clock?: Clock;
  /** use the real system clock (real browsers) */
  realTime?: boolean;
}

export async function makeEngine(project: Project, o: MakeEngineOptions): Promise<MadeEngine> {
  const env: Record<string, string | undefined> = { ACME_ADMIN_PASSWORD: DEFAULT_PW, ...(o.env ?? {}) };
  let config = await loadConfig({ cwd: project.dir, env });
  config = { ...config, baseURL: config.baseURL ?? 'http://localhost:4173' };
  const primary = o.driver ?? fakeDriver({ adminPassword: DEFAULT_PW });
  const all = [primary, ...(o.extraDrivers ?? [])];
  config = { ...config, drivers: Object.fromEntries(all.map((d) => [d.id, d])), defaultDriver: config.defaultDriver ?? primary.id };
  if (o.fixtures !== undefined) config = { ...config, fixtures: o.fixtures };
  if (o.config !== undefined) config = o.config(config);
  const factory = primary;
  const clock = o.realTime === true ? undefined : (o.clock ?? virtualClock());
  const engine = await createEngine(config, { models: o.models, drivers: Object.fromEntries(all.map((d) => [d.id, d])), env, ...(clock === undefined ? {} : { clock }) });
  const events: RunEvent[] = [];
  engine.on((e) => events.push(e));
  return {
    engine,
    config,
    events,
    clock: clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    driverId: factory.id,
    close: () => engine.close(),
  };
}


// ───────────────────────── wrapping the stock fake models

/** Replace the answer of one purpose for requests `fn` returns a value for; everything else goes to the stock fake rules. */
export function overriding(
  purpose: ModelPurpose,
  fn: (req: ModelRequest, ctx: { calls: number }) => Partial<ModelResponse> | undefined | Promise<Partial<ModelResponse> | undefined>,
): (fake: ModelSet) => ModelSet {
  return (fake) => {
    const inner = fake[purpose];
    const state = { calls: 0 };
    const wrapped: ChatModel = {
      id: inner.id,
      async generate(req: ModelRequest): Promise<ModelResponse> {
        state.calls += 1;
        const mine = await fn(req, state);
        if (mine === undefined) return inner.generate(req);
        return { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop', modelId: inner.id, ...mine };
      },
    };
    return Object.assign({}, fake, { [purpose]: wrapped }) as ModelSet;
  };
}

/** Compose several wrappers (applied left to right). */
export function compose(...fns: ((m: ModelSet) => ModelSet)[]): (m: ModelSet) => ModelSet {
  return (m) => fns.reduce((acc, f) => f(acc), m);
}

/** Judge answer with three identical samples. */
export function judgeSays(verdict: 'holds' | 'fails' | 'cannot_tell', probability: number): Partial<ModelResponse> {
  return { object: { probability, verdict, explanation: `scripted ${verdict}`, observed: 'scripted' } };
}

export function toolCall(name: string, args: JsonObject, id = `call_${name}`): Partial<ModelResponse> {
  return { toolCalls: [{ id, name, args }], finishReason: 'tool-calls' };
}

/** Post-process the response of one purpose of the stock fake models (after the real rule ran). */
export function mutating(purpose: ModelPurpose, fn: (res: ModelResponse, req: ModelRequest) => ModelResponse): (fake: ModelSet) => ModelSet {
  return (fake) => {
    const inner = fake[purpose];
    const wrapped: ChatModel = {
      id: inner.id,
      async generate(req: ModelRequest): Promise<ModelResponse> {
        return fn(await inner.generate(req), req);
      },
    };
    return Object.assign({}, fake, { [purpose]: wrapped }) as ModelSet;
  };
}
