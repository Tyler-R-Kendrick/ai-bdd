# Studio review evidence

These captures use synthetic local review content. They contain no deployment credentials and do not represent customer activity.

| Capture | Source | What it establishes |
| --- | --- | --- |
| 01-artifact-api.png | Chromium's built-in JSON viewer, authenticated `GET /api/artifacts/:id`, backend code c4cfe7e | One stored artifact and its directly related discussion thread, persisted message, dedicated ADR, and version. Empty runs and inactive agents are visible. |

The API capture was generated from an archived build of the foundation PR, without the UI layer. Automated checks establish persistence, collaboration and authorization behavior; a static screenshot alone does not prove those behaviors.

The UI captures below were inspected against the built application and the scope in the workspace PR. The final combined Chromium suite passed all 16 workflows. A fresh visual review shipped these 14 states after contrast, focus, layout, and status corrections. The named Customer onboarding examples are illustrative, and the media examples are generated acceptance fixtures.

| Capture | Observed state |
| --- | --- |
| 02-workspace.png | Shared design document, directly related conversation, and explicitly unlinked acceptance block |
| 03-workspace-mobile.png | The same document at a 390px viewport |
| 04-project-canvas.png | Main design artifact composed with code, image, and video artifacts |
| 05-artifact-decisions.png | Persisted, attributed, accepted artifact ADR |
| 06-code-preview.png | A real local interaction in the isolated preview |
| 07-json-render.png | Actual JSON-render catalog output |
| 08-openui.png | Actual OpenUI output; this capture intentionally shows an unsaved preview |
| 09-image-canvas.png | Image canvas with an authenticated uploaded raster asset |
| 10-brand-canvas.png | Editable text, raster layer, and custom-font composition |
| 11-video-timeline.png | Timed composition whose WebM export was verified as VP9, 640×360, 1.000000 seconds |
| 12-scene-editor.png | Persisted parametric scene and transform controls |
| 13-cad-editor.png | Worker-backed CSG subtraction; the exported STL volume is checked independently |
| 14-rich-document.png | Persisted interactive chart and diagram; tabs were exercised below the captured scroll position |
| 15-chat-history.png | Earlier-message retrieval in a dedicated artifact thread |

Screenshots do not certify uncaptured states, complete product parity, live providers, arbitrary media compatibility, or whole-system correctness. No AI-provider execution or passing acceptance result is implied by an unconfigured or unlinked state.

## Release-layer evidence

[16-release-verification.png](16-release-verification.png) is a browser-rendered verification **report**, not a product-screen capture. It shows the six exact interval certificates, nine role/action cases, and seven observed production-container smoke checks from [interface-verification.json](interface-verification.json) and [container-smoke.json](container-smoke.json). The [report HTML](release-verification.html) records the same scoped results. The immutable image ID is recorded in the report; it is a tested runtime image, not a source-attestation claim.

The screenshot explicitly shows general-purpose execution proof as unverified. It establishes neither live-provider readiness nor complete reference-product parity. The renderer used the raw local reports; command logs and automated tests provide the separate execution evidence.
