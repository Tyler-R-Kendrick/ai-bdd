# ai-bdd

Turn plain markdown (requirements, READMEs, design docs, runbooks) into executable acceptance tests.

You write prose. `ai-bdd` extracts features, user stories and Given/When/Then scenarios from it, binds every one to the exact paragraphs and quotes it came from, and runs them against your app. The first run of a scenario uses an AI agent and an AI judge. Everything that proves deterministic is recorded, and later runs replay it with **zero model calls**. What cannot be made deterministic stays AI-driven and is labelled `fuzzy`, with the reason.

## Why

| Problem with "ask an LLM to test my docs" | What ai-bdd does |
|---|---|
| Tests change on every run | Extraction is a separate `compile` step. Its output, the **plan**, is a committed JSON file. Unchanged docs recompile to identical bytes with no model call. |
| The model invents requirements | Every feature and scenario must cite a chunk with a **verbatim quote**. Ungrounded output is dropped. |
| Snapshotting the app bakes in its bugs | The **document** is the oracle. A recording is saved only if a judge confirms the doc's criterion on the first run. |
| AI tests are slow, costly and flaky | Deterministic steps replay from recordings with no model. A check must be false before, true after, and true again on a delayed probe. A confirm run in a fresh session proves it. |
| Nobody can review what the AI did | Plans and recordings are small, sorted, reviewable JSON. `ai-bdd show` prints Gherkin with a `# source:` quote under every step. |

## How it works

```
docs/*.md ──compile──► .ai-bdd/plans/*.plan.json     (committed, reviewed)
                              │
        ai-bdd run ───────────┤  first run:  agent acts, judge checks the doc's criterion, recording saved if all pass
                              │  later runs: replay + generated checks, no model; fuzzy steps still use agent / judge
                              ▼
              .ai-bdd/recordings/<driver>/*.json     (committed, reviewed)
              .ai-bdd/runs/<id>/, .ai-bdd/report/    (not committed: evidence, report.json, junit.xml, summary.md)
```

Read [docs/concepts.md](docs/concepts.md) for the full model.

## Quickstart with the Acme demo (real models, real browser)

ai-bdd always runs against a real driver and real models. The repository ships a small demo web app, "Acme" (`startAcmeApp` in `@ai-bdd/testing`), and a demo project (`packages/testing/corpus`: docs plus a real `ai-bdd.config.mjs` with the Playwright driver and AI SDK models) so you can watch the whole loop on something you do not have to set up.

Prerequisites: Node 22.18 or newer, [pnpm](https://pnpm.io), a checkout of this repository with `pnpm install` done, a Chromium ([Real setup](#real-setup) step 4), and a model provider key. The commands cost real tokens: a few dozen model calls for the first `compile` and `run`, none for the second `run`. Run everything from the repository root unless a step says otherwise.

```sh
# 1. Credentials. AI_GATEWAY_API_KEY is read by the AI SDK for "provider/model" ids such as the default
#    anthropic/claude-sonnet-5.5. Use your provider's key variable instead if you pick a provider package.
export AI_GATEWAY_API_KEY=...
export ACME_ADMIN_PASSWORD=correct-horse-battery   # the demo app's admin password; the config declares it as a secret
export AI_BDD_MODEL=anthropic/claude-sonnet-5.5    # optional: any model id the AI SDK can resolve

# 2. Work on a copy of the demo project, then start the demo app in the background.
cp -r packages/testing/corpus packages/testing/.quickstart
cd packages/testing/.quickstart
node --conditions=source --input-type=module -e "import { startAcmeApp } from '@ai-bdd/testing'; const app = await startAcmeApp({ port: 4173 }); console.log('Acme on', app.url)" &
ai-bdd() { node --conditions=source ../../cli/src/bin.ts "$@"; }
```

The demo project's `ai-bdd.config.mjs` is the whole integration: a driver and a model set, both plugged in through the config.

```js
// packages/testing/corpus/ai-bdd.config.mjs (abridged)
export default defineConfig({
  docs: ['docs/**/*.md'],
  baseURL: process.env.ACME_URL ?? 'http://localhost:4173',
  secrets: { adminPassword: { env: 'ACME_ADMIN_PASSWORD' } },
  drivers: { web: { use: '@ai-bdd/driver-playwright', options: { browser: 'chromium', headless: true } } },
  defaultDriver: 'web',
  models: { use: '@ai-bdd/models-ai-sdk', options: { extract: model, act: model, checkgen: model, judge: model } },
});
```

Then the loop:

```sh
# 3. Check the setup: Node, config, the driver (can it launch a browser?) and the models.
ai-bdd doctor

# 4. Compile: a real model extracts features and scenarios from docs/*.md into .ai-bdd/plans/*.plan.json.
ai-bdd compile

# 5. Compiling again changes nothing and makes no model call.
ai-bdd compile

# 6. Review the plan: Gherkin with a source quote under every step. A real model words features its own way, so
#    your ids may differ from this README; `show` prints them. Accept what you agree with.
ai-bdd show docs/billing.md
ai-bdd review accept <feature-id>

# 7. First run: characterize. The agent drives the browser, the judge checks the document's criterion,
#    deterministic steps are recorded under .ai-bdd/recordings/playwright/. (docs-billing-- selects the billing doc.)
ai-bdd run docs-billing--

# 8. Second run: replay. The recorded steps run without any model: "Model calls: 0".
ai-bdd run docs-billing--

# 9. See which steps are deterministic and why others are fuzzy.
ai-bdd show docs-billing-- --recordings
```

Expected shape of the output of steps 7 and 8 (scenario ids, counts, timings and the first run's token counts vary with your models):

```text
PASS  docs-billing--<feature>/<scenario>  (characterize, recording created, 14.2s)
Recordings (read-write): 2 created
...
PASS  docs-billing--<feature>/<scenario>  (replay, 2.2s)
Steps: 2 replayed, 0 by agent, 0 healed, 0 fuzzy
Model calls: 0 (0 input / 0 output tokens)
```

Look around: `.ai-bdd/plans/` (the plan), `.ai-bdd/recordings/playwright/` (the recordings), `.ai-bdd/report/summary.md` (traceability matrix from doc chunks to scenarios). Then stop the demo app and clean up:

```sh
kill %1; cd ../../.. && rm -rf packages/testing/.quickstart
```

Try the rest of the corpus: `ai-bdd run docs-todos-- docs-checkout--` shows `fuzzy` steps (volatile timestamps, a subjective criterion) and `ACT_TARGET_AMBIGUOUS` (the doc says "submits the form" and the page has two Submit buttons).

To drive the same app with a different engine (for example [Cua Driver](https://cua.ai/docs/cua-driver) through `@ai-bdd/driver-cua`, or a browser-use runtime), change only the `web` entry of `drivers`: see [Plugging in a driver](docs/drivers.md#plugging-in-a-driver). Because these steps need a key and a browser, they are not executed by the docs checker; the repository's own tests use deterministic test doubles instead ([FAQ](docs/faq.md#are-there-fake-models-or-a-fake-mode)).

## Real setup

The packages are not published to npm yet. Until they are, build this repository (`pnpm install && pnpm build`) and link the packages into your project, or add it as a workspace.

1. Install the CLI, SDK, Playwright driver and AI SDK adapter, plus a provider package:

   ```sh
   pnpm add -D @ai-bdd/cli @ai-bdd/sdk @ai-bdd/driver-playwright @ai-bdd/models-ai-sdk ai @ai-sdk/anthropic
   ```

2. Scaffold the config, an example doc, `.gitignore` entries and `.ai-bdd/plans/`:

   ```sh
   pnpm exec ai-bdd init          # add --json for ai-bdd.config.json
   ```

3. Edit `ai-bdd.config.ts`. Set `baseURL` to your running app, pick models, and declare secrets by environment variable name:

   ```ts
   import { defineConfig } from '@ai-bdd/sdk';
   import { playwright } from '@ai-bdd/driver-playwright';
   import { aiSdkModels } from '@ai-bdd/models-ai-sdk';
   import { anthropic } from '@ai-sdk/anthropic';

   export default defineConfig({
     docs: ['docs/**/*.md'],
     baseURL: 'http://localhost:3000',
     drivers: { web: playwright({ browser: 'chromium', headless: true }) },
     defaultDriver: 'web',
     models: aiSdkModels({
       extract: anthropic('claude-sonnet-5-5'),
       act: anthropic('claude-sonnet-5-5'),
       checkgen: anthropic('claude-sonnet-5-5'),
       judge: anthropic('claude-opus-5-5'), // use a different model than `act`, see docs/faq.md
     }),
     context: 'Describe your app vocabulary here.',
     secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } },
   });
   ```

   The model ids are examples. The config is loaded with Node's native TypeScript support; use `ai-bdd.config.mjs` or `.json` if your Node cannot. Drivers and models are plain config entries: `drivers: { web: { use: '<package>', options } }` plugs in any package that exports `createDriverFactory(options)`, `models: { use: '<package>', options }` any package that exports `createModelSet(options)` ([docs/drivers.md](docs/drivers.md#plugging-in-a-driver), [docs/sdk.md](docs/sdk.md#models)).

4. Provide credentials and a browser. Set the provider key your adapter needs (for example `ANTHROPIC_API_KEY`) and every `secrets` variable. The driver never downloads a browser: it uses `AI_BDD_CHROMIUM_PATH`, Playwright's own lookup or a Chromium under `PLAYWRIGHT_BROWSERS_PATH`. Install one with `npx playwright-core install chromium` if needed.

5. Start your app, then check the setup and run the loop:

   ```sh
   pnpm exec ai-bdd doctor
   pnpm exec ai-bdd compile
   pnpm exec ai-bdd show
   pnpm exec ai-bdd review accept <feature-id>   # after reading the plan
   pnpm exec ai-bdd run
   ```

6. Commit `.ai-bdd/plans/` and `.ai-bdd/recordings/` and review them in pull requests like snapshots ([docs/review-guide.md](docs/review-guide.md)).

7. In CI run `ai-bdd compile --check` then `ai-bdd run`. With `CI=1` the run is `--frozen` (a stale plan exits 4, nothing runs) and recordings are read-only. See [docs/cli.md](docs/cli.md).

## Commands

| Command | Purpose |
|---|---|
| `init` | Scaffold config, example doc, `.gitignore` entries. |
| `compile [docs...]` | Extract plans from changed sections (`--full`, `--dry-run`, `--check`). |
| `status` | Plan freshness, coverage, unreviewed scenarios. No model calls. |
| `show [id\|docUri]` | Render plans as Gherkin with source quotes (`--recordings`, `--json`). |
| `review <accept\|reject\|pin\|unpin> <id...>` | Edit review state. Rejected scenarios never come back. |
| `run [selectors...]` | Characterize or replay (`--frozen`, `--strict`, `-u`, `--audit`, `--no-agent`, ...). |
| `verify-run <runDir>` | Check a run directory's artifact hashes. |
| `prune` | Delete recordings of scenarios that no longer exist. |
| `doctor` | Check Node, config, drivers, models, plan freshness. |

Exit codes: `0` passed, `1` failed or inconclusive or blocked, `2` usage or config error, `3` infrastructure error, `4` stale plan under `--frozen` or `compile --check`.

## Packages

| Package | Purpose |
|---|---|
| `@ai-bdd/sdk` | Public API: config, engine, plans, recordings, contracts. Everything else builds on it. |
| `@ai-bdd/cli` | The `ai-bdd` command, a thin layer over the SDK. |
| `@ai-bdd/driver-playwright` | Playwright driver, plus `sessionFromPage` for embedding. |
| `@ai-bdd/models-ai-sdk` | Vercel AI SDK adapter for the four model purposes. |
| `@ai-bdd/playwright-test` | Runs scenarios as `@playwright/test` tests. |
| `@ai-bdd/testing` | Acme demo app, demo corpus, and deterministic test doubles (`fakeDriver`, `createFakeModels`, `writeTestConfig`) for ai-bdd's own tests and for offline tests of integrations. Not a product mode, not needed by users. |

## Documentation

- [Concepts](docs/concepts.md): compile, plan, run, characterize, fuzzy.
- [Authoring docs](docs/authoring-docs.md): directives and writing testable prose.
- [Review guide](docs/review-guide.md): reviewing plan diffs and recordings.
- [Drivers](docs/drivers.md): the Playwright driver, the Cua Driver package, plugging in other drivers (browser-use) and writing your own.
- [SDK](docs/sdk.md): the integration contract and a Playwright Test example.
- [CLI reference](docs/cli.md).
- [Security](docs/security.md): threat model, policy, secrets, evidence integrity limits.
- [FAQ](docs/faq.md): why not Gherkin, why not pixel snapshots, what "deterministic" means, cost.
- [Error codes](docs/errors.md).

## Known limits

- The judge is an LLM. A wrong verdict on the first run can become a recording; review recordings, and use `--audit` to compare judge and checks later ([docs/faq.md](docs/faq.md)).
- Settle detection sees ARIA busy signals, not CSS-only animations.
- Web apps out of the box (Playwright), native apps and browsers through `@ai-bdd/driver-cua` (Cua Driver; tested on Linux/X11 with Chromium only). Other engines (browser-use, mobile) plug in through the `Driver` interface ([docs/drivers.md](docs/drivers.md#plugging-in-a-driver)).

## License

MIT
