# S-REPORT integration notes

Public behavior (`packages/sdk/src/report/`, exported as `createReporters` via `src/index.ts`, already wired in baseline):

- `createReporters(names)` returns reporters in the requested order (duplicates collapsed). An unknown name throws `USAGE`.
- `render(report, { plans, outDir })` writes with `atomicWriteFile` (creating `outDir`) and returns `[{ path }]`:
  - `json` -> `outDir/report.json` (`stableJson` of the `RunReport`)
  - `junit` -> `outDir/junit.xml`
  - `markdown` -> `outDir/summary.md`
- Output is a pure function of `(report, plans)`: no clock, no randomness, stable ordering (suites in report order, docs sorted by `docUri`, plan order within a doc).
- The reporters never throw for scenario ids, docs or chunk ids that the supplied plans do not know. Unknown scenarios are listed under "Scenarios not found in the supplied plans"; docs present only in `report.coverage` are rendered without a matrix.
- Copying outputs to `.ai-bdd/report/` (latest) is the engine's job; call `render` twice with different `outDir`s.

Details the engine/CLI authors may rely on:

- JUnit failure `type` is the scenario error code, else the first failing step's error code, else a status default (`JUDGE_INCONCLUSIVE` for inconclusive, `FIXTURE_REQUIRED` for blocked, `INTERNAL` otherwise).
- The markdown "Failures" section prints a fenced fixture stub when a failing step's `error.details.stub` is a string (runner's `FIXTURE_REQUIRED` contract, spec 9.5 B).
- Traceability rows use `plans[].chunks[].excerpt` (truncated to 80 chars with an ellipsis) and `plans[].sections[].id`; a chunk is attributed to the section whose id (minus any `/part-N`) is the longest prefix of the chunk id, falling back to the owning feature's `sectionId`.
- The uncovered / not-testable lists come from `report.coverage` when the doc is present there, else from the plan.

No dependency requests, no contract proposals.
