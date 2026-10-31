# Native function protocol evidence

The native T3 bridge carries typed tools, calls, and results through the Vercel AI SDK. The SDK owns bounded, authorized tool execution; native T3/OpenCode effect tools remain disabled. This change adds optional free local Granite selection and keeps the existing default model and independent Qwen decision configuration unchanged.

These are distinct checks, not a claim that all authoring workflows are qualified:

| Source | Actual case | Result |
| --- | --- | --- |
| `ce6ba1d` | Automatic repository read | Failed: the model supplied an absolute `/tmp/` path. The repository boundary rejected it before I/O. |
| `b929a8d` | Automatic repository read with the shared production path contract | Passed: actual repository tool read and answer grounded in its returned bytes; two SDK steps. |
| `155c250` | Two saved-document chat turns | Passed: both real replies retained blue and Start; the saved artifact/version, ADR, and thread remained linked and unchanged. |
| `155c250` | Structured code-edit proposal | Failed: the response supplied ADR-shaped content. Validation rejected it before publishing or applying a proposal; the first attempt was cancelled before retry. |
| `da15784` | Controlled SDK/Agent edit-contract regressions | Passed: the trusted artifact kind now supplies the output schema and the exact latest human edit request is quoted explicitly. This is controlled protocol evidence, not a new model-quality result. |
| `c8e6335` | Typed code-edit proposal | Failed: the model retained Start, overescaped HTML quotes, removed a saved trailing newline, and added an unintended file. The exact source assertions stopped before human application; canonical source remained unchanged. |
| Literal code-patch contract | Controlled SDK/Agent regressions | Passed: model-backed code edits reconstruct complete proposals from bounded literal operations over frozen source. A new weighted authoring qualification has not run for this contract. |
| `7064960` | Native admission for the literal-patch request | Failed before any CPU worker or model call: native OpenCode auto-compacted the bulk envelope and changed its framing. Exact request validation rejected it. A separate zero-model diagnostic verified the transformation. |
| Managed request-reference contract | Controlled SDK/MCP regressions | The managed transport now launches a short scoped reference and keeps complete typed SDK data server-side. This is controlled protocol evidence; weighted authoring on this transport has not been qualified. |

Model-backed code editing through T3, Vercel/fx, and local CPU now uses explicit replace/create/delete operations and an optional entry update. Exact replacements apply to all non-overlapping literal matches, preserve untouched bytes by construction, and reject missing text, conflicting operations, invalid paths, excessive output, and no-op results. The normal version/content proposal, independent Store validation, source/ACL fences, and human application remain in place. Attached RemotePlanner integrations retain their existing separately validated text/content wire contract.

Managed native requests use a domain-separated keyed reference bound to the artifact, profile, durable request key, and complete CPU-effective SDK data. Exact-one matching, native provider/mode guards, typed tool/result validation, input/resource limits, and native effect-tool denial remain in force. A separate transport namespace isolates older bulk-envelope checkpoints. External three-argument T3 integrations retain their existing wire format; decision fingerprints and defaults are unchanged.

Model-backed code edit schemas now enumerate only the selected saved artifact's filenames for replace/delete operations. Create paths advertise relative syntax, while independent schema and reconstruction checks still reject existing, reserved or traversing paths. Native decoding constrains existing-file enum choices; it does not enforce every string pattern or prove the requested edit's semantics. The source-bound contract uses the separate `model-output-code-patch-v2` durable step so older full-content and unbound patch receipts are not reused. Source-aware path constraints and minimal-change instructions have controlled SDK/API coverage; they are not a new weighted authoring result.

The weighted cases retain a true single-CPU affinity, 4,096-token context, 1,024-token output, 45-second CPU-request deadline, 1 GiB worker RSS guard, 2 GiB whole-container limit, and 120-second case bound. Saved-source chat used exactly two actual Granite calls and zero decision calls; it completed in 47.05 seconds. Its largest observed worker diagnostic RSS was 654,938,112 bytes. Diagnostic RSS is sampled rather than a continuous peak measurement.

## Actual saved-source conversation

![Actual saved document with both persisted blue/Start replies](native-t3-granite-retained-blue-start-chat.png)

This screenshot restores the actual closed SQLite database and both owned object files from the completed `155c250` case. It shows both generated replies beside the original document. The separate normal Studio UI capture performed zero model calls, made no API writes, and checked that the saved source, version, ADR, threads, messages, jobs, decision-call rows, native-state rows, and owned objects remained unchanged.

Authentication for this model fixture used an owned in-process code/PKCE issuer through the real Auth routes, followed by a fresh session bound to the same persisted GitHub principal. This is not evidence of upstream GitHub/Connect HTTP or production browser login.

## Explicit agent profile and separate decision profile

![Explicit T3/Granite fixture profile and independent Qwen decision selection](native-t3-granite-explicit-runtime-picker.png)

![Independent Qwen decision-model picker](native-t3-independent-qwen-decision-picker.png)

The fixture explicitly selects T3 Code and `studio-local/granite-4.0-350m-q5-k-m`. Qwen remains selected for independent decisions; Granite is excluded from decision-model options. Neither the weighted source-chat case nor this capture executed a decision model. Production defaults were not changed.

All three screenshots are unaltered 1,680 × 1,100 Chromium captures, visually reviewed against their captions. The capture reused an existing verified client built at prior auth commit `bbef421`; it did not rebuild the client. Capture occurred while the main checkout was at `a587709`. The tracked client/shared/build/lock inputs are byte-identical across `bbef421`, `a587709`, and the qualified `155c250` source. The later edit-contract fix is a separate commit.

| PNG | SHA-256 |
| --- | --- |
| `native-t3-granite-retained-blue-start-chat.png` | `ba3845576b7767ff0fe8551912cdeb586dc6f37521f42d0014240d5be5e8c11e` |
| `native-t3-granite-explicit-runtime-picker.png` | `97fac9f726a62bb846b00419820cc6b7546e1be6207ed757e6ec5d6fb01780f7` |
| `native-t3-independent-qwen-decision-picker.png` | `f15a03cdd58d0bac2756b6e1a8aa6007e3802f3269d9aadbf50ead1902cd100a` |

The public evidence deliberately excludes SQLite files, session cookies, state keys, capsules, and raw private model-transport receipts.
