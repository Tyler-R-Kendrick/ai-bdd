# Independent local CPU runtime review

The actual required Qwen source suites at `ed2ca9bb26a7c3db11a2f57b6188422be27cae85` passed **13/13 checks across two files in 27.64 seconds**, with zero skips. The required model flag was set. This independently reran real SDK generation, original JSON-schema format rejection, bounded queue isolation, tool-result history, streaming, cancellation, shared ownership, Node shutdown and a durable Agent reply/replay. These checks overlap the implementation workflow's groups and must not be added to them.

An additional independent process ran the actual generated standalone adapter and copied workers prepared at `11df998e94e8752b5c67553122605ab5f321c4df` inside the existing `node:24-bookworm-slim` OCI image. It used UID 1000, no network, a read-only root, a temporary `/tmp`, dropped capabilities, `no-new-privileges`, two CPUs and 2 GiB memory. Only the frozen generated files, installed public dependencies and public model weights were mounted read-only; no host authentication state was mounted. The exact [executed verification program](verify.mjs) and [receipt](receipt.json) retain the generated-file hashes and outputs.

| Actual operation | Result | Observed elapsed time |
| --- | --- | --- |
| Cold native CPU chat | `4` | 1,826 ms |
| Pact preview title and goal | Title identifies Pact integration preview; goal preserves required reviewer approval before document mutation | 1,039 ms |
| Real server-defined read-only tool loop | Tool executed exactly once; the final response used its returned `42` | 1,601 ms |
| Native probability computation | Finite normalized distribution with `calibrated:false`; semantic quality was **not accepted** | Recorded separately |
| Shutdown | `closeLocalModels()` completed and Node exited 0 | Passed |

The maximum recorded native RSS observation was **792,453,120 bytes**, below 1 GiB. This is a sample-based observation, not a claim about an unobserved allocation peak or production concurrency capacity.

The default Qwen artifact was independently matched to official Hugging Face metadata: repository `bartowski/Qwen2.5-0.5B-Instruct-GGUF`, revision `41ba88dbac95fed2528c92514c131d73eb5a174b`, file `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf`, **397,808,192 bytes**, SHA-256 `6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653`. Both the quantized repository and `Qwen/Qwen2.5-0.5B-Instruct` model card declared Apache-2.0. The downloader verifies the fixed revision, size and hash before use. The pinned native runtime is `node-llama-cpp@3.22.2` with CPU binaries; runtime model downloads and compilation are disabled.

The earlier source `a670287` accepted a raw JSON-schema email-format violation and exited Node 24 with an unsettled shutdown promise. Independent reproduction against `ed2ca9b` confirmed both corrections: the invalid email now rejects with a schema error, and shutdown exits 0 without a keepalive workaround. A six-request concurrent probe accepted four isolated exact receipts and rejected two as busy. The old 135M semantic probe omitted the requested human-approval condition; the Qwen result above retained it.

This was a **standalone bundled-adapter closure test**, not a build of the final Studio image. The Dockerfile and mandatory CI image smoke have separate source-specific acceptance. The old bundled decision helper returned a real but wrong synthetic blue predicate (`P(true)=0.4260`); its distribution is preserved honestly in the receipt and is not a classifier-quality pass. The newer decision-template implementation requires its own tests. No Gateway, paid inference, hosted model call, production model operation, restart/load acceptance or availability SLO is established here.
