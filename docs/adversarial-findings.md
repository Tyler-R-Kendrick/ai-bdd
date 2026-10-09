# Adversarial findings

Findings from the red-team work package (WP-K1, section 15). Every entry is either **fixed** (with the
test that proves it) or **accepted** (with a rationale). The exit criterion is zero open high-severity
findings.

## Attack list

| # | Attack | State | Evidence |
| --- | --- | --- | --- |
| 1 | Step texts that bind to the wrong binding despite the guards | covered | `test/adversarial/semantic-bindings.test.ts`: 256 generated paraphrases, negations and quantity changes; zero wrong winners, and ambiguity instead of a guess |
| 2 | Secret into an artifact, log, lockfile, report or prompt | covered | `test/adversarial/secrets.test.ts` (200 property cases over raw/URL/base64 forms at random offsets, plus an evidence artifact sweep) and `scripts/check-secrets.mjs` |
| 3 | Judge sees act output, or page text injects an instruction | covered | `test/adversarial/judge-isolation.test.ts` plus `packages/judge/test/unit` canary and type-level tests |
| 4 | Evidence tampering (reorder, delete, replace, swap) | covered | `packages/evidence/test/unit`, `packages/runtime/test/integration` (M14) |
| 5 | Non-discriminative or volatile CheckProgram accepted | covered | `packages/assert/test/unit` (discriminative rule, linter, judge-only fallback) |
| 6 | Replay passes when the effect did not happen | covered | `test/adversarial/replay-effects.test.ts` (an element already present before the replay is not a verified effect) |
| 7 | Cross-session leakage under concurrency | covered | `packages/runtime/test/integration` (M18) and `packages/driver-fake` session isolation |
| 8 | `allowHosts`/`allowApps` bypass (redirects, `window.open`, `javascript:`, `data:`, `file:`) | covered | `test/adversarial/policy.test.ts`: 14 denied and 8 allowed URL classes, including userinfo and suffix-host tricks |
| 9 | Lockfile nondeterminism (ordering, float formatting, locale) | covered | `test/adversarial/lock-determinism.test.ts` (byte-identical across runs, no long floats) plus the lock package's own tests |
| 10 | Parser crashes or catastrophic backtracking (ReDoS) | covered | `test/adversarial/parser-redos.test.ts`: 100k-character inputs and adversarial templates stay under the time bound; the registry bounds match input to 4096 characters |
| 11 | Daemon auth bypass, `aibdd_get_evidence` traversal, `<file:>` escaping the root | covered | `test/adversarial/daemon-surface.test.ts` and the spec-gauge `<file:>` policy tests |
| 12 | Plugin ambiguity in coexist mode | covered | `test/adversarial/plugin-ambiguity.test.ts` plus the per-plugin coexist tests |

## Findings raised and fixed

| Finding | Severity | Fix |
| --- | --- | --- |
| **The cucumber-js coexist lookahead quoted native patterns literally**, so a Cucumber Expression pattern (`Seed a workspace {string} …`) excluded only that literal text and every sentence it matches still reached the catch-all — cucumber-js would report AMBIGUOUS for steps the project already implements. | high | `patternToRegexBody()` converts placeholders into regex bodies before the negative lookahead; covered by attack 12 and by the plugin's own tests. The JVM backend's lookahead uses the same idea. |
| **Kind compatibility ignored the `default` kind source** (R-K5c): a keyword-less Gauge step whose binding was `setup` was filtered out before matching, so it fell through to the agent. | high | `kindCompatible()` accepts any binding kind when `kindSource === 'default'` (unless the binding is `strictKind`); this is what makes M4's ambiguity and the corpus' setup steps behave. |
| **Slow-tree hashes included revision-scoped refs**, so settle detection never converged and every screen looked unstable. | high | Both the fake and the Playwright drivers hash role/name/testId only, ignoring refs. |
| **`aibdd_register_bindings` rejected `description: null`**, which a plugin sends when a step has no description. | medium | Both the Behave and pytest-bdd plugins omit absent optional fields instead of sending nulls. |
| **A JSON node was attached to two request bodies** (“The node already has a parent”) in the .NET client, so the second session could not open. | medium | `AiBddClient.Object` deep-clones node values. |
| **Session ledger filenames were not sanitised**, so a human-readable scenario id (`features/x.feature#name`) produced an invalid path. | medium | Ledger names are sanitised and truncated. |
| **A step definition could shadow Cucumber-JVM's arity rules**: a text-only catch-all cannot serve a step with a DataTable or DocString, so those steps failed with an arity error. | medium | The JVM backend registers one definition per `@AiBddStep` (arity-aware) and excludes those patterns from the catch-all. |
| **`fileExists`-style host checks could be bypassed by a suffix host** (`evil-localhost`) and by userinfo (`http://localhost@evil.test`). | medium | `isNavigationAllowed()` resolves the real host, normalises a trailing dot, rejects non-http(s) schemes and only allows exact or subdomain matches; covered by attack 8. |
| **Unbounded input to user-supplied patterns** was a theoretical ReDoS. | low | The registry bounds the matched text to 4096 characters (`MAX_MATCH_INPUT_LENGTH`) and the parser suite keeps 100k-character inputs fast. |

## Open findings

| Finding | Severity | State |
| --- | --- | --- |
| A full browser-agent run of the corpus does not yet settle reliably on this fixture app: it re-renders through a JS reload, and the settle window after that reload occasionally reports `settled: false` at the 5s default. The driver-level parity (same binding per step) and the real-input click test both pass; only the status-for-status comparison is gated behind `AI_BDD_PW_PARITY=1`. | medium | Open. The pixel diff now decodes and runs pixelmatch (it previously compared encoded bytes, which could never converge), the fixture app's transitions now mirror the model, and the dialog capture survives the reload. What remains is tuning the quiet window for a JS-reload fixture; a real application is the honest place to finish it, which is why the comparison is opt-in rather than weakened. |
| A JSON-registered (non-TypeScript) project cannot express model objects, so it must run with `AI_BDD_FAKE=1` or use a `.ts` config with `aiSdkModels()`. | low | Documented in `docs/config.md`; the CLI raises `CONFIG_INVALID` with that exact instruction. |

## Accepted risks

| Risk | Severity | Rationale |
| --- | --- | --- |
| A malicious runner host can fabricate a whole run directory, including a valid signature when it holds the key | medium | Documented in the evidence threat model. Signing keys belong outside the runner's reach; that is an operational control, not a code fix. |
| Page text can still shape a judge's *explanation* text | low | The verdict comes from the structured probability field, page text is delimited as untrusted, and the injection tests prove a poisoned observation cannot flip a verdict. |
| `scripts/check-licenses.mjs` reads the installed tree, so a package added after the audit is not covered until the next run | low | CI runs it on every change. |
