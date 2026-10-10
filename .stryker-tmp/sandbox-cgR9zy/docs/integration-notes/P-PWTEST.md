# P-PWTEST: `@ai-bdd/playwright-test`

## playwright-test

Public API (details in `packages/playwright-test/README.md`):

- `registerAiBddScenarios({ test, configPath?, planDir?, filter?, failOnHealed? })`
- `closeAiBddEngines()`
- `resolvePlanDir({ configPath?, planDir? })`
- types `RegisterOptions`, `TestLike`, `TestInfoLike`, `TestFixturesLike`, `PageLike`

Behavior:

- Registration is synchronous (R-SDK1). It calls `loadPlansSync(planDir)` only. `planDir` defaults to
  `.ai-bdd/plans` next to `configPath`, or in `process.cwd()`. It is not read from the config because the config loads
  asynchronously. A scenario unknown to the engine (`SCENARIO_NOT_FOUND`) is reported with a hint about the mismatch.
- Titles: `test.describe(feature.title)` > `test(scenario.title, { tag })`. Duplicates get stable qualifiers
  (`Title (docUri)` for features, `Title (scenarioId)` for scenarios). Rejected scenarios and features are skipped. The
  filter follows `ai-bdd run` (§9.1) and is applied locally, with no engine.
- Each test uses a per-worker memoized engine (`loadConfig` + `createEngine`, lazy, failures not memoized) and calls
  `engine.runScenario(id, { sessionFactory })` with `sessionFromPage(page, opts, { policy, baseURL })` (R-SDK3). Only
  `sessionFactory` is passed in the run options.
- Evidence: attachments `ai-bdd-result.json`, `ai-bdd-steps.txt` and screenshot artifacts. Annotations:
  `ai-bdd:scenario`, `ai-bdd:source`, `ai-bdd:mode`, `healed`, `fuzzy`.
- Verdict: `passed` passes; `healed` passes unless `failOnHealed`; every other status fails with a message naming the
  failing step, error code, details and source quote.
- Teardown: a file-level `test.afterAll` closes and evicts the engines. Playwright has no worker-end hook reachable
  from the `test` object, so the run directory is finalized once per worker per spec file (documented in the README).

## Findings and requests for X-INTEGRATOR

1. **Playwright requires the destructuring pattern** `async ({ page }, testInfo) => ...`. A plain `(fixtures, testInfo)`
   parameter is rejected at collection ("First argument must use the object destructuring pattern"). Found by the
   `playwright test --list` spawn test, which runs against the real `loadPlansSync`.
2. **Artifact lookup (optional contract proposal).** `Engine` does not expose its run directory, so screenshot artifacts
   are located by scanning `config.runsDir` (run ids are time ordered) for the `ArtifactRef.path`. If you ever add
   `engine.runDir` (or `ScenarioResult.runDir`), `src/evidence.ts` can use it directly. Missing artifacts never fail a test.
3. **Dependencies:** none requested. The package imports only `@ai-bdd/sdk`, `@ai-bdd/sdk/contracts` and
   `@ai-bdd/driver-playwright` (type of `sessionFromPage`'s page parameter is taken from its signature).

## Tests and what is still pending

- `test/register.test.ts` and `test/select.test.ts` (unit, `vi.mock` of the SDK and driver; no siblings needed).
- `test/playwright-spawn.test.ts`:
  - `playwright test --list` against hand written plan JSON (needs only the real `loadPlansSync`; passes today). It
    points `AI_BDD_CONFIG` at a missing file to prove collection loads no config.
  - The full M22 run spawns `@playwright/test` against `startAcmeApp` with `createFakeModels`. It is self-skipping, with
    the reason in the test name, until all of these exist: real `createEngine`/runner, `sessionFromPage`, `fakeDriver`,
    `startAcmeApp`, `packages/testing/corpus` (with `docs/*.md` and `fake-model/`), and a Chromium.
    It compiles the corpus into a temp project, runs `engine.run({ selectors: ['docs/billing.md'] })` with the fake driver
    as the baseline, then runs the Playwright example (`test/example/`) with the same plans and compares the
    `scenarioId -> status` maps from the attached `ai-bdd-result.json`, plus the pass/fail verdict.
  - Assumptions to check when it first runs for real: the worker loads the generated `ai-bdd.config.pwtest.mjs`, which
    imports `packages/testing/src/index.ts` by file URL (child runs with `NODE_OPTIONS=--conditions=source`); the
    example's `tsconfig.json` `paths` map `@ai-bdd/*` to sibling sources for Playwright's TypeScript loader; the config
    needs no registered driver other than `fake` because `sessionFactory` supplies the session.

## VERIFY outcomes

None owned by this swarm.
