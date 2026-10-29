# Document review captures

These images show the built document workflow in the isolated continuation harness, using synthetic local content and authenticated SQLite-backed persistence. The desktop viewport is 1440×1000 and the mobile viewport is 390×844. Reduced motion and explicit single-column geometry checks prevent capturing a resize transition as a mobile state.

- `documents-review-desktop.png`: an accepted, attributed text suggestion next to the resulting shared prose; inline questionnaire response and persisted accepted ADR state; callout and document tooling.
- `documents-review-mobile.png`: the same review state stacked above the document, with closed/inert project navigation and no horizontal clipping.

The five real Chromium workflows exercised questionnaire→ADR persistence, suggestion→accept/reload, Markdown/Word/MDX downloads and confirmed import, embedded raster images and standalone HTML, actual multipage PDF output, literal find/replace, outline/table controls, and a fresh viewer session. The initial authoring run exposed that headings without an ID were absent from the outline; the corrected case passed. Imported headings now have safe ephemeral navigation positions until they have persistent IDs.

The captures establish this document-layer work item. They do not certify the later PostgreSQL/multi-instance migration, provider execution, or a public deployment. The isolated harness does not wire the optional ADR-opening callback, so the accepted ADR button is visible but disabled there; the integration App wires that callback and must verify navigation separately. A static image does not prove the executable behaviors above; the browser/API test results supply that evidence. The accepted suggestion state is unrelated to test-pass status, and the unlinked evidence block makes no passing-run claim.
