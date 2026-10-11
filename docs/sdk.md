# SDK

`@ai-bdd/sdk` is the public API. The `ai-bdd` CLI and `@ai-bdd/playwright-test` use nothing else, so anything they do, you can do. A script (`scripts/check-boundaries.mjs`) enforces this.

| Entry | Contents |
|---|---|
| `@ai-bdd/sdk` | `defineConfig`, `loadConfig`, `resolveConfig`, `createEngine`, `loadPlansSync`, building blocks (`createChunker`, `discoverDocs`, `createPlanner`, `createRecordingStore`, ...), utilities (`stableJson`, `sha256Hex`, `checkNavigation`, `renderTree`, `treeHash`, ...) and everything from `contracts`. |
| `@ai-bdd/sdk/contracts` | Types and `AiBddError`/`ERROR_CODES` only. Import from here when writing a driver or model adapter. |

## The integration contract

If you embed ai-bdd in a test framework (Playwright Test, vitest, Jest, a custom runner), these are the rules.

1. **`loadPlansSync(planDir)` reads committed plan JSON synchronously.** It never calls a model, a driver or the network. It throws `PLAN_CORRUPT` for invalid files and `PLAN_SCHEMA_UNSUPPORTED` for an unknown schema version. Frameworks collect tests synchronously at module load, so register tests from these plans.
2. **Collection never compiles.** Plans can be stale relative to the docs. Run `ai-bdd compile --check` in CI before the framework run; it exits 4 when anything is stale.
3. **`createEngine(config, overrides?)` is async and idempotent per config object.** Create it lazily (first test, or a worker-scoped fixture), not at collection.
4. **`engine.runScenario(scenarioId, opts)` runs one scenario and returns a `ScenarioResult`.** It resolves for every outcome. It rejects only for usage errors such as `SCENARIO_NOT_FOUND` or `RECORDING_READ_ONLY`.
5. **`opts.sessionFactory` adopts the host's browser.** If given, the engine calls it with the `SessionOptions` it built (scenario id, base URL, policy, value resolver) instead of opening a session from the configured driver, and no configured driver is created. The adopted session's `driverId` selects the recordings directory. For a Playwright page use `sessionFromPage` from `@ai-bdd/driver-playwright`; its `close()` never closes the page.
6. **`engine.on(listener)` streams `RunEvent`s** and returns an unsubscribe function.
7. **`engine.close()` finalizes the engine's run directory** (one lazily created per engine for all `runScenario` calls) and disposes drivers. Call it when you are done; an unfinalized run directory is reported by `ai-bdd verify-run`.
8. **Respect `status`.** Treat `passed` as success. `healed` is a pass that deserves attention (fail on it if you want `--strict` behaviour). `failed`, `inconclusive`, `blocked`, `error` and `skipped` are not successes.
9. **Recording mode follows config.** With `CI=true` or `CI=1` recordings are read-only: scenarios without a valid recording characterize in memory, are not saved and report `recording: 'discarded'`. Characterize locally, commit the recordings.

Nothing else is required. Concurrency is yours: the engine is safe to call concurrently (runner gates cap sessions per driver and serialize `exclusiveResource`), and each scenario gets its own session.

### Minimal integration

```ts check
import { createEngine, loadConfig, loadPlansSync } from '@ai-bdd/sdk';

const config = await loadConfig({ cwd: process.cwd() });
const plans = loadPlansSync(config.planDir);
const engine = await createEngine(config);

const off = engine.on((event) => {
  if (event.type === 'step-end') console.log(`  ${event.result.status.padEnd(8)} ${event.result.kind} ${event.result.text}`);
});

let failures = 0;
for (const plan of plans) {
  for (const feature of plan.features) {
    for (const scenario of feature.scenarios) {
      if (scenario.review === 'rejected') continue;
      const result = await engine.runScenario(scenario.id);
      console.log(scenario.id, result.status);
      if (result.status !== 'passed' && result.status !== 'healed') failures += 1;
    }
  }
}

off();
await engine.close();
process.exitCode = failures === 0 ? 0 : 1;
```

### Playwright Test, hand-rolled

This is what `registerAiBddScenarios` does, reduced to the essentials. The `page` fixture is Playwright's; ai-bdd drives it through the Playwright driver's `sessionFromPage`.

```ts check
import { test } from '@playwright/test';
import { createEngine, loadConfig, loadPlansSync } from '@ai-bdd/sdk';
import type { Engine } from '@ai-bdd/sdk/contracts';
import { sessionFromPage } from '@ai-bdd/driver-playwright';

// One engine per worker process, created lazily by the first test.
let engine: Promise<Engine> | undefined;
const getEngine = (): Promise<Engine> => (engine ??= loadConfig({ cwd: process.cwd() }).then((config) => createEngine(config)));

// Collection is synchronous: read the committed plans, call no model and no browser.
for (const plan of loadPlansSync('.ai-bdd/plans')) {
  for (const feature of plan.features) {
    test.describe(feature.title, () => {
      for (const scenario of feature.scenarios) {
        if (scenario.review === 'rejected') continue;
        test(scenario.title, { tag: scenario.tags.map((t) => `@${t.replace(/^@/, '')}`) }, async ({ page }) => {
          const ai = await getEngine();
          const { policy, baseURL } = ai.config;
          const result = await ai.runScenario(scenario.id, {
            sessionFactory: (options) => sessionFromPage(page, options, { policy, ...(baseURL === undefined ? {} : { baseURL }) }),
          });
          if (result.status !== 'passed' && result.status !== 'healed') {
            const failing = result.steps.find((s) => s.status !== 'passed' && s.status !== 'healed' && s.status !== 'skipped');
            throw new Error(`${scenario.id} ${result.status}: ${failing?.text ?? ''} ${failing?.error?.code ?? ''}`);
          }
        });
      }
    });
  }
}

test.afterAll(async () => {
  await (await engine)?.close();
});
```

`playwright.config.ts` needs a generous timeout, because a first (characterization) run calls models and performs a confirm run. Replays are fast.

```ts check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: 'ai-bdd.spec.ts',
  timeout: 180_000,
  fullyParallel: true,
  use: { headless: true },
});
```

Notes:

- Playwright derives the fixtures a test needs from the first parameter of its body, so destructure `{ page }`.
- With several spec files in one worker each file closes its engine in its own `afterAll`; the next file creates a new one (a new run directory). Closing happens per file because Playwright has no worker-end hook reachable from the `test` object.
- Set ai-bdd `baseURL`, policy, models and fixtures in `ai-bdd.config.*`. Playwright only supplies the page.
- `@playwright/test` and `@ai-bdd/driver-playwright` must use the same `playwright-core` version, or the `Page` types will not match.

### The packaged integration

`@ai-bdd/playwright-test` does the above plus titles that stay unique, tags, evidence attachments and annotations for healed and fuzzy steps:

```ts check
import { test } from '@playwright/test';
import { registerAiBddScenarios } from '@ai-bdd/playwright-test';

registerAiBddScenarios({
  test,
  planDir: '.ai-bdd/plans',
  filter: { tags: ['billing'] },
  failOnHealed: false,
});
```

Options: `configPath`, `planDir` (default `.ai-bdd/plans`; pass it if your config changes `planDir`), `filter { selectors, tags, grep }` (same meaning as `ai-bdd run`), `failOnHealed`. Tests are tagged with the scenario tags (`playwright test --grep @billing`) and attach `ai-bdd-result.json`, `ai-bdd-steps.txt` and step screenshots. See `packages/playwright-test/README.md`.

## Configuration

```ts
defineConfig(userConfig)                                  // typed identity helper for config files
await loadConfig({ cwd, configPath?, env? })             // find and resolve ai-bdd.config.{ts,mjs,js,json}
resolveConfig(userConfig, { projectRoot, configPath?, env })   // pure; validates and applies defaults
```

`loadConfig` tries `ai-bdd.config.ts`, then `.mjs`, `.js`, `.json`. A `.ts` file is imported with Node's native type stripping; if the runtime cannot, you get `CONFIG_TS_UNSUPPORTED` (use `.mjs` or `.json`). `drivers.<name>` and `models` may be `{ use: '<package or ./file>', options: {...} }` in a `.json`, `.mjs` or `.js` config; the package must export `createDriverFactory(options)` or `createModelSet(options)` ([Models](#models), [drivers.md](drivers.md#plugging-in-a-driver)). In a typed `.ts` config, pass the object a factory function returns instead (`playwright(...)`, `aiSdkModels(...)`, your own `ModelSet`). Unknown keys and bad values throw `CONFIG_INVALID` naming every offending path.

| Key | Default | Notes |
|---|---|---|
| `docs` | `['docs/**/*.md']` | Globs relative to the project root. |
| `exclude` | `['**/node_modules/**', '.ai-bdd/**']` | |
| `planDir`, `recordingsDir`, `runsDir`, `cacheDir` | `.ai-bdd/plans`, `.ai-bdd/recordings`, `.ai-bdd/runs`, `.ai-bdd/cache` | |
| `baseURL` | none | Its host is added to `policy.allowHosts`. |
| `drivers`, `defaultDriver` | `{}` | See [drivers.md](drivers.md). |
| `models` | none | A `ModelSet` of four `ChatModel`s: `extract`, `act`, `checkgen`, `judge`. |
| `fixtures` | `[]` | `FixtureDefinition[]`; see [authoring-docs.md](authoring-docs.md#fixtures). |
| `secrets` | `{}` | `{ name: { env: 'ENV_VAR' } }`. Values are read from the environment and never stored in the resolved config. At least 4 characters. |
| `context` | `''` | App vocabulary given to the extractor, actor and judge. |
| `extract` | `{ sectionDepth: 2, maxSectionChars: 12000, minQuoteChars: 12, concurrency: 4 }` | |
| `characterize` | `{ confirmRuns: 1, probeMs: 500, healThreshold: 2 }` | |
| `judge` | `{ passThreshold: 0.8, failThreshold: 0.3, samples: 3, maxSpread: 0.5, vision: true, maxTreeChars: 20000 }` | Needs `failThreshold < passThreshold`, thresholds in 0..1, `samples` 1..9. |
| `agent` | `{ maxActions: 20, maxModelCalls: 15, maxWaitMs: 5000 }` | Budgets per step. |
| `checks` | `{ maxAttempts: 3, maxPredicates: 8, requireDeterministic: false }` | With `requireDeterministic`, a `then` step whose check cannot be generated fails (`CHECK_GENERATION_FAILED`) instead of staying fuzzy. |
| `settle` | `{ quietMs: 300, intervalMs: 100, timeoutMs: 5000, requireSettled: true }` | |
| `policy` | `{ allowHosts: ['localhost', '127.0.0.1', '[::1]'] + baseURL host, denyVerbs: [] }` | Setting `allowHosts` replaces the localhost defaults; the `baseURL` host is still added. Entries are exact hosts or `*.suffix`. |
| `concurrency` | `{ scenarios: 4 }` | |
| `recordingsMode` | `CI ? 'read-only' : 'read-write'` | `AI_BDD_RECORDINGS=read-write\|read-only\|off` overrides. |
| `reporters` | `['json', 'junit', 'markdown']` | |
| `prices` | `{}` | `{ modelId: { inputPerMTok, outputPerMTok } }`; adds `estimatedCostUsd` to reports. |

## Engine

| Method | Purpose |
|---|---|
| `compile(opts?)` | `{ docs?, full?, dryRun?, check? }` → `CompileResult` with per-doc added/updated/removed ids, diagnostics, usage and `exitCode`. |
| `status()` / `plans()` | Freshness per doc (no model calls) / the stored plans. |
| `listScenarios(filter?)` | `ScenarioTarget[]` (`plan`, `feature`, `scenario`), non-rejected, filtered by `selectors`, `tags`, `grep`. |
| `review(id, action)` | `accept`, `reject`, `pin`, `unpin`. |
| `run(opts?)` | The CLI's run: frozen check, optional compile, select, run, reporters. Returns a `RunReport` with `exitCode`. |
| `runScenario(id, opts?)` | One scenario; `opts` may carry `sessionFactory`, `updateRecordings`, `strict`, `noAgent`, `audit`, `driver`, `signal`. |
| `verifyRun(dir)`, `prune({ dryRun })`, `doctor({ offline })` | Integrity check, delete orphaned recordings, diagnostics. |
| `on(listener)` / `close()` | Events / finalize and dispose. |

`createEngine(config, overrides?)` accepts `overrides` `{ models, drivers, clock, env }` for embedding and tests (an already-built `ModelSet`, a driver factory, a fixed clock). The deterministic doubles in `@ai-bdd/testing` (`createFakeModels`, `fakeDriver`) are for ai-bdd's own tests and for offline tests of an integration; they are not a CLI mode. See [Test doubles](#test-doubles).

### Results

A `ScenarioResult` has `status`, `mode` (`characterize | replay | mixed`), `recording` (`created | updated | unchanged | discarded | none`), `steps`, `confirm`, `error`, `usage`, `durationMs`. Each `StepResult` has `status`, `path` (`fixture | replay | heal | agent | check | judge | check+judge`), `determinism`, `fuzzyReasons`, an `error` payload `{ code, message, retryable, details }`, the `check` evaluation or `judge` verdict, and `sources` (chunk refs with quotes) for tracing back to the doc.

### Events

`compile-section`, `run-start`, `scenario-start`, `step-start`, `step-end`, `scenario-end`, `run-end`, `log`. Events are redacted before they are stored in the run directory.

### Errors

Failures that make a request meaningless are thrown as `AiBddError` (`code`, `message`, `retryable`, `details`). Scenario outcomes are results, not exceptions. The CLI maps errors to exit codes: usage and config errors (`USAGE`, `CONFIG_*`, `SECRET_*`, `DOC_READ_FAILED`, `RECORDING_READ_ONLY`, `SCENARIO_NOT_FOUND`, corrupt plans) to 2, infrastructure (`DRIVER_UNAVAILABLE`, `MODEL_UNAVAILABLE`) to 3. All codes: [errors.md](errors.md).

## Building on the pieces

The engine wires these public factories; you can use them alone: `createChunker().chunk(doc, opts)` and `discoverDocs(config)` (parse docs), `createPlanner(config)` (dirty sections, merge, status, review), `createPlanStore({ dir, readOnly })`, `createRecordingStore({ dir, mode })`, `createRecorder`, `createAsserter`, `createJudge`, `createActor`, `createRunner`, `createReporters(names)`, `createRedactor(secrets)`, `verifyRun(dir)`. Their exact shapes are the `Create*` types in `@ai-bdd/sdk/contracts`. The recording and plan file formats are stable JSON with `schemaVersion: 1`.

## Models

A model adapter implements `ChatModel { id, generate(request) → response }` and a `ModelSet` is one per purpose: `{ extract, act, checkgen, judge }`. Requests carry tool calls and structured output. `request.context` is structured metadata for logs and test doubles and is never sent to a provider. Errors: provider failures are `MODEL_UNAVAILABLE` (retryable), unparsable or schema-invalid output is `MODEL_OUTPUT_INVALID`.

Models are real models: ai-bdd needs an `act` model that can drive a driver through tool calls and a `judge` that reads evidence, and there is no built-in stand-in. You plug them in through `models`, the same way as drivers.

**The AI SDK adapter.** `@ai-bdd/models-ai-sdk` adapts the Vercel AI SDK. In a JS or JSON config, name the package and give model ids (strings go to the AI SDK unchanged, so `provider/model` ids use the AI Gateway and need `AI_GATEWAY_API_KEY`; provider packages read their own key variable):

```js
// ai-bdd.config.mjs
export default {
  models: {
    use: '@ai-bdd/models-ai-sdk',
    options: { extract: 'anthropic/claude-sonnet-5.5', act: 'anthropic/claude-sonnet-5.5', checkgen: 'anthropic/claude-sonnet-5.5', judge: 'anthropic/claude-opus-5.5', maxRetries: 2 },
  },
};
```

In TypeScript, call the factory and pass AI SDK model objects when you want a specific provider package:

```ts
import { defineConfig } from '@ai-bdd/sdk';
import { aiSdkModels } from '@ai-bdd/models-ai-sdk';
import { anthropic } from '@ai-sdk/anthropic';

export default defineConfig({
  models: aiSdkModels(
    {
      extract: anthropic('claude-sonnet-5-5'),
      act: anthropic('claude-sonnet-5-5'),
      checkgen: anthropic('claude-sonnet-5-5'),
      judge: anthropic('claude-opus-5-5'),
    },
    { maxRetries: 2 },
  ),
});
```

**Your own `ModelSet`.** For a provider the AI SDK cannot reach, implement `ChatModel` four times (they may share one class) and hand the set to the config. This block typechecks against the contracts; the `generate` body is where your provider call goes:

```ts check
import { defineConfig } from '@ai-bdd/sdk';
import type { ChatModel, ModelRequest, ModelResponse, ModelSet } from '@ai-bdd/sdk/contracts';

class MyChatModel implements ChatModel {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    // Call your provider with req (system prompt, messages, tools, response schema, purpose) and map its answer to a ModelResponse.
    throw new Error(`not implemented for ${req.purpose}`);
  }
}

const models: ModelSet = {
  extract: new MyChatModel('my-extract'),
  act: new MyChatModel('my-act'),
  checkgen: new MyChatModel('my-checkgen'),
  judge: new MyChatModel('my-judge'),
};

export default defineConfig({ models });
```

To make the same set loadable from `{ use: '<your-package>', options }`, export `createModelSet(options): ModelSet | Promise<ModelSet>` from the package (`options` is whatever the config gave; validate it and throw `CONFIG_INVALID` on bad input).

`ai-bdd doctor` checks that the model set loads and, without `--offline`, probes each purpose with a minimal request.

## Test doubles

`@ai-bdd/testing` also ships deterministic doubles: `createFakeModels({ rulesDir })` (a rule-based `ModelSet`), `fakeDriver({ flags })` (an in-memory driver for the Acme demo app) and `writeTestConfig(...)`, which writes a config file that plugs both in through the ordinary `drivers` and `models` keys on top of a project's real config. They exist for ai-bdd's own test suite and for authors of integrations who want offline, deterministic tests of their own glue code. A test selects the generated file with `ai-bdd -c <file>` or `loadConfig({ configPath })`, exactly as a user selects a config that plugs in a computer-use or browser-use driver. The CLI has no fake mode and reads no environment variable for it; nothing in the product path depends on `@ai-bdd/testing`.
