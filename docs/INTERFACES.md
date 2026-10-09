# ai-bdd internal interfaces (binding for all work packages)

Every package codes against `@ai-bdd/contracts` (read `packages/contracts/src/*.ts`).
This file fixes the **public API of each package** so swarms can be built in parallel.

## Ground rules

1. Only `@ai-bdd/contracts` may be imported across package boundaries, except where a
   line below explicitly lists another package (orchestration only).
   When you need another package that does not exist yet, declare a local interface that
   matches the contracts type and take it as a parameter (dependency injection).
2. Relative imports must carry the `.js` extension (NodeNext). No default exports.
3. `exactOptionalPropertyTypes` is on: never pass `undefined` explicitly for an optional
   property; use conditional spreads.
4. Package skeleton for every package `@ai-bdd/x`:
   - `package.json` (name, version `0.1.0`, `"type": "module"`, `exports` → `./dist/index.js`,
     `files: ["dist","README.md"]`, `license: "MIT"`, scripts `build`/`typecheck` = `tsc -b`,
     `test` = `vitest run`, `lint` = `oxlint src test`).
   - `tsconfig.json` extending `../../tsconfig.base.json` with
     `composite: true`, `rootDir: src`, `outDir: dist`, `tsBuildInfoFile: dist/.tsbuildinfo`,
     `include: ["src"]`, and `references` for every package you depend on.
   - `vitest.config.ts` using the shared alias:
     `import { alias } from '../../vitest.alias'; export default defineConfig({ resolve: { alias }, test: { name: '<pkg>', environment: 'node', include: ['test/**/*.test.ts'] } });`
   - `README.md` documenting the public API, plus a `CHANGES.md` entry.
5. Verify with `npx tsc -b packages/<x>` and `pnpm -F @ai-bdd/<x> test` from the repo root.
6. No TODO/FIXME without an issue reference.
7. The repo root `tsconfig.build.json` already references every planned package. Create
   your `packages/<x>/tsconfig.json` early (even with a stub `src/index.ts`) so builds work.

## @ai-bdd/spec-directives (WP-B3)

```ts
parseDirectives(line: string, dialect: Dialect, loc: SourceLocation): { directives: Partial<StepOptions>; diagnostics: Diagnostic[] } | null
consumeRubricTable(table: DataTable): Partial<StepOptions> | null   // header exactly ['ai-bdd','value']
inferKind(input: { text: string; keyword?: string; options?: StepOptions; bindingKind?: StepKind | 'any'; config?: { kinds?: KindsConfig } }): { kind: StepKind; kindSource: KindSource }
lintSteps(doc: SpecDocument): Diagnostic[]
mergeOptions(config: Partial<StepOptions>, spec: Partial<StepOptions>, scenario: Partial<StepOptions>, step: Partial<StepOptions>): StepOptions
```

## @ai-bdd/spec-gauge (WP-B1)

```ts
parseGaugeSpec(text: string, uri: string, opts?: { concepts?: Concept[]; readFile?: (path: string) => string }): ParseResult
parseConcepts(text: string, uri: string): { concepts: Concept[]; diagnostics: Diagnostic[] }
printGaugeSpec(doc: SpecDocument): string
```

## @ai-bdd/spec-gherkin (WP-B2)

```ts
parseGherkin(text: string, uri: string): ParseResult
```

## @ai-bdd/registry (WP-C1)

```ts
createRegistry(opts?: { config?: { kinds?: KindsConfig } }): BindingRegistry
interface BindingRegistry {
  add(desc: BindingDescriptor, fn?: BindingFn): void;
  addRemote(provider: string, descs: BindingDescriptor[]): void;
  remove(provider: string): void;
  set(): BindingSet;
  matchExact(text: string, kind?: StepKind): { matches: BindingMatch[] };
  find(id: string): Binding | undefined;
  functions(): Map<string, BindingFn>;
}
type BindingFn = (params: Record<string, JsonValue>, ctx: unknown) => unknown | Promise<unknown>;
bind(desc: BindingDescriptor, fn?: BindingFn): void
Given(pattern: string, fn: BindingFn | BindingOptions, maybeFn?: BindingFn): void
When(...): void
Then(...): void
defineParameterType(def: { name: string; regexp: RegExp; transformer?: (s: string) => JsonValue }): void
```

## @ai-bdd/semantic (WP-C2)

```ts
createSemanticResolver(opts: { embedder: Embedder; extractor: ChatModel; config: { threshold: number; margin: number; guards?: GuardConfig; kinds?: KindsConfig; topK?: number; embedCacheDir?: string } }): SemanticResolver
interface SemanticResolver {
  resolve(step: { text: string; kind: StepKind; kindSource?: KindSource }, set: BindingSet): Promise<Resolution | null>;
  explain(step: { text: string; kind: StepKind }, set: BindingSet): Promise<Candidate[]>;
}

## @ai-bdd/lock (WP-C3)

```ts
createResolver(opts: { registry: BindingRegistry; semantic: SemanticResolver; lock: LockStore; config: { threshold: number; margin: number; allowAgentSetup: boolean; semantic: { enabled: boolean } } }): Resolver
interface Resolver {
  resolve(step: Step, ctx: { frozen: boolean }): Promise<ResolutionResult>;
}
class LockStore {
  static load(path: string): LockStore;
  static empty(path: string): LockStore;
  get(key: string): LockEntry | undefined;
  upsert(entry: LockEntry): void;
  entries(): LockEntry[];
  summary(): LockSummary;
  save(): Promise<void>;   // deterministic, sorted, atomic (temp + rename)
  toJson(): string;
}
revalidate(entry: LockEntry, set: BindingSet, semantic: SemanticResolver): Promise<{ status: 'unchanged' | 'revalidated' | 'changed'; entry: LockEntry }>
```

## @ai-bdd/cache (WP-D4)

```ts
createCacheStore(opts: { dir: string; mode: CacheMode; strategies?: InvalidationStrategy[]; files?: Record<string, string[]>; buildChecksum?: string; manual?: string }): CacheStore
interface CacheStore {
  getAct(key: string): Promise<{ program: ActProgram; invalidation: Array<{ strategy: string; result: InvalidationResult }> } | null>;
  getCheck(key: string): Promise<{ program: CheckProgram; invalidation: Array<{ strategy: string; result: InvalidationResult }> } | null>;
  putAct(program: ActProgram, ctx: InvalidationContext): Promise<void>;
  putCheck(program: CheckProgram, ctx: InvalidationContext): Promise<void>;
  commitPending(): Promise<void>;
  evict(): Promise<void>;
}
buildStrategies(names: string[], opts: { files?: Record<string, string[]>; buildChecksum?: string; manual?: string; custom?: InvalidationStrategy[] }): InvalidationStrategy[]
```
`actKey`/`checkKey` come from `@ai-bdd/contracts` (already implemented).

## @ai-bdd/models (WP-F1)

```ts
aiSdkModels(opts: { act: unknown; judge: unknown; extract?: unknown; checkgen?: unknown; embed: unknown; grounding?: unknown }): ModelSet
```
plus the fake subpath (`packages/models/src/fake.ts`, exported as `./fake`):
```ts
createFakeModelSet(opts?: { rulesPath?: string; rules?: FakeRule[]; judgeRules?: JudgeRule[]; dimensions?: number }): ModelSet & { log: ModelCallLog[]; reset(): void }
FakeChatModel, FakeEmbedder, FakeGroundingScorer
```
Fake rules live in `fixtures/fake-model/rules.json`; the synonym table lives in
`fixtures/fake-model/synonyms.json` (owned by WP-C2, read by WP-F1).

## @ai-bdd/evidence (WP-D5)

```ts
createEvidenceStore(runDir: string, opts?: { redactor?: Redactor; signer?: Signer }): EvidenceStore
interface EvidenceStore {
  write(input: { kind: EvidenceKind; data: Uint8Array | string | JsonValue; ext: string; mediaType?: string; stepId?: string; scenarioId?: string; traceId?: string; spanId?: string; meta?: Record<string, JsonValue> }): Promise<EvidenceRecord>;
  records(): EvidenceRecord[];
  read(evidenceId: string): Promise<Uint8Array>;
  finalize(): Promise<EvidenceManifest>;
}
verifyEvidence(runDir: string): Promise<EvidenceVerification>
createRedactor(secrets: Record<string, { value?: string; env?: string }>, env?: NodeJS.ProcessEnv): Redactor
secretVariants(value: string): string[]
settle(session: DriverSession, opts?: Partial<SettleOptions>): Promise<SettleResult>

## @ai-bdd/judge (WP-D3)

```ts
createJudge(opts: { model: ChatModel; config: JudgeConfig; evidence?: EvidenceWriter; cacheDir?: string; prices?: PriceTable }): Judge
interface Judge { judge(req: JudgeRequest): Promise<JudgeVerdict> }
JUDGE_PROMPT_VERSION: string
buildJudgePrompt(req: JudgeRequest): { system: string; user: string }   // exported for the canary test
calibrate(judgments: Array<{ judgmentId: string; score: number }>, labels: CalibrationLabel[]): CalibrationReport
```

## @ai-bdd/assert (WP-D2)

```ts
createAsserter(opts: { model: ChatModel; judge: Judge; cache: CacheStore; config: { mode: AssertionMode; requireDeterministic: boolean; checkGen: { maxAttempts: number } }; driver: { id: string; major: number; nativePredicates: boolean }; params?: Record<string, JsonValue> }): Asserter
interface Asserter {
  assert(step: { id: string; text: string; options: StepOptions }, window: { before: Observation; after: Observation; actionPreceded: boolean; beforeTree: string; afterTree: string }): Promise<AssertOutcome>;
}
evaluatePredicates(predicates: CheckPredicate[], obs: Observation, params?: Record<string, JsonValue>, native?: (p: CheckPredicate[]) => Promise<PredicateResultValue[]>): PredicateResult[]
lintCheckProgram(p: CheckProgram, params?: Record<string, JsonValue>): string[]
generateCheckProgram(opts: { model: ChatModel; criterion: string; before: Observation; after: Observation; key: string; driver: string; driverMajor: number }): Promise<{ program: CheckProgram; classification: 'change' | 'invariant' }>
```

## @ai-bdd/act (WP-D1)

```ts
createActor(opts: { model: ChatModel; cache: CacheStore; evidence?: EvidenceWriter; grounding?: GroundingScorer; config: { maxActions: number; maxModelCalls: number; grounding: { threshold: number; margin: number }; policy: PolicyConfig } }): Actor
interface Actor {
  act(step: { id: string; text: string; options: StepOptions }, session: DriverSession, ctx: { params: Record<string, JsonValue>; before: Observation; key: string; driver: string; driverMajor: number; target?: string; contextHash?: string; secrets?: Record<string, string> }): Promise<ActOutcome>;
}
deriveSelector(node: ObservedNode, obs: Observation): Selector
findBySelector(selector: Selector, obs: Observation): ObservedNode | 'missing' | 'ambiguous'
computeEffect(before: Observation, after: Observation): EffectSignature
```

## @ai-bdd/driver-fake (WP-E4)

```ts
fake(options?: { modelPath?: string; fault?: { spinnerMs?: number; flakyNode?: boolean; secureField?: boolean; duplicateForms?: boolean }; screens?: FakeModel }): DriverFactory
loadFakeModel(path: string): FakeModel
```

## @ai-bdd/driver-playwright (WP-E1)

```ts
playwright(options: { browser?: 'chromium' | 'firefox' | 'webkit'; baseURL?: string; headless?: boolean; video?: boolean; channel?: string }): DriverFactory
```

## @ai-bdd/driver-e2e (WP-E2) / @ai-bdd/driver-cua (WP-E3)

```ts
e2e(options: { config?: string; target?: string; command?: string; maxSessions?: number }): DriverFactory
cua(options: { app: string; windowTitle?: string; mode?: 'mcp' | 'daemon' | 'call'; backgroundOnly?: boolean; permissionMode?: boolean }): DriverFactory
```

createSigner(pem: string): Signer   // { sign(data: Uint8Array): string; keyId?: string }
diffRatio(a: Uint8Array, b: Uint8Array): number
```

polarityGuard(stepText: string, bindingText: string, opts?: GuardConfig): string | null
validateParams(step: { text: string }, binding: Binding, raw: Record<string, JsonValue>): { ok: true; params: Record<string, JsonValue> } | { ok: false; reason: string }
createEmbeddingCache(dir: string): EmbeddingCache   // sha256(modelId+text).f32 little-endian Float32
```


## @ai-bdd/runtime (WP-G1)

```ts
createRuntime(config: AiBddConfig, opts?: { projectRoot?: string; models?: ModelSet; drivers?: Record<string, DriverFactory>; env?: NodeJS.ProcessEnv; now?: () => Date }): Runtime
interface Runtime {
  run(opts: { globs?: string[]; tags?: string; driver?: string; frozen?: boolean; strictCache?: boolean; noCache?: boolean; repeatEach?: number; updateLock?: boolean; onEvent?: (e: RunEvent) => void }): Promise<RunReport>;
  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  registerBindings(input: RegisterBindingsInput): Promise<RegisterBindingsOutput>;
  resolveStep(input: ResolveStepInput): Promise<ResolveStepOutput>;
  runStep(input: RunStepInput): Promise<StepResult>;
  reportBindingResult(input: ReportBindingResultInput): Promise<StepResult>;
  closeSession(input: CloseSessionInput): Promise<CloseSessionOutput>;
  getEvidence(input: GetEvidenceInput): Promise<GetEvidenceOutput>;
  health(): Promise<HealthOutput>;
  events(): AsyncIterable<RunEvent>;
  close(): Promise<void>;
}
loadConfig(path?: string, env?: NodeJS.ProcessEnv): Promise<ResolvedConfig>
resolveConfig(input: AiBddConfig, projectRoot: string, env?: NodeJS.ProcessEnv): ResolvedConfig
```

## @ai-bdd/daemon (WP-G2)

```ts
startDaemon(runtime: Runtime, opts: { host?: string; port?: number; token?: string; stdio?: boolean; http?: boolean; fake?: boolean; scriptPath?: string; projectRoot: string }): Promise<{ url: string; port: number; token: string; close(): Promise<void> }>
```

## @ai-bdd/reporters (WP-G4)

```ts
createReporters(names: ReporterName[], opts: { outDir: string; prices?: PriceTable; version?: string }): Reporter[]
interface Reporter { name: ReporterName; onEvent(e: RunEvent): void; finish(report: RunReport): Promise<{ files: string[] }> }
```

## @ai-bdd/codegen (WP-G5)

```ts
generateCucumberJs(opts: { lockPath: string; cacheDir: string; outDir: string }): Promise<{ files: string[] }>
generatePlaywright(opts: { lockPath: string; cacheDir: string; outDir: string }): Promise<{ files: string[] }>
```

## @ai-bdd/core / @ai-bdd/cli (WP-G3)

```ts
// @ai-bdd/core
defineConfig(config: AiBddConfig): AiBddConfig
bind, Given, When, Then, defineParameterType   // re-exported from @ai-bdd/registry
// @ai-bdd/cli: bin "ai-bdd" → dist/bin.js, commands per section 9.2
```

## Test-time conventions

- Deterministic fakes only; never call a real model in a default test run.
- `test/stubs/<pkg>.ts` is allowed while a dependency does not exist; the integration
  swarm deletes every stub.
- Name at least one test per implemented `R-K*` requirement `R-K<id>: ...` (AC12).
