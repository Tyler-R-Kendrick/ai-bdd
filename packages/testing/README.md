# @ai-bdd/testing

Test infrastructure for ai-bdd: the **Acme fixture app** (one state machine, two renderers), a **fake driver** over it,
**fixtures** for it, a deterministic **fake model** and the acceptance **corpus**. Nothing here is needed by users of
`@ai-bdd/sdk`; it exists so the whole pipeline can be exercised offline and deterministically.

```ts
import { acmeModel, startAcmeApp, fakeDriver, acmeFixtures } from '@ai-bdd/testing';
```

## Acme app

`acmeModel` is a pure state machine:

| Function | Meaning |
|---|---|
| `initialState({flags?, adminPassword?, plan?, unpaid?, signedIn?})` | New per-session state. Unknown flags throw. |
| `view(state, route, now): UINode[]` | The page as `[navigation "Primary", main]`. `route` is `pathname + search`. |
| `dispatch(state, event, now): {state, redirect?}` | Events: `visit`, `input`, `action`, `seed`, `reset`. Never mutates. |
| `resolveRoute(state, route)` | Server-side redirects (`/` and signed-in `/login` go to `/settings/billing`). |

`UINode = {role, name, value?, states?, level?, href?, action?, field?, children?}`.

`startAcmeApp({port = 0, adminPassword = 'correct-horse-battery', testToken = 'acme-test', flags})` returns
`{url, close()}`. It uses `node:http` only, listens on `127.0.0.1`, and renders the same `UINode` tree to semantic HTML.
State is per `acme_sid` cookie. Inline JS exists only on `/slow` (content swap) and `/todos` (sync clock).

Flags: `v2` (the upgrade button is named "Go Pro") and `bug-upgrade-noop` (Confirm closes the dialog but changes nothing).

### Screens (roles and names are normative)

Every page starts with `navigation "Primary"` (links Billing `/settings/billing`, Todos `/todos`, Checkout `/forms/two`,
Release notes `/notes`) followed by an unnamed `main`. `main` carries `aria-busy` while a spinner is shown.

| Route | Contents of `main` |
|---|---|
| `/login` | heading "Sign in" (1), [alert "Invalid email or password"], textbox "Email", textbox "Password" (password input), button "Sign in" |
| `/settings/billing` | heading "Billing" (1), [alert "You have N unpaid invoices. Settle them before downgrading."], region "Plan" (status "Plan: Free"/"Plan: Pro", button "Upgrade to Pro"/"Go Pro" or "Downgrade to Free"), region "Invoice preview" (paragraph "Next invoice: $0.00" / "$12.50 (prorated)"), [dialog "Confirm upgrade" (paragraph, buttons "Confirm", "Cancel")], [status "Upgraded to Pro" / "Downgraded to Free"] |
| `/todos` | heading "Todos" (1), textbox "New todo", button "Add", [paragraph "No todos yet" while empty], list "Todo items" (listitem "<title> — added HH:MM:SS"), status "Synced at HH:MM:SS.mmm" |
| `/forms/two` | heading "Checkout" (1), region "Shipping" (textbox "Street", button "Submit"), region "Billing address" (textbox "Street", button "Submit"), [status "Shipping saved" / "Billing address saved"] |
| `/slow?ms=N` | progressbar "Loading" (busy) for N ms, then heading "Report ready" (1) |
| `/notes` | heading "Release notes" (1), the injection paragraph, link "Continue" to `https://evil.example/steal` |
| anything else | heading "Not found" (1), HTTP 404 |

Times are UTC. The `/todos` sync status only changes every `SYNC_PERIOD_MS` (500 ms) so a screen can still settle
(settle needs 300 ms of unchanged tree) while an after-probe observation 500 ms later still differs (volatile).

### Test API

`POST /__test/reset` and `POST /__test/seed {plan?: 'free'|'pro', unpaid?: number, flags?: string[], signedIn?: boolean}`.
Both need the header `x-acme-test-token` (401 otherwise), act on the caller's cookie session, and validate their input (400).
`reset` restores the flags the app was started with. `GET /__redirect?to=<url>` answers 302 to any URL (driver policy tests).

## Fake driver

`fakeDriver({flags, adminPassword, clockStepMs = 100, maxSessions = 8, exclusiveResource, testToken})` returns a
`DriverFactory` (id `fake`, version `1.0.0`). Every session has its own Acme state and a fake clock that starts at
`2026-01-01T09:00:00Z` (`FAKE_EPOCH_MS`) and advances `clockStepMs` after each `observe` (and by `ms` on the `wait` verb).

- Observation: `nodes` follow the `view` tree (depth, `parentRef`, levels, `url` for links); refs are `r<revision>:e<n>`;
  `busy` while a progressbar shows; `treeText = renderTree(nodes, {refs: true})`; screenshots (when `pixels: true`) are
  deterministic 32x32 solid-colour PNGs derived from `treeHash`, `masked: true`.
- `perform`: all verbs. Failures come back as `{ok: false, error}` (`STALE_REF`, `TARGET_NOT_FOUND`, `POLICY_DENIED`).
  Navigation and link clicks go through `checkNavigation`; allowed external hosts show a blank page with heading
  "External". `denyVerbs` is enforced. A `fill` with `{secret}` taints the session for the rest of its life.
  `press Enter` submits like a browser (first button on the page). `select` and `check` do not apply to Acme.
- `request()` serves the test API in-process on the session's state.
- `maxSessions` is advertised and enforced (`SESSION_LIMIT`).

## Fixtures

`acmeFixtures = [seedAccount, resetAccount]`. `seedAccount({plan, unpaid})` resets first and then seeds, so it is
idempotent; both call the test API through `session.request` with the token (`ACME_TEST_TOKEN` overrides the default) and
then reload the current page so a real browser shows the new data.

## Tests

`pnpm exec vitest run --project unit packages/testing/test/app packages/testing/test/fake-driver packages/testing/test/fixtures`
includes model/HTML parity (a small HTML parser instead of a browser), a mini-browser that drives the real server and the
fake driver through the same flows, PNG determinism, every flag, the spinner and clock behaviour, and token enforcement.
