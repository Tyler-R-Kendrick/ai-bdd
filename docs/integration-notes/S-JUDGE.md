# S-JUDGE integration notes

## judge

Public API (re-exported by `@ai-bdd/sdk`): `createJudge`, `toJudgeEvidence`, `JUDGE_PROMPT_VERSION` (`judge-v1`).
The module also exports `JUDGE_SYSTEM_PROMPT`, `aggregateJudgeSamples` and `samplePassProbability` for tests and tooling (not in the sdk root index).

- `toJudgeEvidence(obs, { vision, maxTreeChars, maskingProven, redactor })`: tree rendered with `renderTree(refs:false)`, redacted, then truncated (so a cut cannot leave a partial secret; truncated text ends with `...[truncated]` and never exceeds `maxTreeChars`). The screenshot is included only if `vision` and present and (`!tainted` or `masked && maskingProven`) (R-JU3). The runner MUST call it for both before/after and pass `caps.maskingProven`.
- `createJudge({ model, config, cacheDir, evidence? }).judge(req, signal?)`: the prompt is built only from `JudgeRequest` (R-JU1); it does not redact, so callers must build evidence via `toJudgeEvidence`. `criterion`, `params` and `appContext` are sent as given (they contain `<secret:name>` tokens only). Observation text cannot close its own `<untrusted_observation>` delimiter (neutralised).
- Samples run in parallel (started synchronously in index order), `temperature 0.7`, `seed = sample index`, `output.name = 'judgment'`. Invalid JSON or schema -> `MODEL_OUTPUT_INVALID`. Model errors propagate unchanged.
- `JudgeVerdict.usage` sums all samples; a cache hit reports zero usage and `cached: true`.
- Cache: `cacheDir/judge/<key>.json` stores the raw samples (+ model id, prompt version), not the verdict, so thresholds/maxSpread are re-applied on reuse. An entry whose sample count differs from `config.judge.samples` is a miss. Corrupt entries are ignored and rewritten. Decision: `inconclusive` verdicts are not cached (a retry may resolve them); pass/fail are.
- `cacheDir/judgments.jsonl` gets one line per judgment, fresh and cached (`cached` flag), with key, criterion, params, evidence hashes, samples, verdict, usage. `cacheDir: null` disables both.
- With `deps.evidence`, each sample stores a `judge-request` (images as hash only, never bytes) and `judge-response` artifact (evidence store redacts text). Cache hits store nothing.
- `JUDGE_SAME_AS_ACTOR` is not emitted here (engine does).

VERIFY outcomes: none.
No contract changes or dependencies requested.
