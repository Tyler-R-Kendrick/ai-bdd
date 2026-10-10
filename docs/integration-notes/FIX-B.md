# FIX-B integration notes

## F-09 symlinked output roots
* `packages/sdk/src/util/index.ts` exports `assertInsideRealRoot(target, root?)` (POLICY_DENIED when the deepest existing ancestor of `target` resolves outside `realpath(root)`).
  Without `root` the directory holding the last `.ai-bdd` path segment is the root; paths without such a segment are not checked.
* `atomicWriteFile(path, data, { root? })` calls it before `mkdir`. Plan store saves pass `root = planDir`, so symlinked sub-directories below the plan root are refused. Every other `atomicWriteFile` caller (recordings, reports, evidence, judge cache) gets the `.ai-bdd` inference.
* Outside my paths (one line, done at the coordinator's request): `packages/sdk/src/evidence/store.ts` calls `await assertInsideRealRoot(dir)` before creating the run directory. Owners of other writers that bypass `atomicWriteFile` (`appendFile` of events, `mkdir` in `engine/run.ts` for the report dir, judge cache `mkdir`) should call it too.
* Behaviour: a run with `.ai-bdd/runs` symlinked outside the project now REJECTS with POLICY_DENIED and writes nothing outside. The test `a11 ... .ai-bdd/runs is a symlink` awaits `h.run(...)` without handling the rejection, so it fails on the throw even though the outside directory stays empty. Fix on the test side: `await h.run(...).catch(() => undefined)`.

## F-07 planner excerpt redaction
* `createPlanner(config, redact?)` (plan/planner.ts) redacts chunk text before slicing the excerpt.
* Wiring outside my paths: `engine/modules.ts` (`createPlanner` type and default wrapper take the optional `redact`) and `engine/core.ts` passes `(text) => this.redactor().redact(text)`.

## F-12 markdown budgets (markdown/normalize.ts, chunker.ts)
Documents over 512 KiB are an error diagnostic (DOC_READ_FAILED) for that document only. Excess `[ ] * _ ~` (1000 per blank-line separated run, 40000 per document), `[` openers unclosed for more than 1500 characters and leading indentation beyond 120 columns are replaced one-for-one by private-use placeholder characters before parsing and mapped back in the tree, so chunk text and positions are unchanged; a warning diagnostic is emitted. Remaining superlinear micromark behaviours (autolink literals, e-mail addresses, 100k+ line paragraphs) are bounded only by the size cap (seconds at the cap).
