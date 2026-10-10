# P-PLAYWRIGHT integration notes

Package: `@ai-bdd/driver-playwright` (`packages/driver-playwright/`). Public API and behavior are in its README.
No contract changes and no new dependencies requested (`playwright-core` 1.64.0 was already declared).

## VERIFY outcomes

* **V3 (AI-mode snapshot and refs): confirmed.** `page.ariaSnapshot({ mode: 'ai' })` returns `[ref=eN]` and
  `page.getByRef('eN')` resolves the element (playwright-core 1.64.0, Chromium 141). Refs inside a navigated document
  appear with a frame prefix (`f1e2`); `getByRef` accepts them. The default-mode fallback (section 11.1) was **not needed**.
  What exists is a narrower fallback: nodes the snapshot gives no ref (hidden or zero-size nodes, `<option>`, empty lists)
  are exposed as `r<rev>:n<k>` and resolved with `getByRole(role, {name, exact:true}).nth(i)`.
* **V4 (grammar on Acme pages): confirmed and pinned** in `test/golden/*.aria.txt` (fixture pages) and
  `test/golden/acme-*.aria.txt` (captured from `startAcmeApp`). Observed details that the spec text did not spell out:
  keys containing `: ` are single-quoted as a whole (`- 'link "a: b" [ref=e1]':`); values containing `: ` or looking like
  YAML scalars are double-quoted with `\\ \" \n \xNN` escapes; `[cursor=pointer]` follows `[ref=...]`; `[active]` marks the
  focused element; `[invalid]`, `[pressed=mixed]`, `[checked=mixed]` exist; names are elided when equal to the child text
  (for example `button` with `- text: ...` children). **The password value is exposed** by the snapshot
  (`textbox "Password": hunter2`), so the driver strips it (V4 fallback) via an element check.
* **V7 (Chromium without download): confirmed with a caveat.** `/opt/pw-browsers` holds revision 1194 (Chromium 141) but
  Playwright 1.64 asks for 1248, so Playwright's own lookup fails with "Executable doesn't exist". The driver therefore
  falls back to `discoverChromium()` (newest `chromium-*` / `chromium_headless_shell-*` under `PLAYWRIGHT_BROWSERS_PATH`,
  `/opt/pw-browsers`, `~/.cache/ms-playwright`) after honoring `AI_BDD_CHROMIUM_PATH`. CI jobs that run `playwright-core
  install chromium` only when missing will keep working; a job that sets nothing relies on the discovery.

## Behavior the integrator and other swarms should know

* **Redirect hops are invisible to Playwright routing** (it auto-continues them). To satisfy R-AG3 for "a route that 302s to
  an off-host URL" the driver attaches its own CDP `Fetch` session on Chromium (documents only), which blocks the hop before
  any request is sent. On Firefox/WebKit only a `request` event guard exists (navigation is cancelled right after the hop
  request starts). `window.open` first requests cannot be intercepted by Playwright at all; driver-owned contexts get an
  init script that makes `window.open` to a denied URL return `null`; `sessionFromPage` cannot install one (init scripts
  cannot be removed from a borrowed context), so there the popup is closed after it appears and a request to the denied
  host may already have been sent.
* **Blocked navigations are answered with a cancelled download** (`content-disposition: attachment`), not `route.abort`,
  because an aborted top-level navigation replaces the current page with Chromium's error page.
* `perform` returns `POLICY_DENIED` for an action (for example a click on a link) whose navigation was blocked.
* `maxSessions: 8` is advisory; the driver opens as many contexts as asked (the 20-session isolation test relies on it).
* `request()` throws `AiBddError` (`POLICY_DENIED`, `DRIVER_ERROR`) rather than returning an error object, because the
  contract return type has no failure shape. It follows redirects manually (max 5), checking each hop against the policy.
* Observation details relevant to the AC3 parity test (X-CORPUS / P-APP), all visible in `test/golden/acme-*.nodes.json`:
  * the Playwright tree has the same `main` landmark and role/name pairs as the fake driver on every Acme screen
    (asserted in `acme.test.ts` against the pinned goldens); anonymous `generic` wrappers are pruned;
  * empty text inputs and password inputs have **no** `value` (matches the Acme model);
  * `focused` appears in `states` for the active element, so `treeHash` changes with focus. The fake driver never sets it;
    compare with `focused` ignored;
  * nodes without a Playwright ref use `n<k>` refs (for example an empty `list "Todo items"`).
* Acme goldens (`test/golden/acme-*.aria.txt`) pin the HTML P-APP renders today (clock times and frame prefixes are
  normalized). If P-APP changes the markup, regenerate with `UPDATE_GOLDEN=1 pnpm exec vitest run --project unit
  packages/driver-playwright/test/acme.test.ts` and review the diff.

## Tests

`pnpm exec vitest run --project unit packages/driver-playwright/test` (about 25 s; needs Chromium). The shared kit
(`packages/sdk/test/kit/driver-conformance.ts`) passes against `startAcmeApp` via a relative import in
`test/conformance.test.ts`.
