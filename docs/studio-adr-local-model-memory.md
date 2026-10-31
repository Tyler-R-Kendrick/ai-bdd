# ADR: Bound local model memory by registered identity

Status: accepted for the new resource-policy variant; Qwen3 authoring remains release-gated.

The optional pinned Qwen3 assessment exhausted its original 1 GiB worker RSS allowance during context allocation, before decoding or producing text. That result establishes an allocation failure, not an assessment of the model's edit quality. The original source, allocation and failed receipt remain separate evidence.

The trusted model registry now assigns that exact Qwen3 identity and file pin a 1,536 MiB worker ceiling. All older models, including default Qwen2.5 chat and native decisions, retain 1 GiB. The whole container remains limited to 2 GiB and one CPU; the Qwen3 allocation leaves 512 MiB for the application and native harness. No Vercel plan or memory setting changes. Context remains 4,096 tokens, output remains 1,024 tokens and the CPU request deadline remains 45 seconds.

A shared immutable policy binds model ID, file name, size, checksum and ceiling. Both the parent and actual worker enforce it. Browser, artifact, environment and arbitrary private request values cannot raise the registered ceiling; the private boundary can only lower it, down to 16 MiB for a guard test. Every model remains capped at 1,536 MiB. A live worker refuses identity or ceiling rebinding. The directory pool waits for an old model's worker to exit before starting another model, so resident Qwen3 allocations cannot carry into a default model's lower allowance and two workers never overlap in that pool.

Memory failures report a numeric sampled RSS and selected ceiling through private diagnostics, without prompts, output, paths or library error text. A sampled value is not a continuous peak measurement. Model weights, precision, wrappers, decision identities, native checkpoint encoding and inference defaults are unchanged; resource allocation does not change their fingerprints. A new source-and-budget case must be independently qualified before releasing Qwen3 editing. This policy and its controlled IPC tests do not establish successful weighted authoring.
