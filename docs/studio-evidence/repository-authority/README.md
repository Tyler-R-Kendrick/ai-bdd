# Controlled repository authority UI

These are actual Studio UI captures using a fresh branch server, an owned local OAuth code/PKCE provider, synthetic intercepted GitHub replies and an owned HTTP model fixture. Starting with zero users, the real callback automatically created one passwordless internal account. No personal repository identity was connected. A dummy legacy operator token/allowlist was configured only in this owned fixture.

Captured source: `4dc86935837d2ce9b7760a0a1cdff33c9caae41e`, tree `57a4f52d909e277037ff8b8b309332560b635f4e`. Source HEAD/tree stayed unchanged during capture. Subsequent table/documentation and evidence commits do not change that product code. The existing built static frontend was reused after confirming the client/shared sources were identical to the auth base; the index hash is recorded in [verification.json](verification.json). No build or production request was needed.

- [Private PR unavailable](controlled-private-repository-unavailable.png), 1600 × 1000: the newly signed-in account owns this project. Normal Tests → Linked work → Refresh returns the fixed repository-unavailable message and leaves the owned private PR state **unknown**. The response does not distinguish private from missing or otherwise unavailable resources.
- [Public file readable](controlled-public-repository-readable.png), 1600 × 1000: the same account uses the normal Chat composer with an explicitly selected owned fixture model. The real Vercel AI SDK repository-file tool returns the owned public README, and the saved fixture answer is visible. This is a deterministic HTTP model fixture, not native/default-model inference or hosted model-quality evidence.

The capture agent and root reviewer opened both original PNGs, independently checked hashes/dimensions and matched the captions. Neither image was edited or masked; the visible account name is synthetic. The owned session was logged out and temporary browser/services were closed.

The private HTTP refusal, anonymous request assertions and absence of private content in prompts/chat are backed by owned protocol assertions. **Pixels do not prove Authorization headers.** All three synthetic repository requests were anonymous; two owned model HTTP requests occurred for the public-file positive control. No live GitHub/Connect/provider, production repository or paid model was called.

Public GitHub file/tree/history/pull-request reads support anonymous access. GitHub's code-search REST endpoint requires authentication even for public repositories. Controlled search fixtures establish request scope and credential handling, not live anonymous code-search availability.

These captures do not establish a real production GitHub callback, live private-provider access or full product readiness. The deployment's legacy operator token and allowlist were separately verified absent through presence-only metadata; this work does not claim a production exposure.
