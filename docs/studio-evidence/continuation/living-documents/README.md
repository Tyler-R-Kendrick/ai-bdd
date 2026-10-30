# Living-document rebuild evidence

Captured 2026-10-30 from assembled source `9676a0a13b2be61b0dfe359fe8a543bebba6a3d8`, with the real production-built client, `createApp`, authenticated sessions, SQLite, canonical source observer, machine lifecycle and rebuild service. `rebuild-ui.spec.ts` passed with one worker and zero retries using the actual pinned Playwright 1.64 Chromium headless shell (revision 1248): one case in 14.5 seconds, 16.5 seconds including the runner. Earlier system-Chromium and pinned runs also passed; this is the final recapture after canonical accepted-ADR grounding and the retained-base-graph label correction.

**The PR repository/head reads and workstation implementation/verifier completions in this browser case are explicit local protocol fixtures.** They establish product wiring, persistence, source binding, consent and permissions, not a live GitHub PR, real workstation execution, paid model, hosted queue or production deployment. Actual portable-connector Git/ACP/MCP execution, operator-entrypoint provenance and expired-repository-entitlement renewal are exercised independently by the focused runtime tests. Accepted-ADR-only source changes are also tested independently in SQLite and actual PostgreSQL; this browser fixture contains no accepted ADRs and does not claim to depict that case.

| Capture | Visible state and corresponding assertion |
| --- | --- |
| [Changes to build](living-document-changes-desktop.png) | A real collaborative edit persisted before Build. Current source v49 differs from delivered v2; the writer's own connected machine is selected; Build changes is enabled and automatic consent is unchecked. The retained graph correctly indicates pending changes. |
| [Completed source receipt](living-document-verified-desktop.png) | The exact original PR URL/branch was retained. Separate implementer/verifier fixture credentials completed the rebuild; baseline revision advanced and delivered source is v49. Built and Reviewed base graph retained are visible; no new graph approval was synthesized. The image shows the completed receipt, while the test checks the independent credential and baseline transition. |
| [Consented automatic queue](living-document-automatic-desktop.png) | Consent was explicitly checked and persisted. After a later actual document edit settled, maintenance admitted source v89 automatically on that same user/repository machine. The row says queued; this image does not claim the automatic work has executed or completed. Stop rebuild remains available to its requester. |
| [Fresh mobile viewer](living-document-viewer-mobile.png) | After the owner stopped the automatic rebuild, revoked consent and reloaded, a separate 390×844 viewer session sees retained completed/failed history and pending source changes. Build, Retry, Stop, machine selection and consent controls are absent. The test additionally requires a real viewer POST to return 403 and no page overflow. |

All four images were opened and visually checked after the final run. Current/delivered source labels, pending/retained-graph badges, queue/completion states, own-machine controls and mobile text match the descriptions above. No application API 500 or browser page exception occurred. These are captured application states, not proof of every possible execution or whole Chopin parity.

The fixture waits for the exact final typed text to persist before requesting Build. A stale source request remains rejected; it is never automatically retried as new approval. Checkbox edits remain visible while their authenticated save is pending and canonical state is checked before reload.

Reproduce from the built checkout:

```sh
STUDIO_CAPTURE_DIR="$PWD/docs/studio-evidence/continuation/living-documents" \
  pnpm --dir packages/studio exec playwright test --config rebuild.playwright.config.ts
```

`STUDIO_CHROMIUM_PATH` can select the installed pinned headless-shell executable. The test owns port 8895 and a fresh temporary store, starts no shared baseline server, and removes its test accounts/data during cleanup.
