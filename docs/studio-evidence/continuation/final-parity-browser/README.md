# Studio browser acceptance and refreshed passage captures

Source: **`ddee70150b81adb37e344709c026d3c1c9e9646e`**. The production client/server/connector build passed, then the ordinary Studio `**/*.spec.ts` glob collected and passed **64 cases across 22 files in 4.1 minutes**. One concurrent worker, zero retries, zero failures, zero skips and zero exclusions. No product or test changes were needed. `receipt.json`, `test-list.txt` and `browser.log` preserve the exact command, authoritative collection and observed results.

This was an isolated fresh worktree and database. The built standard App server used port 8877 with server reuse disabled; fixture Apps used their own ephemeral origins. The positive real-MP4 case and API media renderer used SHA-pinned official Chrome for Testing 156.0.8078.80. General local cases used system Chromium 154.0.8037.57; the negative real-codec guard launched Playwright's installed Chromium 156.0.8078.4 directly. API/model/source/issuer/workstation protocol fixtures remain explicit. This receipt establishes local acceptance at the stated source, not a later commit, latest hosted CI head, live provider credentials or deployed production acceptance.

Coverage includes all standard files, including archive lifecycle (G8), full remote stream/questions/runs and pagination (G3), evidence-backed findings and human incorporation (G4), explicit title/goal consent and manual source protection (G6), and the full-App passage `/research`/investigation placement with recent agent-change attribution (G7). Existing collaboration, restricted Word/MDX interchange, inline questionnaire/ADR acceptance, implementation graphs/rebuilds, identity, Pact, both UI engines, and every media editor also passed. These counts are one suite and are not additive with earlier focused checks.

The **current five passage PNGs were refreshed at product source `cdac9aa4fa52b4c51a3d5039be0c11dea4aa09bb`**, after the passage modal adopted the existing document field/footer spacing. They are not the original `ddee701` full-suite captures. The original 64-case `receipt.json`, `browser.log` and `test-list.txt` remain byte-for-byte unchanged; their screenshot fingerprints refer to the [original capture revision](https://github.com/Tyler-R-Kendrick/ai-bdd/tree/a757acfb22858f3d120b538f68496511a32691af/docs/studio-evidence/continuation/final-parity-browser). `passage-focused-receipt.json` contains the current PNG fingerprints and the focused command.

The new production build passed. One focused passage case was then executed in **three fresh sequential runs on pinned Chromium 156.0.8078.4: 3 passed in 33.0 seconds, zero retries/skips**. This is a focused supplement, not a rerun or an enlargement of the earlier 64-case suite. The exact command is:

```sh
CI=1 PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright \
STUDIO_CHROMIUM_PATH=<pinned-156.0.8078.4-headless-shell> \
STUDIO_MP4_CHROMIUM_PATH=<official-156.0.8078.80-chrome> \
STUDIO_CAPTURE_DIR=<isolated-worktree>/work/review/passage-spacing-cdac9aa \
pnpm --filter @ai-bdd/studio exec playwright test tests/final-product.spec.ts \
  --grep 'passage slash commands place exact research and investigation cards inline and keep run controls owner scoped' \
  --workers=1 --retries=0 --repeat-each=3
```

An earlier focused attempt exposed an invalid fixture caret precondition. The strengthened existing fixture (`3dd9d49`) waits for initialized/synced state and native/ProseMirror paragraph agreement before the real Home key, then offset agreement at zero before `/`. It does not inject selection, call hidden editor commands, sleep or widen budgets. The nine retained diagnostics observed four immediate post-Home states where the native caret was at zero while ProseMirror still reported the paragraph end; all nine settled at zero before slash input. The provider was already synced in those observations; this does not establish a production initialization defect. The intermediate local failure log and pre-fix hosted failure log at head `34d1737dbd453fff309046aedc404aae77e53cd2` are preserved separately.

All five refreshed captures were visually reviewed at full size. The modal now separates the label, textarea, muted source context and right-aligned actions. The other four visible-state claims remain unchanged:

| Capture | Observed state |
| --- | --- |
| `passage-research-brief-desktop.png` | The writer reviews the exact edited brief and source version before explicitly starting passage research. |
| `passage-research-highlight-desktop.png` | A completed research card sits directly after its selected requirement and links the published child. The fresh purple left marker is visible; its fade animation was allowed during capture. |
| `passage-investigation-ready-desktop.png` | A proposed investigation is attached to the following requirement, with the frozen source/checkout and owner Run/Withdraw controls. |
| `passage-investigation-queued-desktop.png` | Explicit owner approval queues that investigation and replaces Run with Stop. This photo does not claim the queued investigation has executed. |
| `passage-investigation-viewer-mobile.png` | A separate viewer reads the persisted inline cards at 390×844 with an Open control and no Run/Stop authority. |

The fixture deliberately retains an unrecognized `/usr/local` sequence as ordinary document text. It is not executed as a slash command. The displayed research and checkout identifiers are protocol fixtures. Screenshots establish visible state; the independent browser assertions establish exact placement/brief, persisted associations, source fencing, ownership and viewer permissions. No screenshot is evidence of live vendor accuracy or a production performance measurement.
