# GitHub sign-in screen review

The desktop and mobile images show the actual Studio sign-in UI with a controlled **available GitHub provider** response. They establish the screen, navigation action and absence of credential forms. They do not establish a completed GitHub authorization, a production account session or server-side password rejection; those require the separate authentication flow checks.

- [Desktop](desktop.png): one readable **Continue with GitHub** action; no username, email, password, setup, demo or organization sign-in form.
- [Mobile](mobile.png): the same action and verified-email access guidance at 390 × 844, with no horizontal overflow.

Six browser checks passed in 5.8 seconds. They cover both viewports, the OAuth start-route navigation boundary without a credential submission, unavailable-provider retry, redacted status-error retry, ignored legacy authentication flags and fixed callback-failure guidance. The desktop check also verifies the loaded Inter font and action text contrast of at least 4.5:1. Type checking, focused lint and diff checking passed. Exact source-file and screenshot hashes are in [ui-verification.json](ui-verification.json).

Both final images were visually inspected. Review found that the existing global anchor color initially overrode the primary action text; the scoped sign-in color correction and browser contrast assertion are included in the final source and captures. The captions describe only what these images and this UI lane establish.

Run the focused lane from `packages/studio`:

```sh
node node_modules/@playwright/test/cli.js test --config playwright.signin.config.ts
```

The dedicated Vite configuration permits linked dependency files in an isolated review worktree; deployment continues to use the normal Vite configuration. The test intercepts sign-in status and the local navigation boundary only, and never simulates an authenticated session.
