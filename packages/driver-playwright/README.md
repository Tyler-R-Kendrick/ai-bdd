# @ai-bdd/driver-playwright

A real-browser driver built on `playwright-core`.

```ts
import { playwright } from '@ai-bdd/driver-playwright';
export default { drivers: { web: playwright({ browser: 'chromium', baseURL: 'http://localhost:3000', headless: true }) } };
```

## Behaviour

| Concern | Implementation |
| --- | --- |
| Isolation | one `BrowserContext` per session |
| Tree | `page.locator('body').ariaSnapshot()` parsed into nodes; refs are `r<revision>-<n>` and valid for that observation only |
| Locators | `getByTestId` when the fixture exposes a test id, otherwise `getByRole(role, { name, exact: true })`, with `nth()` only where the recording needed disambiguation. No CSS paths, no XPath |
| Screenshots | full-page masks over `input[type=password]` and `[data-ai-bdd-secret]`; `maskingProven` is true when every observed password input was masked |
| Settle | `document.readyState === 'complete'` **and** no in-flight requests (a counter over `request`/`requestfinished`/`requestfailed`, ignoring websockets and `EventSource`) |
| Policy | `policy.allowHosts` is checked before navigation and again on the final URL, so a redirect cannot escape the allowlist |
| Capabilities | pixels, trees, video on request, `nativePredicates: false` |

Coordinate verbs (`tapAt`, `typeAt`) are declared unsupported on purpose: they need a capture id and
bypass the structural selectors that make a recording replayable.

## Install the browser

```bash
pnpm -F @ai-bdd/driver-playwright exec playwright-core install chromium
```

`ai-bdd doctor` reports the driver as unavailable with that hint when the browser is missing, and the
integration tests skip themselves when no browser is installed.
