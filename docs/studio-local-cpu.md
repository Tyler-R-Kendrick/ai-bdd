# Local CPU inference

Studio's local CPU harness uses downloaded open weights, runs inference in a local native subprocess and never falls back to AI Gateway or another hosted provider. The default model is **Qwen2.5-0.5B-Instruct Q4_K_M**, an Apache-2.0 model with 397,808,192 bytes of weights. `server/local/model-manifest.json` pins its Hugging Face repository revision and SHA-256. Its license and attribution ship with the release image.

This harness is separate from genuine T3. The `local-cpu` harness and `llama-cpp-cpu` provider labels describe the actual engine. Managed native T3 can use the same local model through its own supervised native adapter; selecting a local CPU model does not turn the AI SDK adapter into T3.

## Preparation and runtime

The release Dockerfile downloads the immutable model and verified native T3/OpenCode tools in a separate build stage. Changing application source alone does not invalidate those public-artifact download layers. The runtime contains the default Qwen weights at `/opt/studio-model`, native tools at `/opt/studio-native-tools`, and production dependencies including the pinned CPU binary. The node user can read the weights; inference does not install packages, compile native code or download models.

For an existing local installation:

```sh
pnpm --filter @ai-bdd/studio model:download /absolute/studio-model
STUDIO_LOCAL_MODEL_DIR=/absolute/studio-model pnpm --filter @ai-bdd/studio dev
```

Choose **Local CPU (offline)** in the artifact's agent runtime picker. `createLocalLanguageModel({directory, modelId?})` accepts only registered model IDs. The optional 135M SmolLM2 entry is a smaller explicit choice; preparing it requires its exact registered ID as the downloader's second argument. The default Docker build ships Qwen only. Artifact content cannot select a model URL, executable or directory.

A directory has one inference subprocess shared by chat and independent decision evaluation. Requests run one at a time, with at most three waiting. A different registered model unloads the previous weights before loading. The subprocess receives a small environment without provider credentials. It has no HTTP fetch transport, uses CPU only, never builds or downloads binaries, and exits when its parent disconnects. Abort/deadline kills the isolated subprocess; the next request starts a fresh one. A sampled 1 GiB subprocess RSS ceiling refuses over-budget work and recycles the child; it is a soft process guard, while the release container smoke uses a hard 2 GiB OS limit. Idle workers exit after 30 seconds. Services retain their directory pool and release it after their jobs drain; closing one application does not kill another owner's work.

Runtime and context thread counts use `Math.min(2, availableParallelism())`. A CPU quota by itself did not reproduce the one-available-CPU stall; the [actual affinity regression](studio-evidence/local-cpu/independent-review/single-affinity.md) restricted both quota and affinity. The old fixed-two-thread configuration reached prefill and timed out at the unchanged 45-second limit; the capped configuration completed the same input in 10.651 seconds. A genuine native App gate then passed ten local checks under one-CPU affinity. The mandatory image fixture verifies that affinity reaches the actual model subprocess. These bounded local execution results retain their observed semantic failures and do not establish hosted performance or general model accuracy.

The native context holds at most 4,096 tokens including source, framing and output. Generation is capped at 1,024 output tokens and 45 seconds by default, with a 60-second maximum. Overflow fails explicitly; neither the preliminary token check nor the native context may silently drop source. These bounds can reject large artifact proposals; they do not trigger a provider fallback.

## Structured output and tools

The engine compiles a native JSON grammar for structured output without tools. Advertised tools use the model wrapper’s native function declarations and call parser through low-level `LlamaChat`; no function handlers enter the subprocess. Tool names and arguments are validated against the **original** schemas with AJV and `ajv-formats`, including constraints absent from native decoding. When tools and structured output are combined, a reserved output-only function carries the final response schema and is never executed. Unknown formats and reserved-name collisions are rejected before inference. Valid syntax does not establish semantic correctness.

Tool calls can name only an advertised tool and must satisfy its original argument schema before AI SDK dispatch. SDK call IDs pair each historical call with exactly one matching result; duplicate, orphaned, mismatched and unknown calls are refused. The native wrapper renders those typed results as function results, rather than user messages. The server's tools retain their existing source, role, lease and repository guards. The model does not authorize operations or execute code in the inference subprocess. Tool results remain untrusted data. Native text streams incrementally; function responses are buffered until validated. The managed T3/OpenCode bridge preserves the SDK’s typed tools, choices and history, then carries validated calls as text back to Studio’s SDK loop. T3 and OpenCode effect tools remain disabled.

Independent decision classification uses the same process and immutable weights through `evaluateLocalDecisions`. Its native option likelihoods are **not calibrated probabilities of correctness**. Decision thresholds, abstention, source fencing and human approval remain enforced by the independent decision service. The earlier generic native NOUL/MCQ framing showed letter-order bias and is retained only in its historical receipts. The current [local decision adapter](studio-local-decisions.md) uses the resolved chat wrapper and direct label-token likelihoods; its [seven actual CPU/SQLite/PostgreSQL tests](../packages/studio/verification/evidence/local-decisions.json) cover balanced predicates, choices, ordinal bins, uncertainty and recovery. Complex coverage rubrics abstain at the default `.7`, and these probabilities remain uncalibrated.

## Evidence and limits

The three [saved comparison receipts](studio-evidence/local-cpu/) contain actual outputs from the same five synthetic prompts: design explanation, title/goal, accessible UI JSON, repository tool selection and a human approval rule. SmolLM2 135M and 360M each matched three cases, with different mistakes. Qwen matched all five. This small sample selected a practical default; it does not establish general accuracy.

Observed native-process peak RSS on that host was approximately 435 MiB for 135M, 626 MiB for 360M, and 773 MiB for Qwen at a 4,096-token context. Sample generation took 0.36–0.86 seconds for Qwen, after a 0.47-second load. These are local observations, not deployed performance claims.

`local-model.test.ts` runs actual chat, schema JSON, server tool execution, tool-result continuation/history, native decision transport, queue isolation, corrupt-file refusal, format validation, abort/recovery, owner retention and subprocess shutdown. `local-agent.test.ts` exercises actual artifact chat publication and duplicate delivery through SQL, with zero Gateway requests. Mandatory CI downloads/verifies the model and sets `STUDIO_REQUIRE_LOCAL_MODEL_TEST=1`; a missing model cannot be counted as a successful skipped inference check.

The release image smoke test additionally runs packaged AI SDK chat and JSON inference as the non-root user with a read-only filesystem, no network, two CPUs and 2 GiB of memory. That gate must pass on the built image; host inference and source presence do not substitute for it.
