# Status

Honest snapshot of what exists, what is verified in this sandbox, and what is still deferred.
`docs/verification-log.md` records every VERIFY outcome; this page records scope.

Last updated by the implementation run on 2026-10-09.

## Test evidence (this commit)

```
npx tsc -b tsconfig.build.json      # 20 packages build with declarations
npx vitest run                      # 45 test files, 571 tests, 1 skipped (needs a browser)
# language suites
cd plugins/python && . .venv/bin/activate && (cd behave && python -m pytest tests) && (cd pytest && python -m pytest tests)
PATH=/workspace/.toolchains/go/bin:$PATH go test ./...            # plugins/go
PATH=/workspace/.toolchains/jdk/bin:$PATH mvn test                # plugins/jvm
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 dotnet test AiBdd.Reqnroll.Tests  # plugins/dotnet
node scripts/check-requirements.mjs # 37/37 R-K requirements covered
node scripts/check-schema-drift.mjs # schemas and docs/errors.md in sync
node scripts/check-docs.mjs         # docs links and code fences valid
node scripts/check-e2e-imports.mjs  # no non-public e2e import
node scripts/check-licenses.mjs     # license allowlist clean
```

The acceptance matrix runs the shared corpus with the fake driver and the deterministic fake model
(`packages/runtime/test/integration/matrix.test.ts`):

| Case | What it proves |
| --- | --- |
| M1 first run | exact setup binding, agent act recording, check generation, judge verdicts |
| M1 second run | act programs replay, checks are reused, zero `checkgen` model calls |
| M2 | a synonym sentence resolves semantically and writes a lock entry |
| M3 | the negation trap never binds (guards plus counter-example) |
| M4 | two near-identical bindings give `STEP_AMBIGUOUS` with reason `margin` |
| M5 | two Submit buttons give `ACT_TARGET_AMBIGUOUS` under fault injection |
| M7 | an already-true criterion is rejected as a check and falls back to judge-only |
| M8 | a non-change criterion is accepted as invariant or judge-only |
| M9 | a score inside the band fails with `JUDGE_INCONCLUSIVE` |
| M10 | a spinner that outlasts the budget fails with `SCREEN_NOT_SETTLED` |
| M11 | the secret never appears in the report, the model log or `.ai-bdd/` |
| M12 | `--frozen` with an unlocked resolution exits 4 with `RESOLUTION_NOT_LOCKED` |
| M13 | an unrelated new binding revalidates the lock instead of invalidating it |
| M14 | `verify-evidence` passes clean and names the record after a byte is flipped |
| M15 | six data-row instances, concept expansion, teardown last in every instance |
| M16 | the same sentence resolves identically in `.spec.md` and `.feature` |
| M17 | judge prompts contain no act-tool output |
| M18 | four seeded scenarios run concurrently without cross-session leakage |
| R-K18 | cross-dialect identity |
| R-K21 | an unbound setup step never falls back to the UI agent |

## Implemented and tested

| Area | Package | Notes |
| --- | --- | --- |
| Contracts | `@ai-bdd/contracts` | Section 10 types, zod schemas, 37 generated JSON Schemas, generated `docs/errors.md`, RFC 8785 canonical JSON, Gauge template matching, binding/act/check/judge/lock keys, the single daemon tool table. |
| Spec parsing | `@ai-bdd/spec-gauge`, `@ai-bdd/spec-gherkin`, `@ai-bdd/spec-directives` | Gauge markdown (headings, tables, contexts, teardown, concepts, data-driven specs, canonical printer), Gherkin via `@cucumber/gherkin` (pickles, Background, outlines, DataTable, DocString, tags), the directive grammar, kind inference, lint rules. |
| Resolution | `@ai-bdd/registry`, `@ai-bdd/semantic`, `@ai-bdd/lock` | Exact matching (Cucumber Expressions, regex, Gauge templates), semantic matching with threshold/margin/guards/parameter validation and R-K5c kind compatibility, the resolution chain with incremental revalidation and the committed lockfile. |
| Caching | `@ai-bdd/cache` | act/check stores, read-write/read-only/off, atomic writes, the six invalidation strategies. |
| Execution | `@ai-bdd/act`, `@ai-bdd/assert`, `@ai-bdd/judge` | ActProgram record/replay/heal with effect verification, CheckProgram generation with the discriminative rule and the volatile-literal linter, the scored judge with the inconclusive band, spread rule, reuse cache and calibration journal. |
| Evidence | `@ai-bdd/evidence` | Content-addressed artifacts, hash-chained manifest, ed25519 signing, `verifyEvidence`, settle detection, secret redaction (raw/URL/base64). |
| Models | `@ai-bdd/models` | Deterministic fake chat model, embedder and grounding scorer driven by `fixtures/fake-model/rules.json`, plus the AI SDK adapter. |
| Drivers | `@ai-bdd/driver-fake`, `@ai-bdd/driver-playwright`, `@ai-bdd/driver-e2e` | In-memory fixture driver with fault injection and deterministic PNGs; a real Playwright driver (ariaSnapshot trees, masking proof, allowHosts, network-aware settle); an `e2e mcp` driver with a recorded transcript fixture. |
| Orchestration | `@ai-bdd/runtime` | Config loading and validation, glob discovery, scheduler with per-driver session caps, the step pipeline, before/after windows, teardown semantics, trace ids, lockfile save, evidence finalization, exit codes; `resolveAll`, `SessionManager`. |
| Daemon | `@ai-bdd/daemon` | MCP (stdio and in-process) plus the HTTP JSON mirror over one tool table, bearer auth with `daemon.json` (0600), traceparent echo, plugin binding registration, session ledger and orphan reaping. |
| Reporting | `@ai-bdd/reporters` | JSON, JUnit, markdown and Cucumber Messages with evidence by reference and deterministic output. |
| Codegen | `@ai-bdd/codegen` | Two styles: `delegate` (the default, a one-line binding per step so the cached ActProgram stays the replayed driver code) and `inline` (recorded Playwright actions on the per-scenario page). Judge-only assertions keep calling the daemon; `--framework e2e` writes the file e2e's runner collects. |
| CLI / facade | `@ai-bdd/cli`, `@ai-bdd/core` | `ai-bdd init|run|resolve|lint|lock verify|codegen|verify-evidence|calibrate|doctor|serve|e2e-host generate`, `--fake`, documented exit codes; `defineConfig` and the binding API. |
| e2e host | `@ai-bdd/e2e-host` | `registerSpecs()` during module evaluation plus the static `generateRegistration()` fallback (V1/V2). |
| Plugins | `@ai-bdd/cucumber`, `ai-bdd-behave`, `ai-bdd-pytest`, `AiBdd.Reqnroll`, `ai-bdd-cucumber` (JVM), `godogbdd` (Go) | Six plugins, each passing the 20-feature conformance kit against `ai-bdd serve --fake-script`, with the framework-specific status spellings taken from the kit's `status-aliases.json` and the ai-bdd error code asserted in the failure message. |
| Adversarial | `test/adversarial` | 54 red-team tests over the section 15 attack list: mis-binding paraphrases (256 generated cases), secret leakage, judge isolation, replay effects, policy bypass, lockfile determinism, parser ReDoS, daemon traversal, plugin ambiguity. |
| Conformance | `@ai-bdd/conformance` | Driver conformance suite, the plugin kit (20 features, `script.json`, expected results) and the daemon protocol suite. |
| Fixtures | `fixtures/app`, `fixtures/specs`, `fixtures/fake-model`, `fixtures/bindings` | Dependency-free fixture app plus its generated driver model, the corpus with the M1-M18 expectations, fake-model rules and the setup bindings. |

## Still deferred

| Area | State |
| --- | --- |
| Live runs | Every plugin and driver is exercised against the scripted daemon and the fakes. Real model providers, a real browser, a real Cua desktop and `e2e mcp` against a live target need credentials/hardware this sandbox does not have; `docs/verification-log.md` records exactly which VERIFY items stayed unreproducible and what a live job must do. |
| Reporter and codegen goldens | Reporters and codegen are tested (JSON/JUnit/markdown/messages per report; deterministic codegen output) but the golden set covers the fixture corpus only. |
| `@ai-bdd/driver-cua` (WP-E3) | Not implemented. The Cua CLI cannot run in this sandbox, so its contract fixtures could not be captured; the driver contract, capability negotiation and `verify_state` semantics are specified in `docs/drivers.md`. |
| Live-model tests | No provider credentials here; the AI SDK adapter is unverified against a real provider (V14). |
| Playwright integration run | Chromium downloads but cannot start: the sandbox has no root and no package lists, so `libglib-2.0-0` is missing. The suite skips itself and the parser golden is marked `synthetic` until a browser-enabled job regenerates it (V8). |
| Adversarial suite (WP-K1) | Attack list and the current state of each attack are in `docs/adversarial-findings.md`; the canary, tamper, redaction, schema and policy attacks have tests, the rest are open. |

## Known gaps in the test matrix

- M6 (healed replay under a renamed button) is covered at the package level (`packages/act`, `packages/cache`) rather than end to end, because the fixture app has no UI-mutation hook yet.
- Reporter goldens cover JSON, JUnit, markdown and Cucumber Messages for one fixed report; a corpus-wide golden set is not captured.
- `ai-bdd serve --stdio` is exercised through the in-process MCP test, not through a spawned process.
