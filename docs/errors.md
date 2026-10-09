# Error codes

Generated from `ERROR_CODES` in `@ai-bdd/contracts` by `pnpm -F @ai-bdd/contracts gen:schemas`.
Do not edit by hand; a test asserts this document is in sync with the taxonomy.

| Code | Group | Retryable | Meaning |
| --- | --- | --- | --- |
| `ACT_BLOCKED` | act | no | The act agent reported that it is blocked. |
| `ACT_BUDGET_EXHAUSTED` | act | no | The act agent exhausted its action or model budget. |
| `ACT_TARGET_AMBIGUOUS` | act | no | Grounding produced more than one candidate target. |
| `CACHE_REPLAY_DIVERGED` | act | no | A cached act program was healed (--strict-cache). |
| `CHECK_FAILED` | assert | no | A deterministic check predicate was not satisfied. |
| `CHECK_GENERATION_FAILED` | assert | no | No discriminative check could be generated. |
| `CHECK_NOT_DISCRIMINATIVE` | assert | no | A generated check is true on both before and after. |
| `CONFIG_INVALID` | config | no | The configuration is invalid. |
| `CONFIG_TS_UNSUPPORTED` | config | no | This Node runtime cannot load a TypeScript config file. |
| `CONFIG_UNKNOWN_KEY` | config | no | The configuration contains an unknown key. |
| `DAEMON_UNAUTHORIZED` | daemon | no | Missing or invalid bearer token. |
| `DIRECTIVE_INVALID_VALUE` | parse | no | The directive uses an invalid value. |
| `DIRECTIVE_ORPHAN` | parse | no | The directive is not attached to a step, scenario, or spec. |
| `DIRECTIVE_UNKNOWN_KEY` | parse | no | The directive uses an unknown key. |
| `DRIVER_INCOMPATIBLE` | driver | no | The driver is missing a required tool or parameter. |
| `DRIVER_UNAVAILABLE` | driver | yes | The driver could not be started. |
| `EVIDENCE_TAMPERED` | evidence | no | Evidence verification found a mismatch. |
| `GAUGE_CONCEPT_CYCLE` | parse | no | Concept expansion is recursive. |
| `GAUGE_DUPLICATE_SCENARIO` | parse | no | Two scenarios in one spec share a name. |
| `GAUGE_MULTIPLE_SPEC_HEADINGS` | parse | no | The spec file has more than one spec heading. |
| `GAUGE_NO_SPEC_HEADING` | parse | no | The spec file has no spec heading. |
| `GAUGE_UNRESOLVED_PARAM` | parse | no | A dynamic step parameter could not be resolved. |
| `GHERKIN_PARSE` | parse | no | The Gherkin document could not be parsed. |
| `INTERNAL` | internal | no | An unexpected internal error occurred. |
| `INVALID_ARGUMENT` | daemon | no | The request failed schema validation. |
| `JUDGE_FAILED` | assert | no | The judge verdict was fail. |
| `JUDGE_INCONCLUSIVE` | assert | no | The judge verdict was inconclusive. |
| `MODEL_OUTPUT_INVALID` | model | no | The model returned output that failed validation. |
| `MODEL_UNAVAILABLE` | model | yes | The model provider is unreachable. |
| `NO_SESSION` | daemon | no | The session id is unknown or expired. |
| `PARAM_EXTRACTION_FAILED` | resolution | no | Parameter extraction failed validation. |
| `PIXEL_TAINTED` | driver | no | Pixels are withheld because the observation is tainted. |
| `POLICY_DENIED` | driver | no | Policy denied the action or navigation. |
| `RESOLUTION_NOT_LOCKED` | resolution | no | The step is not present in the lockfile (--frozen). |
| `RESOURCE_LOCKED` | driver | yes | An exclusive driver resource is held by another scenario. |
| `SCREEN_NOT_SETTLED` | assert | no | The screen did not settle before the deadline. |
| `SECRET_TOO_SHORT` | config | no | A secret value is shorter than 4 characters. |
| `SESSION_LIMIT` | driver | yes | The driver reached its session limit. |
| `SETUP_UNBOUND` | resolution | no | A setup step has no binding. |
| `STEP_AMBIGUOUS` | resolution | no | More than one binding matches the step. |
