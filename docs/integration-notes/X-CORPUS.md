# X-CORPUS integration notes

## corpus and acceptance harness

Owned paths: `packages/testing/corpus/**`, `tests/acceptance/**`, `tests/live/**`.

### Layout

- `packages/testing/corpus/docs/*.md` (billing, todos, checkout, login, reports, release-notes) and `ai-bdd.config.mjs`.
  The config registers `acmeFixtures`, secret `adminPassword -> ACME_ADMIN_PASSWORD`, an app `context` string and reads an optional
  `.corpus-options.json` next to it (written by the harness so spawned CLI processes can be tuned). The config is a REAL one: the Playwright
  driver and the AI SDK models are plugged in through `{ use, options }` entries (model id from `AI_BDD_MODEL`, judge from `AI_BDD_JUDGE_MODEL`),
  and `baseURL` defaults to `http://localhost:4173` or `$ACME_URL`. A user runs it as is (`ai-bdd compile && ai-bdd run`).
- `packages/testing/corpus/fake-model/*.json` is the complete base rule set (extract for every section, act scripts, checkgen
  programs, judge sample pairs). Pass this directory as `rulesDir` to `writeTestConfig` / `createFakeModels` (the README quickstart now uses real models and does not need it).
- `packages/testing/corpus/fake-model-variants/<name>/*.json` are overlays that tests layer IN FRONT of the base set (first match wins):
  `v2-heal`, `bug-heal-done`, `injection-navigate`, `canary`, `edit-upgrade-step`, `bad-extract-hallucination`,
  `bad-extract-injection`, `bad-extract-schema-repair`, `bad-checkgen-non-discriminative`, `bad-checkgen-retry`,
  `bad-checkgen-volatile-literal`, `bad-judge-contradictory`, `judge-band`, `judge-spread`.
- All rule files are generated: `node packages/testing/corpus/tools/gen-rules.mjs` (commit the output). Quotes are validated against
  the docs by `tests/acceptance/corpus-sanity.test.ts`, which needs no implementation.
- `tests/acceptance/helpers/*`: `project.ts` (temp project per test + rule layering + `project.writeTestConfig()`), `engine.ts` (loadConfig of
  the generated test config + createEngine with the fake models and a virtual clock), `targets.ts` (fake driver or Chromium + `startAcmeApp`), `flows.ts` (the P-row flows and their
  expectations, shared by `mNN-*.test.ts` and `playwright.*.test.ts`), `cli.ts`, `scan.ts` (secret byte search), `timing.ts`.
- Temp projects are created under `tests/acceptance/.work/` (inside the repo, git-ignored by its own `.gitignore`) so
  `import '@ai-bdd/testing'` in the corpus config resolves through the workspace links. `AI_BDD_KEEP_WORK=1` keeps them.

### How tests select the deterministic doubles (no environment flags, no product fake mode)

The product has no fake mode: the CLI and the SDK run exactly what the loaded config registers. The deterministic doubles are test-harness
code that a test plugs in through the ordinary `drivers` / `models` config keys, in a generated config file:

- `writeTestConfig({ projectDir, rulesDir, logPath, flags, overrides })` (`@ai-bdd/testing`) writes `ai-bdd.config.test.mjs` into the project. It
  imports the project's real `ai-bdd.config.mjs`, spreads it, and replaces `drivers` / `defaultDriver` / `models` with `fakeDriver({ flags })` and
  `createFakeModels({ rulesDir, logPath })`. Nothing is read from the environment. `project.writeTestConfig()` fills in the project's rule directory
  and call log.
- `runCli(project, args, { flags, overrides, config })` calls it and spawns `node --conditions=source packages/cli/src/bin.ts -c <file> ...args`.
  `config` replaces the generated file (for example a missing path: `-c missing.config.mjs` must exit 2).
- `openEngine` (SDK level) loads a per-engine generated test config through `loadConfig({ configPath })` and still hands `createEngine` its own
  model set and driver factory, so tests can observe, wrap and replace them (`handle.calls`, `wrapFactory`, `models`). ES modules are imported once per
  file name in a process, so each engine uses its own `ai-bdd.config.test-<n>.mjs`.
- Playwright Test (`playwright.m22`) gets the same kind of file through `AI_BDD_CONFIG`; `baseURL` and the four directories are `overrides`.
- `m26-pluggable-drivers.test.ts` ("pluggable drivers load through { use, options }") proves the generic mechanism with a third-party style
  package fixture (`tests/acceptance/fixtures/vendor-driver`, `createDriverFactory(options)` delegating to `fakeDriver`), loaded both as an
  installed package (`<project>/node_modules/<name>`) and by relative path. The `flags` option is observed through the scenario outcome, and a
  package without `createDriverFactory` is a config error (exit 2).

### Corpus design decisions worth knowing

- Handle numbering: `billing.md` has four context chunks (Overview/Glossary headings and paragraphs) so section handles start at `c5`;
  every other doc has none (`c1`). Both `context` headings carry a directive before AND after the heading so numbering does not depend
  on whether a heading inherits a directive that follows it (the spec is silent). The sanity test checks both interpretations.
- The Downgrading scenarios contain a step "the customer opens the billing page from the navigation" (inferred). Fixtures seed
  server state; a server-rendered page only shows it after a reload, so the step is what makes the scenarios pass under Chromium.
  On the fake driver this step is honestly fuzzy (`no-observable-effect`).
- Judge rules key on evidence in `afterTreeText` (a pass sample set when the evidence is present, a fail sample set otherwise), so app
  regressions (`bug-upgrade-noop`) fail the judge instead of passing silently.
- The `logPath` JSONL (`writeTestConfig({ logPath })`, `createFakeModels({ logPath })`) is the only way to log fake calls; CLI tests read it to count model calls (M13, M15).

### Matrix coverage (fake driver; P rows also under real Chromium with identical statuses)

M1 `m01`, M2 `m02`, M3 `m03`, M4 `m04` (+ schema repair, R-EX3 injection obeyed), M5/M6 `m05-m06` (+ `playwright.m05-m07`),
M7 `m07`, M8 `m08`, M9 `m09` (+ `playwright.m09-m11`), M10 `m10`, M11 `m11` (+ `--audit` disagreement), M12 `m12`,
M13 `m13` (+ taint probe, CLI secret scan, unmasked-driver screenshot gate), M14 `m14`, M15 `m15` (+ exit-code matrix),
M16 `m16`, M17 `m17`, M18 `m18`, M19 `m19`, M20 `m20` (+ exclusiveResource, maxSessions), M21 `m21` (+ driver major change),
M22 `m22` (SDK contract with sessionFactory) and `playwright.m22-playwright-test` (spawns the P-PWTEST example), M23 `m23`,
M24 `m24`, M25 `m25`. P rows: `playwright.m05-m07`, `playwright.m09-m11`, `playwright.m12-m13-m16-m19`, `playwright.m20-parallel`,
`playwright.m22-playwright-test`. Extras: `extras-checks` (R-AS1/R-AS2), `extras-plan` (R-PL1, R-PL3, directives).
Playwright tests skip with a visible reason when no Chromium is found; `AI_BDD_REQUIRE_PW=1` makes that a failure.

### Live end-to-end (real models, real driver, no doubles)

`tests/live/e2e-real.test.ts` is excluded from the `acceptance` project (its own config: `tests/live/vitest.live.config.ts`). It starts the Acme
app, copies the corpus (REAL config + `billing.md` + `login.md`) into a temp project inside the repo and runs the built CLI
(`packages/cli/dist/bin.js`, so run `pnpm build` first; the `source` export condition cannot be used because third-party packages such as the
AI SDK dependencies publish TypeScript under the same condition) with `@ai-bdd/models-ai-sdk` and the Playwright driver (Chromium), `ACME_URL`
pointing at the started app. It asserts only structural guarantees: plans with grounded features, `run` exit code 0 or 1 (never 2/3), a run directory
with `report.json`, no scenario with status `error`, and the admin password absent from `.ai-bdd` in every encoding.

    pnpm build && AI_BDD_LIVE=1 AI_GATEWAY_API_KEY=... pnpm exec vitest run -c tests/live/vitest.live.config.ts

It is skipped, with the reason in the suite title, unless `AI_BDD_LIVE=1`, a provider key (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`), a Chromium (`AI_BDD_CHROMIUM_PATH` or a discoverable install) and the built CLI are all present. `AI_BDD_MODEL` and
`AI_BDD_JUDGE_MODEL` choose the model ids (default `anthropic/claude-sonnet-5.5`). A run with an exhausted provider balance fails with exit 3
(`MODEL_UNAVAILABLE`), which is exactly what the test is meant to catch.

### Findings for X-INTEGRATOR

1. M11 as written ("deterministic check fails, CHECK_FAILED") cannot happen with a scripted `act-confirm-upgrade` rule: under
   `bug-upgrade-noop` the replayed Confirm click yields `effect-unverified`, the step heals, and the heal turn sees a closed dialog.
   The `bug-heal-done` layer makes the fake agent report that step done; the step is `healed`, then the check fails with `CHECK_FAILED`.
2. Judge verdicts are reused for identical evidence across runs (`.ai-bdd/cache`). Tests that need a fresh model answer (audit
   disagreement) delete the cache dir; judge model-call counts in later runs are therefore upper bounds (M7, M21).
3. Under `sessionFactory` (P-PWTEST) the confirm run is handed the same page, which already holds the upgraded state, so a
   characterization run in read-write mode ends in `CHARACTERIZATION_UNSTABLE`. `playwright.m22` runs the Playwright side with
   `AI_BDD_RECORDINGS=read-only` to work around it; the CLI baseline runs read-write.
4. (Historical: with the removed fake mode, `ai-bdd -c missing.config.mjs status` exited 0 because the config was silently replaced by
   defaults. Now an explicit `-c` that does not exist fails with `CONFIG_NOT_FOUND`, exit 2.)
5. Playwright Test workers create the engine with `cwd = process.cwd()`; the M22 test config pins `planDir/recordingsDir/runsDir/cacheDir`
   to the temp project explicitly (via `overrides`).
7. A driver wrapper that renames its factory does not rename the sessions: the run report and the recordings directory use
   `session.driverId`, so a delegating third-party driver keeps the inner `driverId` unless it wraps its sessions too.
6. Checkgen fake rules emit the contract shape (`{classification, predicates}` with optional keys omitted); S-ASSERT accepts it.
