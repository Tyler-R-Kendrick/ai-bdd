# P-APP integration notes

## @ai-bdd/testing: Acme app, fake driver, fixtures

Public behavior is described in `packages/testing/README.md`. Points other swarms should know:

### Observed node shape (fake driver; the Playwright driver should match it)

Every page: `navigation "Primary"` (depth 0; links at depth 1 with `url` = href) then an unnamed `main` (depth 0).
Page content is a child of `main` (depth 1; region children depth 2; dialog children depth 2; list items depth 2).
The Playwright aria snapshot of the server page gives the same sequence (verified against Chromium with
`page.locator('body').ariaSnapshot()`): `status`, `paragraph` and `listitem` have no accessible name, so the parser must
fall back to inline text (SPEC 11.1). The fake driver never exposes the password textbox value; Chromium does (see VERIFY below).

### Deviations and additions to SPEC 13.1 (decisions to review)

1. `/todos` shows `paragraph "No todos yet"` while the list is empty. Without it, adding a todo leaves only volatile
   nodes (listitem name contains a time; sync status) and `computeEffect` would classify the step as
   `no-observable-effect` (fuzzy), contradicting M7 ("add-todo action deterministic").
2. The `/todos` sync status is quantized to `SYNC_PERIOD_MS = 500` ms (still formatted `HH:MM:SS.mmm`). A status that
   changed on every 100 ms observe could never satisfy settle (`quietMs` 300), so every `then` after `/todos` would
   fail with `SCREEN_NOT_SETTLED`. With 500 ms quanta the screen settles and `afterProbe` (taken >= 300 ms of
   observes later) still differs, so the node is volatile. Tested with the real `createSettler`.
3. `main` is an unnamed landmark. `aria-busy` on `<main>` is reflected in `Observation.busy` only; node `states.busy`
   is not set (Playwright does not report it either).
4. Extra route `GET /__redirect?to=<url>` (302 to any URL) so P-PLAYWRIGHT can test off-host redirects. The fake driver
   re-checks the redirect target against the policy and returns `POLICY_DENIED`.
5. `/` redirects to `/settings/billing`; `/login` redirects there once signed in (`signedIn` seed). No page requires login.
6. `seed {flags}` replaces the session's flags; `reset` restores the flags the app/driver was started with. Unknown
   flags are rejected (400 / throw) so typos are loud.
7. `fakeDriver` accepts an extra `testToken` option (default `acme-test`); fixtures use `ACME_TEST_TOKEN` or the default.
8. Fixtures reload the current page after the test API call (`navigate` to `obs.url`), because a real browser keeps
   showing the old data after a seed; for the fake driver this is a harmless same-route visit.

### Action names (model events, useful for fake rules written against the model)

`login.submit`, `billing.upgrade`, `billing.confirm`, `billing.cancel`, `billing.downgrade`, `todos.add`,
`checkout.shipping.submit`, `checkout.billing.submit`. Form fields: `email`, `password`, `todo`, `shipping.street`,
`billing.street`.

### Conformance kit

`packages/sdk/test/kit/driver-conformance.ts` did not exist when P-APP finished. `test/fake-driver/conformance.test.ts`
imports it dynamically when present and runs `runDriverConformance('fake driver', () => fakeDriver(), {appUrl})`. The
equivalent checks (observe shape, treeHash stability, stale refs, navigation policy, taint, busy, isolation, request) live
in `test/fake-driver/driver.test.ts`. If the kit's signature differs, adjust that one call.

### VERIFY outcomes

- V3/V4 (partly): on the Acme pages Chromium's default-mode `ariaSnapshot()` prints links as `- link "Todos":` with a
  child `- /url: /todos`, headings as `[level=1]`, `status`/`paragraph`/`listitem` as `- status: text`; inputs print as
  `- textbox "Email"`. A filled input shows `- textbox "Email": a@b.c`, and **the password input also shows its value**
  (`- textbox "Password": correct-horse-battery`), so V4's fallback applies: P-PLAYWRIGHT must strip `value` for password
  inputs (the fake driver never exposes it). The redactor remains the backstop.

### Dependencies

None added. Imports only `@ai-bdd/sdk` (util functions) and `@ai-bdd/sdk/contracts`.
