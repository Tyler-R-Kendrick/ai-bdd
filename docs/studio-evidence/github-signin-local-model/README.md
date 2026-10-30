# GitHub fixture and local-model browser review

These three reviewed captures come from the corrected browser lane with a controlled GitHub OAuth provider and actual downloaded Qwen inference. The final full browser matrix passed **72/72 with no skips**, including the required local-model workflow. Seven browser OAuth protocol checks passed separately; overlapping counts are not added into a release total.

- [Runtime and decision selection](local-runtime-picker.png) shows an explicitly saved **Local CPU (offline)** harness, the pinned Qwen provider/model, and the independent native decision provider/model with a `.7` threshold.
- [Desktop conversation](local-design-chat.png) shows the saved design requiring a blue **Start** button and the actual model response stating both facts.
- [Mobile conversation](local-design-chat-mobile.png) shows the same persisted answer after another controlled OAuth login. The document is outside this viewport.

The root reviewer opened all three files and checked these captions against them. The decision evaluation receipt was verified through the API and is not pictured. These images establish neither live GitHub authorization, native T3 execution, single-CPU affinity nor hosted deployment acceptance; those boundaries have separate checks. The original failed display-name assertion and the initially overbroad offline-request guard remain in private test logs, followed by the corrected focused checks and final complete pass. [Verification metadata](verification.json) retains capture and source-file hashes without internal deployment or database identifiers.
