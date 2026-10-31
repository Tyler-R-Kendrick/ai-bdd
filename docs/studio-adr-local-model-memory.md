# ADR: Bound local model memory by registered identity

Status: accepted resource policy; artifact-edit eligibility is assessed separately for each model.

Scope: this record describes the earlier 2 GiB profile. The later [Pro capacity decision](studio-adr-pro-model-capacity.md) supersedes only Coder's allocation and the host target; it does not change these historical limits or results.

The optional pinned Qwen3 assessment exhausted its original 1 GiB worker RSS allowance during context allocation, before decoding or producing text. That result establishes an allocation failure, not an assessment of the model's edit quality. The original source, allocation and failed receipt remain separate evidence.

The trusted model registry assigns that exact Qwen3 identity and file pin a 1,536 MiB worker ceiling. The separately registered code-specific Qwen2.5-Coder-1.5B subject uses the same ceiling and still needs actual qualification within it. The original smaller models, including default Qwen2.5 chat and native decisions, retain 1 GiB. The whole container remains limited to 2 GiB and one CPU; the larger worker budget leaves 512 MiB for the application and native harness. No Vercel plan or memory setting changes. Context remains 4,096 tokens, output remains 1,024 tokens and the CPU request deadline remains 45 seconds.

A shared immutable policy binds model ID, file name, size, checksum and ceiling. Both the parent and actual worker enforce it. Browser, artifact, environment and arbitrary private request values cannot raise the registered ceiling; the private boundary can only lower it, down to 16 MiB for a guard test. Every model remains capped at 1,536 MiB. A live worker refuses identity or ceiling rebinding. The directory pool waits for an old model's worker to exit before starting another model, so resident Qwen3 allocations cannot carry into a default model's lower allowance and two workers never overlap in that pool.

Memory failures report a numeric sampled RSS and selected ceiling through private diagnostics, without prompts, output, paths or library error text. A sampled value is not a continuous peak measurement. Resource allocation does not change weights, precision, wrappers, decision identities, native checkpoint encoding or inference fingerprints. Subsequent Qwen3 runs completed allocation but failed edit semantics; its artifact-edit capability is disabled. The code-specific subject remains release-gated on a separate actual case. This policy and its controlled IPC tests do not establish successful weighted authoring.
