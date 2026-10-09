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

## Install the browser (headless shell only)

The driver runs the **headless shell**, not a full browser:

```bash
pnpm -F @ai-bdd/driver-playwright exec playwright-core install chromium-headless-shell
```

That is the whole download — no full Chromium, no display server, no headed browser. The host still
has to provide the shell's shared libraries (`libglib2.0-0`, `libnss3`, `libX11`, …); `ai-bdd doctor`
reports the driver as unavailable, with the launch error, when they are missing.

## Integration tests are opt-in

```bash
AI_BDD_PW_BROWSER=1 pnpm -F @ai-bdd/driver-playwright test
```

Without the flag the browser suite reports how to enable itself and the rest of the package still
runs. With it, the driver passes the driver conformance suite against the fixture app, a driver-level
parity check against the fake driver (AC3), and a real-input test that clicks a button and waits for the
screen to change. In an environment without the shared libraries on the default search path, point
`LD_LIBRARY_PATH` at them (a container image installed with `install-deps` needs nothing extra).

## Parser golden

`test/fixtures/aria-snapshots.json` is captured from the real headless shell:

```bash
AI_BDD_PW_BROWSER=1 node --import tsx scripts/capture-aria.mts
```
