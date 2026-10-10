# FIX-C contract proposals

Add two `FuzzyReason` values (currently the closest existing reasons are used):

- `secret-in-recording`: a selector, URL, key or route of the step held a secret (variant) and was redacted, so the step
  cannot replay deterministically. Currently reported as `coordinate-action`.
- `unsettled-baseline`: the screen before the action never settled, so the effect/check cannot be shown to be caused by
  the action. Currently reported as `check-not-discriminative`.

Also: `ReplayResult.beforeSettled?: boolean` (see docs/integration-notes/FIX-C.md).
