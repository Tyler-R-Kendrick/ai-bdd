# X-CORPUS integration notes

## corpus and acceptance harness

Owned paths: `packages/testing/corpus/**`, `tests/acceptance/**`, `tests/live/**`.

### Layout

- `packages/testing/corpus/docs/*.md` (billing, todos, checkout, login, reports, release-notes) and `ai-bdd.config.mjs`.
  The config registers `acmeFixtures`, secret `adminPassword -> ACME_ADMIN_PASSWORD`, an app `context` string and reads an optional
  `.corpus-options.json` next to it (written by the harness so spawned CLI processes can be tuned). It registers no drivers or
  models: tests pass them to `createEngine`, `AI_BDD_FAKE=1` injects them in the CLI. `baseURL` defaults to `http://localhost:4173`
  (fake driver) or `$ACME_URL`.
- `packages/testing/corpus/fake-model/*.json` is the complete base rule set (extract for every section, act scripts, checkgen
  programs, judge sample pairs). Point `AI_BDD_FAKE_RULES` at this directory for the README quickstart.
- `packages/testing/corpus/fake-model-variants/<name>/*.json` are overlays that tests layer IN FRONT of the base set (first match wins):
  `v2-heal`, `bug-heal-done`, `injection-navigate`, `canary`, `edit-upgrade-step`, `bad-extract-hallucination`,
  `bad-extract-injection`, `bad-extract-schema-repair`, `bad-checkgen-non-discriminative`, `bad-checkgen-retry`,
  `bad-checkgen-volatile-literal`, `bad-judge-contradictory`, `judge-band`, `judge-spread`.
- All rule files are generated: `node packages/testing/corpus/tools/gen-rules.mjs` (commit the output). Quotes are validated against
  the docs by `tests/acceptance/corpus-sanity.test.ts`, which needs no implementation.
- `tests/acceptance/helpers/*`: `project.ts` (temp project per test + rule layering), `engine.ts` (loadConfig + createEngine with the
  fake models and a virtual clock), `targets.ts` (fake driver or Chromium + `startAcmeApp`), `flows.ts` (the P-row flows and their
  expectations, shared by `mNN-*.test.ts` and `playwright.*.test.ts`), `cli.ts`, `scan.ts` (secret byte search), `timing.ts`.
- Temp projects are created under `tests/acceptance/.work/` (inside the repo, git-ignored by its own `.gitignore`) so
  `import '@ai-bdd/testing'` in the corpus config resolves through the workspace links. `AI_BDD_KEEP_WORK=1` keeps them.

### Corpus design decisions worth knowing

- Handle numbering: `billing.md` has four context chunks (Overview/Glossary headings and paragraphs) so section handles start at `c5`;
  every other doc has none (`c1`). Both `context` headings carry a directive before AND after the heading so numbering does not depend
  on whether a heading inherits a directive that follows it (the spec is silent). The sanity test checks both interpretations.
- The Downgrading scenarios contain a step "the customer opens the billing page from the navigation" (inferred). Fixtures seed
  server state; a server-rendered page only shows it after a reload, so the step is what makes the scenarios pass under Chromium.
  On the fake driver this step is honestly fuzzy (`no-observable-effect`).
- Judge rules key on evidence in `afterTreeText` (a pass sample set when the evidence is present, a fail sample set otherwise), so app
  regressions (`bug-upgrade-noop`) fail the judge instead of passing silently.
- `AI_BDD_FAKE_LOG`/`logPath` JSONL is only enabled where a test scans it (secrets, CLI).

### Matrix coverage (fake driver; P rows also under real Chromium with identical statuses)

M1 `m01`, M2 `m02`, M3 `m03`, M4 `m04` (+ schema repair, R-EX3 injection obeyed), M5/M6 `m05-m06` (+ `playwright.m05-m07`),
M7 `m07`, M8 `m08`, M9 `m09` (+ `playwright.m09-m11`), M10 `m10`, M11 `m11` (+ `--audit` disagreement), M12 `m12`,
M13 `m13` (+ taint probe, CLI secret scan, unmasked-driver screenshot gate), M14 `m14`, M15 `m15` (+ exit-code matrix),
M16 `m16`, M17 `m17`, M18 `m18`, M19 `m19`, M20 `m20` (+ exclusiveResource, maxSessions), M21 `m21` (+ driver major change),
M22 `m22` (SDK contract with sessionFactory) and `playwright.m22-playwright-test` (spawns the P-PWTEST example), M23 `m23`,
M24 `m24`, M25 `m25`. P rows: `playwright.m05-m07`, `playwright.m09-m11`, `playwright.m12-m13-m16-m19`, `playwright.m20-parallel`,
`playwright.m22-playwright-test`. Extras: `extras-checks` (R-AS1/R-AS2), `extras-plan` (R-PL1, R-PL3, directives).
Playwright tests skip with a visible reason when no Chromium is found; `AI_BDD_REQUIRE_PW=1` makes that a failure.

### Live models

`tests/live/live-smoke.test.ts` is excluded from the `acceptance` project. Run:
`AI_BDD_LIVE=1 AI_GATEWAY_API_KEY=... pnpm exec vitest run -c tests/live/vitest.live.config.ts`
(`AI_BDD_LIVE_MODEL`, `AI_BDD_LIVE_JUDGE_MODEL` choose model ids). Without the variables it is skipped with the reason in its title.

### Findings for X-INTEGRATOR

1. M11 as written ("deterministic check fails, CHECK_FAILED") cannot happen with a scripted `act-confirm-upgrade` rule: under
   `bug-upgrade-noop` the replayed Confirm click yields `effect-unverified`, the step heals, and the heal turn sees a closed dialog.
   The `bug-heal-done` layer makes the fake agent report that step done; the step is `healed`, then the check fails with `CHECK_FAILED`.
2. Judge verdicts are reused for identical evidence across runs (`.ai-bdd/cache`). Tests that need a fresh model answer (audit
   disagreement) delete the cache dir; judge model-call counts in later runs are therefore upper bounds (M7, M21).
3. Under `sessionFactory` (P-PWTEST) the confirm run is handed the same page, which already holds the upgraded state, so a
   characterization run in read-write mode ends in `CHARACTERIZATION_UNSTABLE`. `playwright.m22` runs the Playwright side with
   `AI_BDD_RECORDINGS=read-only` to work around it; the CLI baseline runs read-write.
4. With `AI_BDD_FAKE=1`, `ai-bdd -c missing.config.mjs status` exits 0 (config silently replaced by defaults); without fake mode it
   exits 2. An explicit `-c` that does not exist arguably should fail in both.
5. Playwright Test workers create the engine with `cwd = process.cwd()`; the M22 config pins `planDir/recordingsDir/runsDir/cacheDir`
   to the temp project explicitly.
6. Checkgen fake rules emit the contract shape (`{classification, predicates}` with optional keys omitted); S-ASSERT accepts it.
