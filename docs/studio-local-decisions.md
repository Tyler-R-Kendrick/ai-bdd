# Local CPU decisions

Finite decisions default to the independently persisted `llama-cpp-cpu` profile and the pinned Qwen2.5 0.5B Q4_K_M model. `STUDIO_LOCAL_MODEL_DIR` is the same prepared, immutable model directory used by local generation. Both paths use one bounded child-process queue and model cache; a selected model swap unloads the preceding model. No hosted model is selected as a fallback.

The native library’s generic multiple-choice template showed letter-order bias on simple true/false examples. The decision adapter therefore uses the model’s resolved chat wrapper, an explicit system/user/assistant prefix, and actual native next-token probabilities. Predicates compare Yes/No label likelihoods. Choices compare finite labels inside a JSON answer prefix. Scores retain the expected ordinal rubric index and its full bin distribution. These are conditional option likelihoods, **not calibrated probabilities of correctness** or generated confidence ratings.

The full source, question, options, and chat framing must fit the exact 4096-token context. The service admits at most 12,000 UTF-8 bytes for source and questions, then the child performs the actual token check. Overflow returns `context-overflow`; it never silently truncates the document. The existing SQL admission budget, immutable profile/configuration hash, cancellation, access checks, lease fences, receipt integrity, and cached-read authorization apply to local inference.

`GET` and `PUT /api/artifacts/:id/decision/profile` expose the independent picker. Availability distinguishes installed weights from known but absent models. Receipts record the pinned runtime/weight fingerprint, token usage, sampled peak RSS, complete-input policy, and `calibrated:false`. The threshold is an abstention policy over conditional likelihoods. Human approval, source authorization, and formal validation remain deterministic.

The [recorded local acceptance](../packages/studio/verification/evidence/local-decisions.json) covers seven tests using the actual downloaded model, SQLite, and PostgreSQL17. Balanced factual and human-approval predicates, work-intent/color choices, and explicit low/high release-risk bins pass. More complex acceptance-coverage rubrics remain uncertain; the complete example can rank an intermediate bin above its intended highest bin. Both examples abstain at the default `.7` threshold and retain their distributions. This is a documented model-quality limit, not evidence of general semantic accuracy.

Run the required actual-model gate after preparing the pinned assets:

```sh
STUDIO_REQUIRE_LOCAL_MODEL_TEST=1 \
STUDIO_LOCAL_TEST_MODEL_DIR=/absolute/verified-model-directory \
STUDIO_TEST_POSTGRES_URL=<disposable-test-database> \
pnpm --dir packages/studio exec vitest run --config vitest.config.ts tests/local-decisions.test.ts
```

The model gate fails if its required asset-directory variable is missing. It makes no external inference request. The release container remains the hard memory boundary; native-operation and worker RSS checks are sampled guards.
