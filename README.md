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

## 60-second quickstart (no API keys, no browser)

`AI_BDD_FAKE=1` swaps in a deterministic rule-based fake model and an in-memory fake driver for the bundled "Acme" demo app. You run the real pipeline end to end offline.

Prerequisites: Node 22.18 or newer, [pnpm](https://pnpm.io), and a checkout of this repository with `pnpm install` done. Run the commands from the repository root in one terminal.

```sh run
# 1. Work on a copy of the demo corpus (docs + fake model rules + config).
cp -r packages/testing/corpus packages/testing/.quickstart
cd packages/testing/.quickstart
export AI_BDD_FAKE=1 AI_BDD_FAKE_RULES="$PWD/fake-model"
ai-bdd() { node --conditions=source ../../cli/src/bin.ts "$@"; }

# 2. Compile: extract the plans from docs/*.md (one fake model call per section).
ai-bdd compile

# 3. Nothing changed, so compiling again makes no model calls and rewrites nothing.
ai-bdd compile

# 4. Read what was extracted: Gherkin with a source quote under each step.
ai-bdd show docs-billing--upgrade-to-pro

# 5. First run: characterize. The agent acts, the judge checks, recordings are saved.
ai-bdd run docs-billing--upgrade-to-pro

# 6. Second run: replay. "Model calls: 0".
ai-bdd run docs-billing--upgrade-to-pro

# 7. See which steps are deterministic and why others are fuzzy.
ai-bdd show docs-billing--upgrade-to-pro --recordings
```

Expected output of steps 5 and 6 (timings vary):

```text
PASS  docs-billing--upgrade-to-pro/upgrade-from-free-to-pro  (characterize, recording created, 10.7s)
PASS  docs-billing--upgrade-to-pro/upgrade-button-is-visible-on-the-free-plan  (characterize, recording created, 1.8s)
Scenarios: 2 total, 2 passed
Recordings (read-write): 2 created
...
PASS  docs-billing--upgrade-to-pro/upgrade-from-free-to-pro  (replay, 2.2s)
PASS  docs-billing--upgrade-to-pro/upgrade-button-is-visible-on-the-free-plan  (replay, 0.3s)
Steps: 2 replayed, 0 by agent, 0 healed, 0 fuzzy
Model calls: 0 (0 input / 0 output tokens)
```

Look around: `.ai-bdd/plans/` (the plan), `.ai-bdd/recordings/fake/` (the recordings), `.ai-bdd/report/summary.md` (traceability matrix from doc chunks to scenarios). Then clean up:

```sh
cd ../../.. && rm -rf packages/testing/.quickstart
```

Try the rest of the corpus: `ai-bdd run docs-todos-- docs-checkout--` shows `fuzzy` steps (volatile timestamps, a subjective criterion) and `ACT_TARGET_AMBIGUOUS` (the doc says "submits the form" and the page has two Submit buttons). The quickstart commands above are executed in CI by `scripts/check-docs.mjs`.

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

   The model ids are examples. The config is loaded with Node's native TypeScript support; use `ai-bdd.config.mjs` or `.json` if your Node cannot.

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
| `@ai-bdd/testing` | Acme demo app, fake driver, fake models, corpus. Test infrastructure, not needed by users. |

## Documentation

- [Concepts](docs/concepts.md): compile, plan, run, characterize, fuzzy.
- [Authoring docs](docs/authoring-docs.md): directives and writing testable prose.
- [Review guide](docs/review-guide.md): reviewing plan diffs and recordings.
- [Drivers](docs/drivers.md): the shipped drivers and writing your own.
- [SDK](docs/sdk.md): the integration contract and a Playwright Test example.
- [CLI reference](docs/cli.md).
- [Security](docs/security.md): threat model, policy, secrets, evidence integrity limits.
- [FAQ](docs/faq.md): why not Gherkin, why not pixel snapshots, what "deterministic" means, cost.
- [Error codes](docs/errors.md).

## Known limits

- The judge is an LLM. A wrong verdict on the first run can become a recording; review recordings, and use `--audit` to compare judge and checks later ([docs/faq.md](docs/faq.md)).
- Settle detection sees ARIA busy signals, not CSS-only animations.
- Web only for now; the `Driver` interface is the extension point.

## License

MIT
