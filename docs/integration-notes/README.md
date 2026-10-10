# Integration notes

Each swarm writes `<swarm-id>.md` here: public behavior of its module, dependency requests, VERIFY outcomes, and cross-module issues for X-INTEGRATOR.

## Resolutions (X-INTEGRATOR)

Every request, proposal and open question addressed to the integrator is resolved. Informational notes stay as written.

- Contract proposals (`contracts-proposals/`): S-RECORDING (`Recorder.toRecording` takes `opts.capabilities`) and FIX-C (`FuzzyReason` gains `secret-in-recording` and `unsettled-baseline`; `ReplayResult.beforeSettled?`) are applied to the contract and all consumers; the proposal files are removed.
- S-FACADE open question: a scenario's own `driver` directive wins over `--driver` (spec 9.2). Kept, documented in `docs/cli.md`.
- S-PLAN `@fuzzy` tag spelling: `@playwright/test` tags strip a leading `@` before adding their own (`packages/playwright-test/src/index.ts`).
- S-MARKDOWN optional `ErrorCode` for context budgets: not added; `DIRECTIVE_INVALID` is reused and documented in `docs/errors.md`.
- P-PWTEST artifact lookup (`engine.runDir`): not added; the scan of `config.runsDir` is sufficient and missing artifacts never fail a test.
- P-CLI end-to-end corpus tests: done by X-CORPUS (`tests/acceptance`, CLI spawn helpers).
- X-CORPUS finding 2 (`sessionFactory` confirm runs reuse the same page): fixed in `packages/playwright-test/src/index.ts`; later sessions of a scenario get a page in a fresh browser context. The M22 acceptance test no longer needs read-only recordings.
- X-DOCS notes: `packages/testing/.quickstart/` is ignored; `ai-bdd init` ignores `.ai-bdd/report/`; a recorded login replayed without its secret now fails with `SECRET_MISSING` (test M13); `check-docs` runs in `pnpm check`.
- FIX-A..FIX-E: applied; see `docs/adversarial-findings.md`.
