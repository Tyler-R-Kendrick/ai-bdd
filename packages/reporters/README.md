# @ai-bdd/reporters

The four run reporters: `json`, `junit`, `markdown` and `cucumber-messages`.

```ts
const reporters = createReporters(['json', 'junit', 'markdown', 'cucumber-messages'], { outDir: '.ai-bdd' });
for await (const event of runtimeEvents) for (const reporter of reporters) reporter.onEvent(event);
for (const reporter of reporters) await reporter.finish(report);
```

| Reporter | File | Notes |
| --- | --- | --- |
| json | `.ai-bdd/report.json` | the full `RunReport`, validated by the contracts schema |
| junit | `.ai-bdd/junit.xml` | one testcase per scenario; a healed scenario gets an `ai-bdd/healed` property plus a `system-out` note; the failure message carries the error code |
| markdown | `.ai-bdd/summary.md` | status, cache and judge stats, the healed list, judge-only assertions, the lockfile summary, the cost line and per-failure detail |
| cucumber-messages | `.ai-bdd/messages.ndjson` | `testCaseStarted`/`testStepFinished`/`testCaseFinished` per scenario; healed maps to `PASSED` plus an `ai-bdd/healed` attachment; evidence is attached by reference with a relative `url` |

Evidence is never inlined: `evidenceIndex()` returns `{id, path, mediaType, sha256}` so a report can
link into `.ai-bdd/runs/<runId>/artifacts/` without copying pixels. Output is deterministic for the
same report, which is what the golden test checks.
