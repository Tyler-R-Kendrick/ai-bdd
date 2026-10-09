# Assertions and judge calibration

An assertion step passes only if **every configured layer passes**. Layers are chosen per
step with the `mode` directive (`auto` is the default).

| Mode | Layers that run | Pass condition |
| --- | --- | --- |
| `check` | `CheckProgram` (cached or generated) | every predicate is satisfied |
| `judge` | judge | verdict `pass` |
| `both` | check and judge | both pass |
| `auto` | both; if no discriminative check can be generated, judge-only with `judgeOnly: true` | as per the layers that ran |

Bound assertion steps (exact or semantic binding of kind `assertion`) run the binding. The
judge is added on top only when a directive asks for `mode: judge` or `mode: both`, because
bound code is already deterministic.

## The discriminative rule

A generated `CheckProgram` is accepted only when it is **discriminative**:

- it evaluates `true` on the settled *after* observation, and
- it evaluates `false` on the settled *before* observation, and
- the judge independently passes on the same run.

A program that is true on both is rejected with `CHECK_NOT_DISCRIMINATIVE` and regenerated,
up to `assertions.checkGen.maxAttempts` (default 3). If no attempt succeeds the step runs
judge-only and is flagged `judgeOnly: true`; with `assertions.requireDeterministic: true` that
is a failure (`CHECK_GENERATION_FAILED`).

The exception is a criterion that asserts state **did not change** ("no error toast is
visible"). The generator classifies it as `invariant`, it is accepted when true on after, and
it is flagged `invariant: true` in the report.

Check programs may not embed volatile text. A generator-side linter rejects literals that
match the volatile patterns (dates, times, UUIDs, hex ids of 8+ characters, numbers of 5+
digits, durations) unless the literal comes from a step parameter. Parameter-derived values
are stored as `{param: name}` slots, not as literals.

## The judge

The judge receives **only**:

- the criterion text,
- before/after image references (omitted when the observation is tainted or `vision: off`),
- before/after tree text (truncated to `judge.maxTreeChars`),
- the app vocabulary from `config.context`,
- whether an action preceded the check.

It never sees the acting agent's reasoning, tool calls or action summaries. That is enforced
by the shape of `JudgeRequest` (a strict schema with no transcript-like field) and by a test
that injects canary tokens into the act transcript and asserts the judge prompt contains none
of them.

### Scoring

Each sample returns `{probability, verdict, explanation, observed}`.

- `p_i = probability` when the verdict agrees with it (`holds` with `probability ≥ 0.5`, or
  `fails` with `probability < 0.5`); otherwise the sample is contradictory and is replaced
  by `0.5`. `cannot_tell` maps to `0.5`.
- `score = mean(p_i)` over `samples` (default 3, temperature > 0 or distinct seeds).
- `pass` when `score ≥ passThreshold` (default `0.8`), `fail` when
  `score ≤ failThreshold` (default `0.3`), otherwise `inconclusive`
  (`JUDGE_INCONCLUSIVE`, which fails the step).
- If the sample spread (`max − min`) exceeds `maxSpread` (default `0.5`), the verdict is also
  `inconclusive`.

### Cost and reuse

Judge calls run every time by design: they are evidence. Verdict reuse is allowed only when
the judge input is byte-identical (`sha256(criterion + beforeSha + afterSha + treeShas + model + prompt version)`),
which happens when a scenario is re-run without any UI change. Act replays and deterministic
checks make no model calls at all, and the markdown report prints the model calls, tokens and
estimated cost per run.

## Calibration

LLM scores are not calibrated: "0.8" may not mean anything for your app. Every judgment is
appended to `.ai-bdd/calibration/judgments.jsonl`. Label a sample and let ai-bdd tell you
where to set the thresholds:

```bash
ai-bdd calibrate --labels labels.jsonl
```

```jsonl
{ "judgmentId": "…", "truth": true }
{ "judgmentId": "…", "truth": false }
```

The command computes the expected calibration error over 10 bins, the Brier score, and
recommended `passThreshold` / `failThreshold` per driver and model. Thresholds are also
configurable per driver and per step (directive).

## Before/after windows

For an assertion step `S`:

- **before** is the settled observation captured immediately before the first action step of
  the most recent contiguous run of action steps preceding `S` (setup and bound non-UI steps
  are skipped);
- if no action precedes `S`, before is the first observation of the scenario and the judge
  prompt states "no action preceded this check";
- **after** is a fresh settled observation captured when `S` starts.

With `evidence.requireSettled: true` (default) an unsettled after-screenshot fails with
`SCREEN_NOT_SETTLED` instead of being judged. Settle detection is described in
[Caching and invalidation](caching.md#settle-detection).
