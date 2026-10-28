# Run report fixtures

`report.v2.passed.json` and `report.v2.failed.json` are `report.json` files exactly as the reporter wrote them in real runs of the offline test project (the fake driver and fake models of `@ai-bdd/testing`, built by `tests/acceptance/helpers/project.ts`). They are not edited by hand.

- `passed`: `ai-bdd run --frozen --no-agent --reporter json,junit` over the scenarios that replay with no agent: five scenarios, mode `replay`, exit code 0, zero model calls (the verdict of its one subjective step came from the `.ai-bdd/cache/` that the characterizing run before it left; with a cold cache that step calls the judge, see docs/cli.md).
- `failed`: the same billing suite run against the Acme build with the `bug-upgrade-noop` flag: one failed check (`CHECK_FAILED`), one failed judge (`JUDGE_FAILED`), healed steps, discarded recordings, exit code 1.

Regenerate both (the run ids, timestamps, durations and evidence hashes change, nothing else is meant to):

```sh
UPDATE_REPORT_FIXTURES=1 pnpm exec vitest run --project acceptance tests/acceptance/m28-run-report-contract.test.ts
```

`fixtures.test.ts` validates both against `packages/sdk/schema/run-report.v2.schema.json`. The same acceptance test validates the report of every run it makes, including the ones that are not committed (exit 3).

`run.ts` and `golden/` are the hand-built report and the approved renderings used by `reporters.test.ts`.
