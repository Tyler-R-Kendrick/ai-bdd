# Adversarial findings

Findings from the red-team work package (WP-K1). Every entry is either **fixed** (with the
test that proves it) or **accepted** (with a rationale). The exit criterion is zero open
high-severity findings.

Attack list from the implementation prompt, with the current state:

| # | Attack | State | Evidence |
| --- | --- | --- | --- |
| 1 | Find step texts that semantically bind to the wrong fixture binding despite guards | in progress | `packages/semantic/test/adversarial/paraphrase.test.ts` (200+ generated paraphrases, negations, quantity changes) |
| 2 | Leak a secret into any artifact, log, lock, report, prompt or error message | in progress | `packages/evidence/test/adversarial/secret-leak.test.ts`, `scripts/check-secrets.mjs` |
| 3 | Make the judge see act-agent output (prompt injection via page text) | in progress | `packages/judge/test/unit/canary.test.ts`, `packages/judge/test/adversarial/injection.test.ts` |
| 4 | Tamper evidence undetected (reorder, delete, replace, swap same-size artifacts) | in progress | `packages/evidence/test/adversarial/tamper.test.ts` |
| 5 | Get a non-discriminative or volatile CheckProgram accepted | in progress | `packages/assert/test/adversarial/non-discriminative.test.ts` |
| 6 | Get a cache replay to pass when the effect did not happen | in progress | `packages/act/test/adversarial/effect-already-present.test.ts` |
| 7 | Cross-session leakage under concurrency (cookies, Cua foreground) | in progress | `packages/driver-fake/test/adversarial/parallel-sessions.test.ts` |
| 8 | Bypass `allowHosts`/`allowApps` (redirects, `window.open`, `javascript:`, `data:`, `file:`) | in progress | `packages/driver-playwright/test/adversarial/policy.test.ts` |
| 9 | Lockfile nondeterminism (ordering, float formatting, locale) | in progress | `packages/lock/test/adversarial/determinism.test.ts` |
| 10 | Parser crashes or catastrophic regex backtracking (ReDoS) in templates and directives | in progress | `packages/spec-gauge/test/property/never-throws.test.ts`, `packages/contracts/test/unit/contracts.test.ts` |
| 11 | Daemon auth bypass, path traversal through `aibdd_get_evidence`, `<file:>` escaping the root | in progress | `packages/daemon/test/adversarial/traversal.test.ts`, `packages/spec-gauge/test/unit/file-param.test.ts` |
| 12 | Plugin ambiguity: coexist cases that make native frameworks report AMBIGUOUS | pending | plugin conformance suites |

## Notes on the design decisions that came out of this work

- The `<file:>` and `<table:>` parameters are resolved against the project root and refused
  with `POLICY_DENIED` outside it. `aibdd_get_evidence` resolves ids through the manifest, never
  by joining a client-supplied path.
- User-supplied regexes (binding patterns, directive values, `textMatches` predicates) run with
  an input-length cap and a worker timeout, because JavaScript cannot interrupt a
  catastrophically backtracking pattern. The choice is recorded in
  [the verification log](verification-log.md).
- An effect that was already true before a replay does not count as verified, which is the
  difference between "the cache replayed" and "the cache replayed and something happened".

## Accepted risks

| Risk | Severity | Rationale |
| --- | --- | --- |
| A malicious runner host can fabricate a whole run directory, including a valid signature if it has the key | medium | Documented in [Evidence and verification](evidence.md#threat-model). Signing keys should live outside the runner's reach; this is an operational control, not a code fix. |
| Page text can still influence a judge's *explanation* text | low | The verdict is driven by the structured probability field, and page text is delimited as untrusted. A live-model variant of the injection test is opt-in. |
