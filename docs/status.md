# Status

Honest snapshot of what exists in this repository, what is synthetic, and what is deferred.
`docs/verification-log.md` records every VERIFY outcome; this page records scope.

Last updated by the implementation run on 2026-10-09.

## Test evidence (this commit)

```
npx tsc -b tsconfig.build.json      # all 17 packages build with declarations
npx vitest run                      # 26 test files, 435 tests, all green
node scripts/check-requirements.mjs # 37/37 R-K requirements covered
node scripts/check-schema-drift.mjs # schemas and docs/errors.md in sync
node scripts/check-docs.mjs         # 20 doc files, links and code fences valid
node scripts/check-e2e-imports.mjs  # no non-public e2e import
```

The end-to-end acceptance matrix lives in `packages/runtime/test/integration/matrix.test.ts`
and runs the shared spec corpus with the fake driver and the deterministic fake model:

| Case | What it proves |
| --- | --- |
| M1 (first run) | exact setup binding, agent act recording, check generation, judge verdicts |
| M1 (second run) | act programs replay, checks are reused, zero `checkgen` model calls |
| M2 | a synonym sentence resolves semantically and writes a lock entry |
| M3 | the negation trap never binds to the seed binding (guards plus counter-example) |
| M10 | a spinner that outlasts the budget fails with `SCREEN_NOT_SETTLED` |
| M12 | `--frozen` with an unlocked resolution reports `RESOLUTION_NOT_LOCKED` and exits 4 |
| M14 | `verify-evidence` passes clean and names the record after a byte is flipped |
| M17 | judge prompts contain no act-tool output (canary discipline) |
| R-K21 | an unbound setup step never falls back to the UI agent |
| R-K18 | the same sentence resolves identically in `.spec.md` and `.feature` |

## Implemented

| Area | Package | Notes |
| --- | --- | --- |
| Contracts | `@ai-bdd/contracts` | Section 10 types, zod schemas, 37 generated JSON Schemas, generated `docs/errors.md`, RFC 8785 canonical JSON, Gauge template matcher, binding/act/check/judge/lock key derivation, the single daemon tool table. |
| Spec parsing | `@ai-bdd/spec-gauge`, `@ai-bdd/spec-gherkin`, `@ai-bdd/spec-directives` | Gauge markdown (headings, tables, contexts, teardown, concepts, data-driven specs, printer), Gherkin via `@cucumber/gherkin` (pickles, Background, outlines, DataTable, DocString), directive grammar, kind inference, lint rules. |
| Resolution | `@ai-bdd/registry`, `@ai-bdd/semantic`, `@ai-bdd/lock` | Exact matching (Cucumber Expressions, regex, Gauge templates), semantic matching with threshold/margin/guards/parameter validation, the resolution chain with incremental revalidation and the committed lockfile. |
| Caching | `@ai-bdd/cache` | act/check stores, read-write/read-only/off, atomic writes, six invalidation strategies. |
| Execution | `@ai-bdd/act`, `@ai-bdd/assert`, `@ai-bdd/judge` | ActProgram record/replay/heal with effect verification, CheckProgram generation with the discriminative rule and the volatile-literal linter, the scored judge with the inconclusive band, sample spread, reuse cache and the calibration journal. |
| Evidence | `@ai-bdd/evidence` | Content-addressed artifacts, hash-chained manifest, ed25519 signing, `verifyEvidence`, settle detection, secret redaction (raw/URL/base64). |
| Models | `@ai-bdd/models` | Deterministic fake chat model / embedder / grounding scorer driven by `fixtures/fake-model/rules.json`, plus the AI SDK adapter. |
| Drivers | `@ai-bdd/driver-fake`, `@ai-bdd/driver-e2e` | In-memory fixture driver with fault injection and deterministic PNGs; the `e2e mcp` driver with a recorded transcript fixture and catalog-derived capabilities. |
| Orchestration | `@ai-bdd/runtime` | Config loading and validation, glob discovery, scheduler with per-driver session caps, the step pipeline, before/after windows, teardown semantics, trace ids, lockfile save, evidence finalization, four reporters, exit codes. |
| Fixtures | `fixtures/app`, `fixtures/specs`, `fixtures/fake-model`, `fixtures/bindings` | Dependency-free fixture web app plus its generated driver model, the shared spec corpus with the M1-M18 expectations, fake-model rules, and the setup bindings (including the deliberate ambiguity twin). |
| Conformance | `@ai-bdd/conformance` | Driver conformance suite, the plugin kit (20 feature files, `script.json`, expected results) and the daemon protocol suite. |

## Not yet implemented

The parallel work packages for these areas did not land. The contracts, docs, fixtures and
acceptance criteria for each are in place, so they are the natural next steps.

| Area | State |
| --- | --- |
| `@ai-bdd/daemon` (WP-G2) | Not implemented. The tool table, schemas, auth rules, traceparent propagation and `--fake` script format are specified and partly tested through `@ai-bdd/conformance`; the MCP and HTTP surfaces themselves are missing. |
| `@ai-bdd/cli` / `@ai-bdd/core` (WP-G3) | Not implemented. Every command in section 9.2 has its engine (`runtime.run`, `verifyEvidence`, `calibrate`, `loadConfig`) but there is no `ai-bdd` binary yet, so `AI_BDD_FAKE=1` has no entry point. |
| `@ai-bdd/driver-playwright` (WP-E1) | Not implemented. The driver contract, settle algorithm and conformance suite it would use are ready. |
| `@ai-bdd/driver-cua` (WP-E3) | Not implemented. Contract-tool fixtures were not captured because the Cua CLI cannot run in this sandbox. |
| `@ai-bdd/codegen` (WP-G5) | Not implemented. |
| `@ai-bdd/e2e-host` (WP-G6) | Not implemented; V1 showed `run()` is not a public export, so the V2 static-generation fallback is the design of record. |
| Language plugins (WP-H1-H6) | Not implemented. The plugin contract, the conformance kit and `docs/plugins.md` (with the verified coexist semantics per framework) are in place. |
| Adversarial suite (WP-K1) | Design and attack list documented in `docs/adversarial-findings.md`; the canary, tamper and redaction attacks are covered by unit tests in the corresponding packages, the rest are open. |

## Sandbox limitations

| Item | Status |
| --- | --- |
| Cua fixtures | Not captured; the Cua CLI is unavailable in the sandbox. |
| Live e2e driver run | `e2e mcp` 0.19.0 was spawned and its catalog snapshotted (`docs/evidence/e2e-mcp-0.19.0.tools.json`); no live target was driven. |
| Live model tests | No provider credentials in the sandbox; the AI SDK adapter is unverified against a real provider (V14). |
| Playwright integration | No browser download; the driver itself is unimplemented. |

## Known gaps in the test matrix

- M4-M9, M11, M13, M15, M16 and M18 are specified in `fixtures/specs/expected-matrix.json`; the
  subset listed above is implemented. The remaining cases need the deferred drivers and daemon,
  or additional fixture rules.
- The reporter outputs are exercised through the runtime integration test (JSON, markdown);
  golden files for JUnit and Cucumber Messages are not captured yet.
- `docs/verification-log.md` carries "pending" entries for the VERIFY items that belong to the
  deferred packages (V4, V5, V8, V9, V11, V12, V13, V14, V16, V18).
