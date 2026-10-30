# Full application evidence

Captured 2026-10-30 from source `28ea384` with the production-built Studio client and the real `createApp` composition. `packages/studio/final-product.playwright.config.ts` starts no shared web server: each case owns an ephemeral authenticated application listener, SQL store and actual local durable queue. The four cases passed in 28.2 seconds. Production build/typecheck passed. Screenshots use 1440 × 1000 desktop and 390 × 844 mobile viewports.

The model gateway, native Decision API, search endpoint and workstation completion are explicit local HTTP/protocol fixtures. These captures establish product wiring, source guards, permissions and persisted state. The 24/170 ms investigation rows are synthetic supplied observations, not performance measurements or live integration acceptance. No live vendor credentials, real workstation execution, deployed production environment or whole-reference feature parity is claimed by these images.

| Image | Visible claim and corresponding browser assertion |
| --- | --- |
| [Default T3](agent-profile-default-t3-offline.png) | T3 is selected by default, its missing operator runtime is visible. Manual invocation returns 503 with zero generative gateway calls. |
| [Explicit Vercel/fx](agent-profile-explicit-fx.png) | Writer explicitly saved the separate harness/provider/model choice; the selection survives reload. |
| [Approved research brief](conversation-research-desktop.png) | The exact edited brief was explicitly started; its real request and completed inline child link are visible. Browser verifies the exact search request and persisted child source citation. |
| [Questionnaire and accepted answer](conversation-questionnaire-desktop.png) | The proposal became an inline questionnaire and a separate attributed human-accepted ADR. Both survive reload. |
| [Live request card](investigation-request-desktop.png) | An actual proposed record appears in the already-open collaborative source without reloading, with its sealed version/checkout. |
| [Native evidence view](investigation-inline-desktop.png) | Published child renders the typed dataset as a native chart/table. Contract row selection is persisted at revision 2. |
| [Read-only mobile evidence](investigation-inline-mobile-viewer.png) | A fresh viewer sees the saved selection, disabled row controls, and locally readable table cells with no page overflow. |
| [Read-only evidence decision](investigation-decision-mobile-viewer.png) | Attributed conclusion remains tied to exact evidence hash and selection revision after reload; viewer cannot mutate it. |
| [Independent decision profile](decision-profile-independent-desktop.png) | Decision provider/model/threshold are separate from the unchanged T3 chat profile. An offline Jev selection also survives save/reload before explicitly selecting the configured native fixture. Provider byte/question limits are visible. |
| [Native semantic review](design-review-native-desktop.png) | Only the selected passage was sent. Native probability, separate score/confidence, abstention and provider/model/source provenance remain visible; no approval or source mutation is implied. |
| [Mobile uncertainty](design-review-native-mobile.png) | The same persisted native assessment is readable at 390 px; 50% predicate probability remains an abstention. |
| [Stale review](design-review-stale-mobile.png) | A later saved source edit marks the historical review Source changed and disables passage-discussion actions. |

The semantic review case also posts a real anchored discussion through “Discuss this passage”, reloads, and checks the exact persisted anchor/quotation/message. It asserts no application API 500 responses or browser page errors. The investigation case asserts fresh viewer permissions and document width, alongside exact result-hash/selection binding. Each retained image was visually opened and checked against these claims. The mobile native table was recaptured after the scoped table-layout correction; the stale screenshot was scrolled to the actual stale result before capture. Earlier isolated editor captures and the unrelated shared-port baseline are not evidence for these claims.

Reproduce from a built checkout:

```sh
STUDIO_CAPTURE_DIR="$PWD/work/product-evidence" pnpm --dir packages/studio exec playwright test --config final-product.playwright.config.ts
```
