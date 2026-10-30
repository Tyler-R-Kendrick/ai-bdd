# Actual local CPU browser evidence

The focused browser test runs the normal built client and App/Auth/SQL backend on port8891, with real SHA-verified Qwen weights. It selects and saves the artifact's explicit Local CPU runtime, evaluates a native finite predicate, and asks “What color and label does this design require for the button?” Strict assertions require both blue and Start in the generated reply, then compare that exact reply with the persisted record through desktop/mobile reload and a fresh login. The artifact's original ADR and discussion IDs remain attached, and the canonical document stays unchanged. This explicit-facts case passed twice; the final run took7.7seconds.

- `local-runtime-picker.png` shows the actual local chat and independent local decision configuration.
- `local-design-chat.png` shows the design and its generated artifact conversation.
- `local-design-chat-mobile.png` shows the same persisted reply at390×844.

All three final images were opened and reviewed after the final passing run. Controls, labels and response text match the tested state; no page errors, HTTP500s or unexpected external browser requests occurred. `browser-receipt.json` pins the source, client build, model, native decision helper and image hashes. This is local inference and browser evidence; hosted managed T3 has a separate deployment acceptance scope.

The earlier broad-summary request (“Based on this design, describe the button the developer should build in one sentence”) omitted blue in a rerun after the final-human-message role correction and failed its strict assertion. That rerun is not reported as passing. The successful explicit-facts question demonstrates this bounded source lookup; it does not establish complete summary fidelity or general model accuracy. `historical-43d6845/` preserves the earlier screenshots and receipt under their original source, before that role correction.

Reproduce with `STUDIO_LOCAL_TEST_MODEL_DIR=/absolute/verified/model-directory STUDIO_REQUIRE_LOCAL_MODEL_TEST=1 pnpm --filter @ai-bdd/studio exec playwright test --config playwright.local-cpu.config.ts` after building the client.
