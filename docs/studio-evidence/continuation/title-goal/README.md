# Consented discussion goals in the full artifact workspace

Source: integrated `619f7482e37d278e7b488080b01f11738546d7dc`, title/prompt correction `a3c11c6`, scoped dialog layout `94e825f`, browser cases `1e840e4`. Captures were generated against the same source tree before adding this evidence directory. Client, server and connector production build, Studio typecheck and owned lint passed.

Local captures used Chromium 154.0.8037.57 (Debian 13); the focused config selects the explicit operator path or available system Chromium, otherwise Playwright's installed browser. The actual full App listens on an isolated ephemeral origin. Browser sign-in uses real password authentication and cookies. Generative work uses the installed Vercel AI SDK through an explicit local HTTP gateway fixture, after the user changes the initially offline T3 Code selection to Vercel / fx. These results do not claim a live provider call or model accuracy.

| Capture | Observed state |
| --- | --- |
| `title-goal-explicit-consent-desktop.png` | The two distinct, initially unchecked consent controls were explicitly selected for the project's main design document. |
| `title-goal-seeded-desktop.png` | The discussion-derived title and one goal paragraph appeared live in the actual main design document; fresh purple markers identify server-attributed agent changes. |
| `title-goal-viewer-mobile.png` | A separately authenticated viewer reads the persisted goal, with editing and renaming disabled and no page overflow. |
| `title-goal-manual-source-preserved-desktop.png` | A human's title and paragraph remain after an in-flight structured title/goal response becomes obsolete. The document heading is independent authored content and is preserved. |

All four full-size captures were visually inspected. The consent controls occupy separate rows; the saved document and mobile goal text are readable; the manual text is preserved. Screenshots show state. Independent browser assertions establish the source version, source identity, permissions and replay behavior.

Validation:

- `pnpm --filter @ai-bdd/studio build`: passed.
- `STUDIO_TEST_POSTGRES_URL=... pnpm --filter @ai-bdd/studio exec vitest run tests/title-goal.test.ts tests/artifact-titles.test.ts`: 20 passed, including real PostgreSQL and local SDK HTTP generation, source/rename/consent races, rollback and bounded output/prompt fields.
- `CI=1 PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright STUDIO_CAPTURE_DIR=... pnpm --filter @ai-bdd/studio exec playwright test --config tests/title-goal.playwright.config.ts`: 3 passed in 25.2 seconds, one worker, zero retries/skips. The ordinary `*.spec.ts` acceptance glob also includes these cases.

The browser cases verify exactly one source-version advance, unchanged stable node IDs, canonical persisted Yjs equal to document JSON, server-owned change attribution, unchanged proposed ADRs, frozen selected generative profile and actual gateway model header, one provider call across redelivery, persistence after reload, a separate read-only mobile viewer, no source edits without goal consent, no overwrite of an existing body, and human source/title changes winning over an in-flight response. No App page exceptions or API 5xx responses were observed.
