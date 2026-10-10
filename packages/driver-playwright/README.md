# @ai-bdd/driver-playwright

Playwright driver for ai-bdd (spec 11.1). It observes pages through Playwright's AI-mode aria snapshot, acts through
locators, and enforces the navigation policy in the browser itself (defense in depth next to the runner and the actor).

```ts
import { playwright, createDriverFactory, sessionFromPage, parseAriaSnapshot } from '@ai-bdd/driver-playwright';
```

## Plug it into a project

Through the ordinary `drivers` config key, either as a package entry (JSON, `.mjs`, `.js` configs; the loader calls this
package's `createDriverFactory(options)`):

```js
drivers: { web: { use: '@ai-bdd/driver-playwright', options: { browser: 'chromium', headless: true } } },
defaultDriver: 'web',
```

or as a factory object (the only form a typed `.ts` config takes): `drivers: { web: playwright({ browser: 'chromium' }) }`.
Any other driver package (`@ai-bdd/driver-cua` for Cua Driver, a browser-use runtime, for example) plugs in the same way; see
`docs/drivers.md#plugging-in-a-driver`. This package is also the reference implementation for the shared conformance
kit (`conformance.test.ts` below).

## Exports

| Export | Purpose |
|---|---|
| `playwright(opts?)` | `DriverFactory` with id `playwright`. Options: `browser` (`chromium` default, `firefox`, `webkit`), `headless` (default `true`), `launchOptions`, `viewport` (default 1280x720), `recordVideo`, `actionTimeoutMs` (default 5000), `navigationTimeoutMs` (default 15000). |
| `createDriverFactory(options)` | Same from JSON configuration. Unknown or ill-typed keys throw `CONFIG_INVALID`. Also accepts `executablePath`. |
| `sessionFromPage(page, sessionOpts, { policy, baseURL? })` | Wraps an existing Playwright `Page` (for example the `page` fixture of `@playwright/test`) as a `DriverSession`. `close()` removes the policy hooks and **never closes the page or its context**. |
| `parseAriaSnapshot(text)` | `page.ariaSnapshot({ mode: 'ai' })` text to `ObservedNode[]` (document order, flat, with `depth`/`parentRef`). |
| `pruneWrappers(nodes)` | Drops anonymous `generic` wrappers and re-parents their children (applied by `observe`). |
| `discoverChromium(headless)` | Finds an installed Chromium under `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` or `~/.cache/ms-playwright`. |

Capabilities: all ten verbs, `pixels: true`, `maskingProven: true`, `request: true`, `maxSessions: 8` (advisory: the runner
limits concurrency, the driver itself does not refuse more sessions). Driver version `1.0.0` (a major bump invalidates
recordings, R-CH4).

## Browser

One browser per `Driver` (launched lazily on the first `openSession` or `selfCheck`, then reused), one `BrowserContext`
per session. Nothing is ever downloaded. Resolution order: `launchOptions.executablePath` / `executablePath`, then
`AI_BDD_CHROMIUM_PATH`, then Playwright's own lookup (`PLAYWRIGHT_BROWSERS_PATH`), then, if the exact revision Playwright
expects is missing, any Chromium found under `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` or `~/.cache/ms-playwright`.
A browser that cannot be launched surfaces as `DRIVER_UNAVAILABLE`; `selfCheck()` reports it as `{ok:false, problems}`.

## Observation

* `observe()` parses the AI-mode snapshot. Refs are exposed as `r<revision>:<ref>` (for example `r3:e12`, `r3:f1e4` inside
  frames). Nodes without a Playwright ref (invisible or zero-size nodes such as `<option>`) get `r<revision>:n<k>` and are
  resolved by `getByRole(role, {name, exact:true}).nth(i)`.
* Attributes map to `states` (`checked`, `disabled`, `expanded`, `selected`, `pressed`, `focused` from `[active]`,
  `invalid`) and `level`; `/url:` lines become `url`. Inline text becomes `value` for `textbox`, `searchbox`, `spinbutton`,
  `slider` and `combobox` (a combobox without inline text takes the selected option's name), otherwise `text`, and also the
  `name` when the node has no accessible name. Buttons and links whose name Playwright elided take the text of their
  content. Empty text inputs have no `value`.
* `busy` is true when the document contains `[aria-busy="true"]`, `[role="progressbar"]` or `<progress>` (or while the
  document is navigating). Pure CSS animations are invisible to it (known limitation of settle).
* `route` is `pathname + search`; other schemes report the raw URL (`about:blank`).
* `pixels: true` takes a PNG with `input[type=password], [data-ai-bdd-secret]` masked (magenta boxes), animations
  disabled and the caret hidden; `masked` is always `true`.

## Secrets

* **Taint.** The first `fill` or `select` whose value is `{secret}` sets `tainted = true` for the rest of the session
  (also when the action then fails).
* **V4: password values are exposed by the snapshot** (`textbox "Password": hunter2`). The driver removes `value` from every
  node whose element is a password input or inside `[data-ai-bdd-secret]`, scrubs the text of `[data-ai-bdd-secret]`
  elements everywhere, and replaces any resolved secret value (4 characters or longer) found in node text with
  `[secret]`. The redactor remains the backstop.
* Error messages are first-line only, ANSI-stripped and never contain a resolved secret.

## Policy (R-AG3)

`policy.denyVerbs` is enforced in `perform`. `navigate` goes through `checkNavigation` (scheme, credentials, exact or
`*.suffix` hosts) and returns `{ok:false, error:{code:'POLICY_DENIED'}}`. Independently of the verb, the session blocks:

* top-level navigations to disallowed URLs (links, forms, scripts, `Location` changes) via `context.route`. A blocked
  navigation is answered with a cancelled download, so the page keeps its current document instead of showing Chromium's
  error page; the action that triggered it returns `POLICY_DENIED`;
* **redirect hops** to disallowed hosts. Playwright never routes redirect hops, so on Chromium the driver attaches a CDP
  `Fetch` session (documents only) that sees every hop and blocks it before it is sent; a `context.on('request')` guard
  covers other browsers (it cancels the pending navigation, but the hop request may reach the server);
* popups to disallowed URLs (closed as soon as they appear). In driver-owned contexts an init script also makes
  `window.open` to a disallowed URL return `null` without a request. Allowed same-host popups stay open but are not observed;
* a main frame that still ends up on a disallowed URL is sent back to `about:blank`.

`request()` also applies the policy to the target and to every redirect it follows (manually, at most five hops).

## Perform

`click`, `fill`, `press`, `selectOption`, `setChecked`, `hover`, `mouse.wheel` (scroll by 600 px), `goto`, `goBack`,
`waitForTimeout(min(ms, 5000))`. Target errors and timeouts return `{ok:false, error}` and never throw: `STALE_REF` for a ref
from another revision or without the `r<rev>:` form, `TARGET_NOT_FOUND`, `POLICY_DENIED`, `DRIVER_UNAVAILABLE` (closed page
or browser), `DRIVER_ERROR` (retryable) for everything else. A ref stays valid until the next `observe()`. `navigatedTo`
is the new URL when the action changed it.

## `request()`

`context.request.fetch(new URL(path, baseURL), ...)` shares cookies with the page. Object bodies are sent as JSON; JSON
responses are parsed, everything else is returned as text. Violations throw `AiBddError`.

## Tests

`pnpm exec vitest run --project unit packages/driver-playwright/test`

* `aria.test.ts` parser unit cases and goldens (`test/golden/*.aria.txt` are real Chromium output, `*.nodes.json` the
  parsed result). `UPDATE_GOLDEN=1` rewrites them.
* `driver.test.ts` behavior against an inline fixture server (`fixture.ts`): policy matrix, redirect and popup blocking,
  masking pixels, taint, busy, 20 parallel sessions, `request()`.
* `acme.test.ts` the same driver against `startAcmeApp` (skipped, with the reason in the suite name, while it is a stub).
* `conformance.test.ts` runs the shared kit `packages/sdk/test/kit/driver-conformance.ts`.

Tests need Chromium (see Browser) and skip themselves when none can be launched.
