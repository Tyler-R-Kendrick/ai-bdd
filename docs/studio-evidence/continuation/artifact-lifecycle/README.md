# Reviewed artifact archive evidence

Source: `08136a787234879829fe950ed002d25093909a0e`, an isolated assembled branch including authoritative root `a3b86e6`, the lifecycle implementation, and the independently reproduced same-artifact navigation fix `508e5b5`. The committed screenshot files were opened and visually reviewed after the final build and capture. No screenshot is an invented mockup.

The production client, server, hosting entrypoint, and portable connector build passed. Playwright 1.64.0 with its pinned Chromium headless shell 1248 ran **2/2 actual full-application cases in 4.4 s**, with one worker, zero retries/skips, and no page errors or HTTP 500 responses. Both cases use real `createApp`, authentication, SQL, collaboration, routes, and the built product UI on isolated loopback port 8902. The ephemeral test data and listener are removed when the run ends.

| Screenshot | What is visible | What the accompanying test additionally proves |
| --- | --- | --- |
| [Archive browser](archive-browse-desktop.png) | Owner archive browser, archived draft, retained message/ADR/version counts, restore and deletion entry points | Actual UI archive removes the draft from the active list; restore preserves its chat and dedicated ADR and permits editing again |
| [Explicit deletion confirmation](archive-delete-confirmation-desktop.png) | Exact title, explicit acknowledgement, irreversible-context explanation, final destructive action | The final button starts disabled; actual confirmed deletion removes the draft and owned context while retaining a minimal project-level deletion receipt. This screenshot is taken **before** that click |
| [Retained acceptance evidence](archive-retained-evidence-desktop.png) | Dependency explanation and disabled permanent-deletion action; restore remains available | The synthetic recorded acceptance-run row remains in SQL. This record is an explicit fixture and does not claim an acceptance test target executed |
| [Mobile viewer](archive-viewer-mobile.png) | 390 px archive browser, read-mode artifact behind it, retained dependency explanation, and no owner actions | Actual viewer restore/delete requests return 403; the document is non-editable, reopening its already-selected archive entry preserves the editor, and the page has no horizontal overflow |

The backend companion run passed **38/38 focused checks**: 22 archive cases and 16 existing-PR rebuild cases, including actual SQLite and PostgreSQL 17 transactions. It covers owner/main-artifact limits, fresh role and source/archive revision checks, person/Origin enforcement, unknown direct/indirect foreign-key retention, future JSONB source references, terminal Planner metadata, unexpired upload capabilities, durable media staging deletion, retried private object cleanup, immutable-key resurrection prevention, and running implementation/rebuild reports and independent verification after archive. New source writes/claims remain refused, and published build/test/investigation proof blocks permanent deletion.

The first mobile run exposed a real common navigation bug: reopening the currently selected archived artifact cleared its bundle without triggering a refetch. The code owner fixed same-target navigation in 508e5b5. Both the original assertion and the actual read-mode requirements remain in the final passing run; the test was not weakened to avoid the failure.

These are local operational/product checks. They do not establish a deployed production service, live Vercel Blob/Queues/Sandbox behavior, paid-provider execution, or actual external GitHub builds. The private object port was checked against the actual disk implementation and SQL retry/tombstone semantics. Provider provisioning and release-wide operational gates have separate receipts.

Commands:

```sh
pnpm --filter @ai-bdd/studio build
PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
  STUDIO_CAPTURE_DIR=<task-owned-capture-directory> \
  pnpm --filter @ai-bdd/studio exec playwright test \
  --config tests/artifact-lifecycle.playwright.config.ts
# With the isolated synthetic local PostgreSQL 17 URL supplied:
pnpm --filter @ai-bdd/studio exec vitest run --config vitest.config.ts \
  tests/artifact-lifecycle.test.ts tests/rebuild-machines.test.ts
```
