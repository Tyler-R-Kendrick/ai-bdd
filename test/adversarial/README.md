# Adversarial tests (WP-K1)

The red-team suite for the attack list in section 15 of the specification. Each test either proves the
attack fails or records the finding in `docs/adversarial-findings.md`.

| File | Attacks |
| --- | --- |
| `semantic-bindings.test.ts` | 1: paraphrases, negations and quantity changes must never bind to a different binding |
| `secrets.test.ts` | 2: a secret value, its URL encoding and its base64 form never survive redaction, at any offset |
| `judge-isolation.test.ts` | 3: page text imitating an agent transcript cannot reach the judge or change a verdict |
| `replay-effects.test.ts` | 6: a replay whose effect was already true before the run does not count as verified |
| `policy.test.ts` | 8: `allowHosts`/`allowApps` bypass attempts (javascript:, data:, file:, userinfo, suffix hosts) |
| `lock-determinism.test.ts` | 9: the lockfile is byte-identical across runs and binding orderings |
| `parser-redos.test.ts` | 10: adversarial and long inputs stay fast and never throw |
| `daemon-surface.test.ts` | 11: auth, unknown fields and evidence traversal through the real HTTP mirror |
| `plugin-ambiguity.test.ts` | 12: the cucumber-js coexist catch-all leaves native steps to Cucumber |

Evidence tampering (attack 4) lives in `packages/evidence/test/unit`, non-discriminative checks
(attack 5) in `packages/assert/test/unit`, and cross-session leakage (attack 7) in the runtime matrix.
