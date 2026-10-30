# Actual local CPU browser evidence

The focused browser test runs the normal built client and App/Auth/SQL backend on port8891, with real SHA-verified Qwen weights. It selects and saves the artifact's explicit Local CPU runtime, evaluates a native finite predicate, asks the model about the design's blue Start button, and checks its generated reply against the persisted record through desktop/mobile reload and a fresh login. The artifact's original ADR and discussion IDs remain attached, and the canonical document stays unchanged.

- `local-runtime-picker.png` shows the actual local chat and independent local decision configuration.
- `local-design-chat.png` shows the design and its generated artifact conversation.
- `local-design-chat-mobile.png` shows the same persisted reply at390×844.

All three final images were opened and reviewed after the final passing run. Controls, labels and response text match the tested state; no page errors, HTTP500s or unexpected external browser requests occurred. `browser-receipt.json` pins the source, client build, model, native decision helper and image hashes. This is local inference and browser evidence; hosted managed T3 has a separate deployment acceptance scope.

Reproduce with `STUDIO_LOCAL_TEST_MODEL_DIR=/absolute/verified/model-directory STUDIO_REQUIRE_LOCAL_MODEL_TEST=1 pnpm --filter @ai-bdd/studio exec playwright test --config playwright.local-cpu.config.ts` after building the client.
