# Contracts proposals

`packages/contracts` is normative and is the only package every other package codes against,
so it changes through proposals rather than sideways edits.

## Process

1. Write `contracts-proposals/<your-work-package>.md` describing:
   - the type, field or helper you need,
   - why the current contract cannot express it,
   - the exact proposed TypeScript,
   - every consumer that would change, and the migration (usually an adapter that keeps the old
     shape working).
2. Code against the **current** contract meanwhile, with an adapter under your own package.
3. A proposal is accepted by updating `packages/contracts/src/**`, regenerating the schemas
   (`pnpm -F @ai-bdd/contracts gen:schemas`) and updating every consumer in the same change.
   Rejections are recorded in the same file with the reason, so the next reader does not
   re-litigate them.

## Resolved proposals

| Proposal | Outcome | Date |
| --- | --- | --- |
| `error-payload-retryable.md` | Rejected: `AiBddErrorPayload.retryable` is required by the error model of section 9.3. `ActOutcome.error`/`AssertOutcome.error` were widened with an optional `retryable` instead, and the runtime normalises it to `false` before it reaches a `StepResult`. | 2026-10-09 |
| `check-outcome-generated.md` | Accepted: `AssertOutcome.check` gained `generated` and `attempts`, because the report must distinguish a cached check from a freshly generated one (R-K9, section 8.3). | 2026-10-09 |
| `calibration-journal.md` | Accepted (in-package): the calibration journal is a judge-package interface, not a shared contract, so it did not need a contracts change. | 2026-10-09 |
