# Optional Granite chat candidate

`granite-4.0-350m-q5-k-m` is an explicit operator-selected chat/native-function candidate. Adding it does not change the Qwen2.5 default, existing model fingerprints, or managed T3 as the default harness. It has not passed the saved-repository automatic-tool qualification. Native decision probabilities are disabled in both the decision catalog and the direct evaluator until separately qualified.

The Apache-2.0 artifact is pinned to the official IBM GGUF repository, immutable revision, byte count and SHA-256 in `model-manifest.json`. The existing controlled `model:download` script can prepare that exact model only when an operator explicitly selects its ID. Inference does not download assets or use a hosted fallback. The worker verifies all bytes before loading.

The pure rendering fixture in `tests/fixtures/granite4-reference-tokenizer-metadata.json` is the official instruct-model reference template at its own immutable revision. It proves installed AUTO wrapper support for that reference, without loading weights or a native context. It does not prove that the GGUF embeds the same template or that the model chooses or uses tools correctly. An actual qualification must first verify the full GGUF hash and its embedded template, then use the library's AUTO wrapper without replacing the template.

The existing runtime bounds remain: CPU-only, 4096 context tokens, up to 1024 output tokens, a default 45-second CPU request deadline, and a 1 GiB process RSS ceiling. Managed T3/OpenCode effect tools stay disabled; only the outer authorized AI SDK tool loop may execute validated Studio tools.

The bundled Apache-2.0 text is in `MODEL-LICENSE.txt`. Public reference template source: `https://huggingface.co/ibm-granite/granite-4.0-350m/blob/bd8a1497065c0d6ba1ef19af6b0d2b14bacf71c2/chat_template.jinja`.
