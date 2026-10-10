# @ai-bdd/playwright-test

Runs ai-bdd scenarios as ordinary `@playwright/test` tests. It is the reference integration that proves the public
`@ai-bdd/sdk` is enough to embed ai-bdd in another test framework: it uses only `loadPlansSync` (collection) and
`engine.runScenario(id, { sessionFactory })` (execution).

## Quick start

```sh
pnpm add -D @ai-bdd/playwright-test @playwright/test
pnpm exec ai-bdd compile          # writes the committed plans; CI should run `ai-bdd compile --check`
```

`ai-bdd.spec.ts`:

```ts
import { test } from '@playwright/test';
import { registerAiBddScenarios } from '@ai-bdd/playwright-test';

registerAiBddScenarios({ test });
```

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: 'ai-bdd.spec.ts',
  timeout: 180_000, // a first (characterization) run calls models and performs a confirm run
  fullyParallel: true,
  use: { headless: true },
});
```

`pnpm exec playwright test` then runs every non-rejected scenario of the plans. A complete runnable example (driven
by environment variables so the repository's own tests can point it at a temporary project) lives in
`test/example/ai-bdd.spec.ts` and `test/example/playwright.config.ts`.

The `baseURL`, drivers, models, policy and fixtures all come from your **ai-bdd config** (`ai-bdd.config.ts|mjs|js|json`).
Playwright only supplies the browser page.

## API

### `registerAiBddScenarios(options): void`

| Option | Meaning |
|---|---|
| `test` | The `test` object from `@playwright/test`. Typed through a minimal interface (`TestLike`), so any compatible double works. |
| `configPath?` | Path to the ai-bdd config. Relative paths resolve against `process.cwd()`. Default: standard lookup in `process.cwd()`. |
| `planDir?` | Directory with the committed `*.plan.json` files. Default `.ai-bdd/plans` next to the config (or in `process.cwd()`). Pass it when your config sets a custom `planDir`. |
| `filter?` | `{ selectors?, tags?, grep? }` with the same meaning as `ai-bdd run`: scenario id, id prefix ending in `/` or `--`, or a doc glob; any matching tag; case-insensitive substring of the scenario title. Rejected scenarios are always skipped. |
| `failOnHealed?` | Fail a scenario that ended `healed`. By default healed passes and is annotated (like the CLI without `--strict`). |

What it registers:

- `test.describe(feature.title)` containing `test(scenario.title, { tag: scenario.tags.map((t) => '@' + t) }, ...)`.
  Run a subset with `playwright test --grep @billing`.
- Titles are stable. When two features or scenarios share a title, the later one gets a stable qualifier
  (`Login (docs/b.md)`, `Works (a--login/ok-2)`), so Playwright's duplicate-title check never trips.

What each test does:

1. Obtains the worker's engine (`loadConfig` + `createEngine`, memoized, created lazily by the first test).
2. Runs `engine.runScenario(scenario.id, { sessionFactory })`, where the factory is
   `(sessionOptions) => sessionFromPage(page, sessionOptions, { policy, baseURL })`. The engine therefore drives the
   Playwright-provided `page` through `@ai-bdd/driver-playwright`, and recordings live under the `playwright` driver id.
3. Attaches `ai-bdd-result.json` (the full `ScenarioResult`), `ai-bdd-steps.txt` (a readable step listing) and the
   screenshot artifacts of the steps (found by content hash in the engine's run directories, at most 30).
4. Adds annotations: `ai-bdd:scenario`, `ai-bdd:source`, `ai-bdd:mode`, and one `healed` / `fuzzy` annotation per
   healed or fuzzy step, so they show up in the HTML report.
5. Passes for `passed` (and `healed` unless `failOnHealed`). Everything else (`failed`, `inconclusive`, `blocked`,
   `error`, `skipped`) fails with a message that names the failing step, its error code and details, and the source
   chunk quote.

### `closeAiBddEngines(): Promise<void>`

Closes and forgets every engine of the current process (finalizing the run directories). It is registered
automatically as a file-level `test.afterAll`; call it yourself from a custom global teardown if you need to.

## Behavior you should know about

- **Collection is synchronous and offline (R-SDK1).** Registration reads plan JSON with `loadPlansSync` and calls no
  model, driver or network. It does not load the ai-bdd config either, which is why `planDir` is a registration option.
  Plans are never compiled here; run `ai-bdd compile` first and `ai-bdd compile --check` in CI.
- **Playwright fixtures.** The test body destructures `{ page }`, because Playwright derives the fixtures to set up from
  that pattern. If your project extends `test` with fixtures that must run, pass your extended `test`.
- **One engine per worker, one run directory per engine.** Playwright workers are separate processes, so each gets its
  own engine and run directory under `runsDir`. Closing happens in a *file-level* `test.afterAll`, which Playwright runs
  once per worker after that worker's last test of the spec file. Playwright offers no hook at the worker's very end
  through the `test` object alone, so with several spec files in one worker each file closes its engine and the next
  file creates a fresh one (a new run directory). If a worker is killed (timeout, crash) its run directory is simply not
  finalized, and `ai-bdd verify-run` will report that.
- **Recordings.** Recording mode follows the ai-bdd config (`CI` makes it read-only). With `fullyParallel`, two workers
  may characterize different scenarios at once; they write different recording files.
- **Timeouts.** Set the Playwright `timeout` generously for first runs; replays are fast.
- **Page lifetime.** `sessionFromPage`'s `close()` never closes the page; Playwright owns it.
