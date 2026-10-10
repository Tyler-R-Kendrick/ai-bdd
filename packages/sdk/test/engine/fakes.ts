/* In-memory fakes for every sibling module the engine wires. Unit tests never touch real sibling implementations. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AiBddError,
  type ActRequest,
  type ChatModel,
  type Chunk,
  type ChunkedDoc,
  type DocPlan,
  type Driver,
  type DriverFactory,
  type DriverSession,
  type EvidenceStore,
  type Feature,
  type JudgeRequest,
  type JsonValue,
  type ModelPurpose,
  type ModelRequest,
  type ModelSet,
  type PlanStatus,
  type Planner,
  type PlanStore,
  type RecordingStore,
  type Redactor,
  type ReporterName,
  type ResolvedConfig,
  type RunnerDeps,
  type RunReport,
  type Scenario,
  type ScenarioResult,
  type ScenarioRunOptions,
  type ScenarioStatus,
  type ScenarioTarget,
  type Section,
  type SourceDoc,
  type StepResult,
  type UserConfig,
  type Usage,
} from '../../src/contracts/index.ts';
import { resolveConfig } from '../../src/config/index.ts';
import type { EngineModules } from '../../src/engine/index.ts';
import { sha256Hex, slugify, stableJson } from '../../src/util/index.ts';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface ModelCall {
  purpose: ModelPurpose;
  context: Record<string, JsonValue>;
}

export interface RunnerCall {
  scenarioId: string;
  opts: ScenarioRunOptions & { workers?: number };
}

export interface World {
  tmp: string;
  docs: Map<string, string>;
  modelCalls: ModelCall[];
  modelDelayMs: number;
  /** Model ids per purpose (default fake-<purpose>). */
  modelIds: Record<ModelPurpose, string>;
  /** Tokens returned per model call. */
  tokens: { inputTokens: number; outputTokens: number };
  failModel: { purpose: ModelPurpose; error: Error } | undefined;
  /** Sections (by title slug suffix) that fail extraction by returning failed / by throwing. */
  failSections: Set<string>;
  throwSections: Set<string>;
  extractLog: string[];
  extractInFlight: number;
  extractMaxInFlight: number;
  planSaves: string[];
  planRemoves: string[];
  plans: Map<string, DocPlan>;
  recordings: Map<string, unknown>;
  recordingOpts: { dir: string; mode: string }[];
  redactorSecrets: Record<string, string>[];
  evidences: { runId: string; dir: string; finalized: number; records: unknown[] }[];
  driversCreated: string[];
  driversDisposed: string[];
  driverSelfCheck: { ok: boolean; problems: string[] };
  driverCreateError: Error | undefined;
  runnerCalls: RunnerCall[];
  runnerDepsSeen: RunnerDeps[];
  statuses: Map<string, ScenarioStatus>;
  stepErrors: Map<string, { code: AiBddError['code'] }>;
  scenarioModelCalls: Partial<Record<'act' | 'judge' | 'checkgen', number>>;
  sessionsOpened: DriverSession[];
  reportersRequested: ReporterName[][];
  verifyRunDirs: string[];
}

export function modelUsage(world: World): Record<ModelPurpose, number> {
  const out: Record<ModelPurpose, number> = { extract: 0, act: 0, checkgen: 0, judge: 0 };
  for (const c of world.modelCalls) out[c.purpose] += 1;
  return out;
}

export const totalModelCalls = (world: World): number => world.modelCalls.length;

function makeModel(world: World, purpose: ModelPurpose): ChatModel {
  return {
    id: world.modelIds[purpose],
    async generate(req: ModelRequest) {
      world.modelCalls.push({ purpose, context: req.context as Record<string, JsonValue> });
      if (world.modelDelayMs > 0) await new Promise((r) => setTimeout(r, world.modelDelayMs));
      if (world.failModel?.purpose === purpose) throw world.failModel.error;
      return { object: { ok: true }, toolCalls: [], usage: { ...world.tokens }, finishReason: 'stop', modelId: world.modelIds[purpose] };
    },
  };
}

export function fakeModelSet(world: World): ModelSet {
  return { extract: makeModel(world, 'extract'), act: makeModel(world, 'act'), checkgen: makeModel(world, 'checkgen'), judge: makeModel(world, 'judge') };
}

// ───────────────────────── markdown fakes: one line = one chunk, any heading starts a section

function chunkText(doc: SourceDoc): ChunkedDoc {
  const chunks: Chunk[] = [];
  const sections: Section[] = [];
  let current: Section | undefined;
  let n = 0;
  doc.text.split('\n').forEach((raw, i) => {
    const text = raw.replace(/^#+\s*/, '').trim();
    if (text === '') return;
    const heading = raw.startsWith('#');
    if (heading || current === undefined) {
      const slug = heading ? slugify(text) : '_preamble';
      current = {
        id: `${doc.uri}#${slug}`,
        docUri: doc.uri,
        anchor: slug,
        title: heading ? text : '_preamble',
        level: 1,
        chunkIds: [],
        hash: '',
        range: { startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: raw.length + 1 },
      };
      sections.push(current);
      n = 0;
    }
    n += 1;
    const anchor = `${current.anchor}/${heading ? 'h' : `p${n}`}`;
    const chunk: Chunk = {
      id: `${doc.uri}#${anchor}`,
      docUri: doc.uri,
      anchor,
      kind: heading ? 'heading' : 'paragraph',
      headingPath: [current.anchor],
      sectionId: current.id,
      text,
      hash: sha256Hex(text),
      range: { startLine: i + 1, startColumn: 1, endLine: i + 1, endColumn: raw.length + 1 },
      directives: {},
    };
    chunks.push(chunk);
    current.chunkIds.push(chunk.id);
  });
  for (const s of sections) s.hash = sha256Hex(s.chunkIds.map((id) => chunks.find((c) => c.id === id)?.hash ?? '').join('\n'));
  const title = chunks.find((c) => c.kind === 'heading')?.text ?? doc.uri;
  return { doc: { uri: doc.uri, sha256: doc.sha256, title }, chunks, sections, contextChunkIds: [], diagnostics: [] };
}

// ───────────────────────── plan fakes

const featureId = (docUri: string, title: string): string => `${slugify(docUri.replace(/\.[^.]+$/, ''), 48)}--${slugify(title, 48)}`;

function dirty(doc: ChunkedDoc, previous: DocPlan | null, full: boolean): string[] {
  return doc.sections
    .filter((s) => full || previous === null || !previous.sections.some((p) => p.id === s.id && p.hash === s.hash && p.failed !== true))
    .map((s) => s.id);
}

function fakePlanner(): Planner {
  return {
    dirtySections: (doc, previous, opts) => dirty(doc, previous, opts.full),
    merge(doc, previous, extracted, meta) {
      const features: Feature[] = [];
      const sectionsOut: DocPlan['sections'] = [];
      const added: string[] = [];
      const updated: string[] = [];
      const removed: string[] = [];
      const notTestable: DocPlan['notTestable'] = [];
      const rejected = [...(previous?.rejected ?? [])];
      for (const section of doc.sections) {
        const result = extracted.get(section.id);
        const prevFeatures = previous?.features.filter((f) => f.sectionId === section.id) ?? [];
        const prevSection = previous?.sections.find((s) => s.id === section.id);
        if (result === undefined || result.failed) {
          features.push(...prevFeatures);
          if (result?.failed === true) sectionsOut.push({ id: section.id, hash: prevSection?.hash ?? '', failed: true });
          else sectionsOut.push({ id: section.id, hash: prevSection?.hash ?? section.hash });
          continue;
        }
        sectionsOut.push({ id: section.id, hash: section.hash });
        notTestable.push(...result.notTestable);
        const fresh: Feature[] = result.drafts.map((d) => {
          const id = featureId(doc.doc.uri, d.title);
          const prevF = prevFeatures.find((f) => f.id === id);
          const scenarios: Scenario[] = d.scenarios
            .filter((s) => !rejected.some((r) => r.title === s.title))
            .map((s) => {
              const sid = `${id}/${slugify(s.title, 48)}`;
              const prevS = prevF?.scenarios.find((x) => x.id === sid);
              return {
                id: sid,
                featureId: id,
                title: s.title,
                tags: s.tags,
                sources: s.sources.map((r) => ({ chunkId: r.chunkId, hash: doc.chunks.find((c) => c.id === r.chunkId)?.hash ?? '', relation: r.relation })),
                steps: s.steps.map((st, i) => ({ key: `${st.kind}:${i}`, kind: st.kind, text: st.text, grounding: st.grounding, sources: [], params: st.params })),
                review: prevS?.review ?? 'unreviewed',
                fingerprint: sha256Hex(`${s.title}|${s.steps.map((x) => x.text).join('|')}`),
              };
            });
          return {
            id,
            docUri: doc.doc.uri,
            sectionId: section.id,
            title: d.title,
            tags: d.tags,
            sources: d.sources.map((r) => ({ chunkId: r.chunkId, hash: doc.chunks.find((c) => c.id === r.chunkId)?.hash ?? '', relation: r.relation })),
            scenarios,
            review: prevF?.review ?? 'unreviewed',
            ...(prevF?.pinned === true ? { pinned: true } : {}),
            fingerprint: sha256Hex(`${d.title}|${scenarios.map((s) => s.fingerprint).join('|')}`),
          };
        });
        for (const f of fresh) (prevFeatures.some((p) => p.id === f.id) ? updated : added).push(f.id);
        for (const p of prevFeatures) if (!fresh.some((f) => f.id === p.id)) removed.push(p.id);
        features.push(...fresh);
      }
      const plan: DocPlan = {
        schemaVersion: 1,
        docUri: doc.doc.uri,
        docSha256: doc.doc.sha256,
        extractor: meta.extractor,
        sections: sectionsOut,
        chunks: doc.chunks.map((c) => ({ id: c.id, hash: c.hash, kind: c.kind, range: c.range, excerpt: c.text.slice(0, 80) })),
        features,
        notTestable,
        rejected,
        uncovered: doc.chunks.filter((c) => c.kind !== 'heading' && !features.some((f) => f.sources.some((r) => r.chunkId === c.id))).map((c) => c.id),
      };
      return { plan, diagnostics: [], added, updated, removed };
    },
    status(docs, plans): PlanStatus {
      const out: PlanStatus['docs'] = [];
      for (const doc of docs) {
        const plan = plans.find((p) => p.docUri === doc.doc.uri) ?? null;
        const dirtySections = dirty(doc, plan, false);
        out.push({
          docUri: doc.doc.uri,
          state: plan === null ? 'new' : dirtySections.length > 0 ? 'stale' : 'fresh',
          dirtySections,
          staleFeatures: [],
          uncovered: plan?.uncovered ?? [],
          notTestable: plan?.notTestable.map((n) => n.chunkId) ?? [],
          unreviewedScenarios: plan?.features.flatMap((f) => f.scenarios.filter((s) => s.review === 'unreviewed').map((s) => s.id)) ?? [],
        });
      }
      for (const p of plans) {
        if (!docs.some((d) => d.doc.uri === p.docUri)) {
          out.push({ docUri: p.docUri, state: 'orphaned', dirtySections: [], staleFeatures: [], uncovered: [], notTestable: [], unreviewedScenarios: [] });
        }
      }
      return { docs: out.sort((a, b) => cmp(a.docUri, b.docUri)) };
    },
    review(plan, id, action) {
      const next = clone(plan);
      for (const f of next.features) {
        const owns = f.scenarios.some((s) => s.id === id);
        if (f.id !== id && !owns) continue;
        if (action === 'pin' || action === 'unpin') {
          if (action === 'pin') f.pinned = true;
          else delete f.pinned;
          continue;
        }
        const state = action === 'accept' ? 'accepted' : 'rejected';
        for (const s of f.scenarios) {
          if (f.id !== id && s.id !== id) continue;
          s.review = state;
          if (state === 'rejected') next.rejected.push({ fingerprint: s.fingerprint, title: s.title });
        }
        if (f.id === id) f.review = state;
      }
      return next;
    },
  };
}

// ───────────────────────── runner fakes

function stepResult(kind: 'given' | 'when' | 'then', text: string, status: ScenarioStatus, code?: AiBddError['code']): StepResult {
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
  return {
    stepKey: `${kind}:x`,
    kind,
    text,
    status,
    path: 'none',
    determinism: 'n/a',
    fuzzyReasons: [],
    ...(code === undefined ? {} : { error: { code, message: code, retryable: false } }),
    actions: 0,
    usage,
    durationMs: 0,
    evidence: [],
    sources: [],
  };
}

export function scenarioResult(world: World, t: ScenarioTarget, status: ScenarioStatus): ScenarioResult {
  const stepError = world.stepErrors.get(t.scenario.id);
  return {
    scenarioId: t.scenario.id,
    featureId: t.feature.id,
    docUri: t.plan.docUri,
    title: t.scenario.title,
    driver: t.scenario.driver ?? 'fake',
    status,
    mode: 'replay',
    review: t.scenario.review,
    steps: [stepResult('then', 'ok', status, stepError?.code)],
    recording: 'none',
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: 1,
  };
}

// ───────────────────────── the world

export interface WorldOptions {
  docs?: Record<string, string>;
  user?: UserConfig;
  env?: Record<string, string | undefined>;
  sameJudgeModel?: boolean;
  driverFactories?: Record<string, DriverFactory>;
}

export const DEFAULT_DOCS: Record<string, string> = {
  'docs/billing.md': ['# Billing', 'Customers can upgrade to the Pro plan from the billing page.', '## Downgrading', 'Customers can downgrade back to the Free plan at any time.'].join('\n'),
  'docs/todos.md': ['# Todos', 'Users can add a todo item to the list and see it appear.'].join('\n'),
};

export interface Fixture {
  world: World;
  modules: EngineModules;
  config: ResolvedConfig;
  models: ModelSet;
  driverFactory: DriverFactory;
}

export async function makeFixture(opts: WorldOptions = {}): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'ai-bdd-engine-'));
  const world: World = {
    tmp,
    docs: new Map(Object.entries(opts.docs ?? DEFAULT_DOCS)),
    modelCalls: [],
    modelDelayMs: 0,
    modelIds: { extract: 'fake-extract', act: 'fake-act', checkgen: 'fake-checkgen', judge: opts.sameJudgeModel === true ? 'fake-act' : 'fake-judge' },
    tokens: { inputTokens: 10, outputTokens: 5 },
    failModel: undefined,
    failSections: new Set(),
    throwSections: new Set(),
    extractLog: [],
    extractInFlight: 0,
    extractMaxInFlight: 0,
    planSaves: [],
    planRemoves: [],
    plans: new Map(),
    recordings: new Map(),
    recordingOpts: [],
    redactorSecrets: [],
    evidences: [],
    driversCreated: [],
    driversDisposed: [],
    driverSelfCheck: { ok: true, problems: [] },
    driverCreateError: undefined,
    runnerCalls: [],
    runnerDepsSeen: [],
    statuses: new Map(),
    stepErrors: new Map(),
    scenarioModelCalls: {},
    sessionsOpened: [],
    reportersRequested: [],
    verifyRunDirs: [],
  };
  const models = fakeModelSet(world);

  const driverFactory: DriverFactory = {
    id: 'fake',
    async create() {
      world.driversCreated.push('fake');
      if (world.driverCreateError !== undefined) throw world.driverCreateError;
      const driver: Driver = {
        id: 'fake',
        version: '1.0.0',
        capabilities: { verbs: ['click'], pixels: false, maskingProven: false, request: false, maxSessions: 4 },
        openSession: () => Promise.reject(new Error('fake driver sessions are not used in engine unit tests')),
        selfCheck: () => Promise.resolve(world.driverSelfCheck),
        dispose: () => {
          world.driversDisposed.push('fake');
          return Promise.resolve();
        },
      };
      return driver;
    },
  };

  const config = resolveConfig(
    {
      docs: ['docs/**/*.md'],
      baseURL: 'http://localhost:4000',
      drivers: { fake: driverFactory, ...(opts.driverFactories ?? {}) },
      defaultDriver: 'fake',
      models,
      ...opts.user,
    },
    { projectRoot: tmp, env: opts.env ?? {} },
  );

  const modules: EngineModules = {
    extractPromptVersion: 'extract-fake',
    async discoverDocs() {
      return [...world.docs.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([uri, text]) => ({ uri, absolutePath: join(tmp, uri), text, sha256: sha256Hex(text) }));
    },
    createChunker: () => ({ chunk: (doc) => chunkText(doc) }),
    createExtractor: ({ model }) => ({
      async extractSection(input) {
        world.extractLog.push(input.section.id);
        world.extractInFlight += 1;
        world.extractMaxInFlight = Math.max(world.extractMaxInFlight, world.extractInFlight);
        try {
          await model.generate({
            purpose: 'extract',
            system: 'extract',
            messages: [],
            context: { docUri: input.doc.doc.uri, sectionId: input.section.id, sectionAnchor: input.section.anchor, attempt: 1 },
          });
        } finally {
          world.extractInFlight -= 1;
        }
        const failKey = input.section.anchor;
        if (world.throwSections.has(failKey)) throw new AiBddError('MODEL_UNAVAILABLE', `provider down for ${failKey}`);
        const base = { sectionId: input.section.id, notTestable: [], usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5 }, modelId: model.id, promptVersion: 'extract-fake' };
        if (world.failSections.has(failKey)) {
          return { ...base, failed: true, drafts: [], diagnostics: [{ code: 'EXTRACT_MODEL_OUTPUT_INVALID', severity: 'error', message: 'bad output' }] };
        }
        const body = input.doc.chunks.filter((c) => input.section.chunkIds.includes(c.id) && c.kind !== 'heading');
        const first = body[0];
        if (first === undefined) return { ...base, failed: false, drafts: [], diagnostics: [] };
        return {
          ...base,
          failed: false,
          diagnostics: [],
          drafts: [
            {
              title: input.section.title,
              tags: [],
              sources: [{ chunkId: first.id, relation: 'source', quote: first.text }],
              scenarios: [
                {
                  title: `${input.section.title} works`,
                  tags: [],
                  sources: [{ chunkId: first.id, relation: 'source', quote: first.text }],
                  steps: [
                    { kind: 'when', text: 'the user performs the action', grounding: 'inferred', sources: [], params: {} },
                    { kind: 'then', text: first.text, grounding: 'quoted', sources: [], params: {} },
                  ],
                },
              ],
            },
          ],
        };
      },
    }),
    createPlanner: () => fakePlanner(),
    createPlanStore: ({ dir }): PlanStore => ({
      dir,
      load: (uri) => Promise.resolve(world.plans.has(uri) ? clone(world.plans.get(uri) as DocPlan) : null),
      loadAll: () => Promise.resolve([...world.plans.values()].sort((a, b) => cmp(a.docUri, b.docUri)).map(clone)),
      loadAllSync: () => [...world.plans.values()].sort((a, b) => cmp(a.docUri, b.docUri)).map(clone),
      save(plan) {
        world.planSaves.push(plan.docUri);
        world.plans.set(plan.docUri, clone(plan));
        return Promise.resolve();
      },
      remove(uri) {
        world.planRemoves.push(uri);
        world.plans.delete(uri);
        return Promise.resolve();
      },
    }),
    createActor: ({ model }) => ({
      async act() {
        await model.generate({ purpose: 'act', system: 'act', messages: [], context: {} });
        return { status: 'done', actions: [], finalObservation: {} as never, summary: 'ok', usage: { modelCalls: 1, inputTokens: 0, outputTokens: 0 } };
      },
    }),
    createRecorder: () => ({ toRecording: () => ({ act: {} as never, fuzzyReasons: [] }), replay: () => Promise.reject(new Error('unused')) }),
    createRecordingStore: ({ dir, mode }): RecordingStore => {
      world.recordingOpts.push({ dir, mode });
      const key = (d: string, s: string) => `${d}/${s}`;
      return {
        dir,
        mode: mode as RecordingStore['mode'],
        load: () => Promise.resolve(null),
        save: () => Promise.resolve('created'),
        remove(d, s) {
          world.recordings.delete(key(d, s));
          return Promise.resolve();
        },
        list: () =>
          Promise.resolve(
            [...world.recordings.keys()].sort().map((k) => {
              const i = k.indexOf('/');
              return { driverId: k.slice(0, i), scenarioId: k.slice(i + 1) };
            }),
          ),
      };
    },
    createAsserter: ({ model }) => ({
      evaluate: () => ({ passed: true, results: [] }),
      async generate() {
        await model.generate({ purpose: 'checkgen', system: 'checkgen', messages: [], context: {} });
        return { fuzzyReasons: [], attempts: 1, usage: { modelCalls: 1, inputTokens: 0, outputTokens: 0 }, errors: [] };
      },
    }),
    createJudge: ({ model }) => ({
      async judge() {
        await model.generate({ purpose: 'judge', system: 'judge', messages: [], context: {} });
        return { verdict: 'pass', score: 1, spread: 0, samples: [], modelId: model.id, promptVersion: 'judge-fake', cached: false, usage: { modelCalls: 1, inputTokens: 0, outputTokens: 0 } };
      },
    }),
    async createEvidenceStore({ runsDir, runId }): Promise<EvidenceStore> {
      const dir = join(runsDir, runId);
      await mkdir(dir, { recursive: true });
      const rec = { runId, dir, finalized: 0, records: [] as unknown[] };
      world.evidences.push(rec);
      return {
        runId,
        dir,
        putArtifact: async (kind, data) => ({ sha256: sha256Hex(data), path: `artifacts/${sha256Hex(data)}.txt`, kind, bytes: data.length }),
        record: (entry) => {
          rec.records.push(entry);
          return Promise.resolve();
        },
        async finalize() {
          rec.finalized += 1;
          await writeFile(join(dir, 'manifest.json'), stableJson({ runId, artifacts: [], digest: '' }));
          return { runId, artifacts: [], digest: sha256Hex('') };
        },
      };
    },
    createRedactor(secrets): Redactor {
      world.redactorSecrets.push(secrets);
      const redact = (text: string): string => Object.entries(secrets).reduce((t, [name, v]) => t.split(v).join(`<secret:${name}>`), text);
      const deep = (v: JsonValue): JsonValue =>
        typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(deep) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
      return { redact, redactJson: <T extends JsonValue>(v: T) => deep(v) as T, secretNames: Object.keys(secrets) };
    },
    createSettler: () => ({ settle: () => Promise.reject(new Error('unused')) }),
    verifyRun(dir) {
      world.verifyRunDirs.push(dir);
      return Promise.resolve({ ok: true, problems: [] });
    },
    createRunner: (deps) => {
      world.runnerDepsSeen.push(deps);
      const runOne = async (t: ScenarioTarget, o: ScenarioRunOptions & { workers?: number }): Promise<ScenarioResult> => {
        world.runnerCalls.push({ scenarioId: t.scenario.id, opts: o });
        const n = world.scenarioModelCalls;
        try {
          for (let i = 0; i < (n.act ?? 0); i++) await deps.actor.act({} as ActRequest, {} as DriverSession);
          for (let i = 0; i < (n.checkgen ?? 0); i++) await deps.asserter.generate({} as never);
          for (let i = 0; i < (n.judge ?? 0); i++) await deps.judge.judge({} as JudgeRequest);
        } catch {
          // like the real runner, model errors end up in step results rather than escaping
        }
        if (o.sessionFactory !== undefined) {
          const session = await o.sessionFactory({
            scenarioId: t.scenario.id,
            ...(deps.config.baseURL === undefined ? {} : { baseURL: deps.config.baseURL }),
            policy: deps.config.policy,
            resolveValue: (v) => ('literal' in v ? v.literal : 'secret' in v ? (deps.secretValue(v.secret) ?? '') : ''),
          });
          world.sessionsOpened.push(session);
        }
        const status = world.statuses.get(t.scenario.id) ?? 'passed';
        const result = scenarioResult(world, t, status);
        deps.emit({ type: 'scenario-end', result });
        return result;
      };
      return {
        runScenario: (t, o) => runOne(t, o),
        async runAll(targets, o) {
          const out: ScenarioResult[] = [];
          for (const t of targets) out.push(await runOne(t, o));
          return out;
        },
      };
    },
    createReporters(names) {
      world.reportersRequested.push([...names]);
      return names.map((name) => ({
        name,
        async render(report: RunReport, ctx: { outDir: string }) {
          const file = join(ctx.outDir, name === 'json' ? 'report.json' : name === 'junit' ? 'junit.xml' : 'summary.md');
          await writeFile(file, name === 'json' ? stableJson(report as unknown as JsonValue) : `<!-- ${name} -->\n`);
          return [{ path: file }];
        },
      }));
    },
  };

  return { world, modules, config, models, driverFactory };
}
