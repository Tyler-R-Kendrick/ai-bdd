# FIX-A integration notes (extract)

## F-07: plan chunk excerpts still hold the raw secret (needs a change outside `extract/**`)

The extraction prompt is now redacted: `buildPrompt(input, redact)` in `packages/sdk/src/extract/prompt.ts` takes an optional
redact function, and `createExtractor` passes `(t) => deps.redactor.redact(t)` (the `Redactor` is already part of the
`CreateExtractor` deps, so no contract change). `HandleEntry` gained a `shown` field (redacted text); `text` stays raw for quote
validation, so quotes the model copies from the redacted prompt still validate and never contain the secret.

The plan file still stores the raw secret because of the chunk excerpt written by the planner:

* `packages/sdk/src/plan/planner.ts:525`: `excerpt: c.text.slice(0, EXCERPT_CHARS)`

Required fix (planner owner): redact the excerpt before storing it. `createPlanner(config)` has no redactor, so either
(a) add an optional `redact?: (text: string) => string` to the planner input / `Planner` call (smallest: the facade that already
owns the redactor passes it), or (b) redact the whole `DocPlan` JSON in the facade right before `PlanStore.save`
(`redactor.redactJson(plan)`; note that chunk `hash` values must stay computed on the raw text). Slice AFTER redacting so a
secret cut by `EXCERPT_CHARS` cannot survive as a prefix.

`tests/adversarial/a07-secret-leaks.test.ts` "a document that contains the secret value ..." reports `sentToModel: false`
now and stays red only on `inPlan` until the planner change lands.
