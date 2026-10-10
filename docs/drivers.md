# Drivers

A **driver** gives ai-bdd a way to see and operate one application. It is the only part of the system that touches the app. Everything else (agent, recorder, asserter, judge) works on what a driver returns: an **observation** (an accessibility-style tree) and the **outcome** of an action.

| Driver | Package | Use |
|---|---|---|
| `playwright` | `@ai-bdd/driver-playwright` | Real browsers (Chromium default). The driver for web apps. |
| `fake` | `@ai-bdd/testing` | In-memory model of the Acme demo app. Deterministic, offline. Used by tests and the quickstart via `AI_BDD_FAKE=1`. |

## Configuring drivers

In `ai-bdd.config.ts` (or `.mjs`):

```ts
import { defineConfig } from '@ai-bdd/sdk';
import { playwright } from '@ai-bdd/driver-playwright';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  drivers: { web: playwright({ browser: 'chromium', headless: true }) },
  defaultDriver: 'web',
});
```

In `ai-bdd.config.json`, name a package that exports `createDriverFactory(options)`:

```json
{ "drivers": { "web": { "use": "@ai-bdd/driver-playwright", "options": { "browser": "chromium" } } }, "defaultDriver": "web" }
```

`use` may also be a `./relative/file.mjs` resolved from the project root.

Which driver runs a scenario: the `driver` directive in its source chunks, else `--driver <name>`, else `defaultDriver` (the only configured driver if there is just one). The names are your config keys; recordings are filed under the driver's **id** (`playwright`, `fake`): `.ai-bdd/recordings/<driverId>/<scenarioId>.json`. Switching drivers means characterizing again, and a change of the driver's **major** version invalidates its recordings.

## The Playwright driver

```ts
playwright({ browser?, headless?, launchOptions?, viewport?, recordVideo?, actionTimeoutMs?, navigationTimeoutMs? })
```

| Option | Default |
|---|---|
| `browser` | `'chromium'` (also `'firefox'`, `'webkit'`) |
| `headless` | `true` |
| `viewport` | 1280 x 720 |
| `actionTimeoutMs` / `navigationTimeoutMs` | 5000 / 15000 |

- **Browser.** One browser per driver, launched lazily; one `BrowserContext` per session, so sessions share no cookies or storage. The driver never downloads a browser. It uses `launchOptions.executablePath`, then `AI_BDD_CHROMIUM_PATH`, then Playwright's own lookup, then any Chromium found under `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` or `~/.cache/ms-playwright`. A browser that cannot start is `DRIVER_UNAVAILABLE` (exit 3); `ai-bdd doctor` reports it.
- **Observation.** The page's AI-mode ARIA snapshot (`page.ariaSnapshot({ mode: 'ai' })`) parsed into nodes with roles, accessible names, states, levels and link URLs. `busy` is true for `aria-busy="true"`, `role="progressbar"` or `<progress>`.
- **Actions.** `click`, `fill`, `press`, `select`, `check`, `hover`, `scroll`, `navigate`, `back`, `wait`, all through locators. Target and timeout failures come back as `{ ok: false, error }`, never as exceptions.
- **Policy.** Navigation is limited to `policy.allowHosts` in the browser itself, in addition to the runner and agent: links, forms, scripts, redirect hops, popups and `window.open`. See [security.md](security.md#navigation-policy).
- **Secrets.** A `fill` or `select` using a `{secret}` taints the session. Screenshots mask password inputs and `[data-ai-bdd-secret]` elements; password values are stripped from observations.
- **`request()`** uses the page's cookies, so fixtures can call your app's test API.

Use `sessionFromPage(page, sessionOptions, { policy, baseURL })` to wrap a Playwright `Page` you already have. See [sdk.md](sdk.md).

## The fake driver

`@ai-bdd/testing` exports `fakeDriver({ flags, adminPassword, clockStepMs, maxSessions, exclusiveResource, testToken })` and `acmeFixtures`. With `AI_BDD_FAKE=1` the CLI registers it as `fake` (flags from `AI_BDD_FAKE_FLAGS`, comma separated: `v2`, `bug-upgrade-noop`) and makes it the default driver. It runs on a fake clock, so `/slow` pages and the todo sync indicator behave deterministically. It exists to test ai-bdd itself; it only knows the Acme demo app.

## The driver interface

Everything is defined in `@ai-bdd/sdk/contracts`.

```
DriverFactory   { id, create(ctx) → Driver }
Driver          { id, version, capabilities, openSession(opts) → DriverSession, selfCheck(), dispose() }
DriverSession   { id, driverId, driverVersion, capabilities, observe(), perform(action), request?(), close() }
```

### Capabilities

`{ verbs, pixels, maskingProven, request, maxSessions, exclusiveResource? }`

- `verbs`: the subset of `navigate click fill press select check hover scroll back wait` you implement. The agent is only offered these. Recordings that need a verb you lack become fuzzy (`agent-only-driver`).
- `pixels`: `observe({ pixels: true })` returns a PNG. `maskingProven`: you guarantee secrets are masked in that PNG. Screenshots reach models only when the session is untainted, or the PNG is `masked` **and** `maskingProven`.
- `request`: the session implements `request()` (HTTP calls with the session's cookies).
- `maxSessions`: concurrent sessions this driver supports. The runner never exceeds it.
- `exclusiveResource`: a string. All sessions of all drivers that declare the same string run one at a time (a single shared device, a single account).

### `observe()`

Returns an `Observation`:

| Field | Contract |
|---|---|
| `nodes` | Flat, in document order. Each node: `ref`, `role`, `name`, optional `text`, `value`, `url`, `level`, `testId`, `states`, `parentRef`, `depth`. Use ARIA role names. |
| `ref` | Unique within the observation. **Include the observation revision** (for example `r3:e12`): a ref from an older revision must be rejected with `STALE_REF` by `perform`. A ref is valid until the next `observe()`. |
| `revision` | Strictly increasing per session. |
| `route` | `pathname + search`. |
| `busy` | True while anything loads (spinner, progress bar, navigation in flight). A busy page is never judged. |
| `tainted` | True for the rest of the session once a `{secret}` value was typed, even if the action failed. |
| `treeText` | `renderTree(nodes, { refs: true })`. |
| `treeHash` | `treeHash(nodes)` from `@ai-bdd/sdk`. Must be identical for identical pages and change when the page changes. |
| `screenshot` | Only when asked for. `{ png, sha256, masked }`. |

Never put a secret value in a node. If the page echoes one (a password field exposing its value), strip it in the driver. The redactor is only the backstop.

### `perform(action)`

Actions use `ref` targets: `{ verb: 'click', target: { ref } }`, `{ verb: 'fill', target: { ref }, value }` and so on. `value` is a `ValueSource`: `{ literal }`, `{ param }` or `{ secret }`; resolve it with `SessionOptions.resolveValue(value)` at the moment of typing. Never log or store the result.

Rules:

- **Never throw for ordinary failures.** Return `{ ok: false, error: { code, message, retryable } }` with `STALE_REF`, `TARGET_NOT_FOUND`, `POLICY_DENIED`, `VERB_UNSUPPORTED`, `DRIVER_ERROR` (retryable) or `DRIVER_UNAVAILABLE`. Throw only for a broken driver.
- **Enforce policy.** Pass every URL through `checkNavigation(url, baseURL, policy)` (from `@ai-bdd/sdk`) and return `POLICY_DENIED` when it fails. Honor `policy.denyVerbs`. If your platform can navigate by itself (links, redirects, popups), block disallowed destinations there too.
- **Taint** the session when a `{secret}` is used.
- Report `navigatedTo` when the action changed the URL.

### Session lifecycle

`openSession(opts)` receives `SessionOptions { scenarioId, baseURL?, policy, resolveValue, recordVideo? }`. Sessions must be **isolated**: state set in one is invisible in another. `close()` releases the session; for adopted sessions (see [sdk.md](sdk.md)) it must not close what the host owns. `selfCheck()` returns `{ ok, problems }` and powers `ai-bdd doctor`. `dispose()` releases driver-wide resources.

## Writing a driver

This example drives a toy in-memory app with a heading, a counter and two buttons. It shows the whole surface: refs with a revision, `observe`, `perform` with policy and stale-ref handling, and the factory.

```ts check
import { checkNavigation, renderTree, treeHash } from '@ai-bdd/sdk';
import type {
  ActionOutcome,
  Driver,
  DriverAction,
  DriverCapabilities,
  DriverFactory,
  DriverSession,
  Observation,
  ObservedNode,
  SessionOptions,
} from '@ai-bdd/sdk/contracts';

const CAPABILITIES: DriverCapabilities = {
  verbs: ['navigate', 'click'],
  pixels: false,
  maskingProven: false,
  request: false,
  maxSessions: 4,
};

function fail(code: 'STALE_REF' | 'TARGET_NOT_FOUND' | 'POLICY_DENIED' | 'VERB_UNSUPPORTED', message: string): ActionOutcome {
  return { ok: false, error: { code, message, retryable: false } };
}

class CounterSession implements DriverSession {
  readonly id: string;
  readonly driverId = 'counter';
  readonly driverVersion = '1.0.0';
  readonly capabilities = CAPABILITIES;
  private readonly options: SessionOptions;
  private count = 0;
  private revision = 0;
  private route = '/';

  constructor(id: string, options: SessionOptions) {
    this.id = id;
    this.options = options;
  }

  /** The page as a flat, document-ordered list. Refs carry the revision, so older refs are recognizably stale. */
  private nodes(): ObservedNode[] {
    const ref = (i: number): string => `r${this.revision}:e${i}`;
    if (this.route !== '/') {
      return [{ ref: ref(0), role: 'heading', name: 'Not found', level: 1, states: {}, depth: 0 }];
    }
    return [
      { ref: ref(0), role: 'heading', name: 'Counter', level: 1, states: {}, depth: 0 },
      { ref: ref(1), role: 'status', name: `Count: ${this.count}`, states: {}, depth: 0 },
      { ref: ref(2), role: 'button', name: 'Increment', states: {}, depth: 0 },
      { ref: ref(3), role: 'button', name: 'Reset', states: { disabled: this.count === 0 }, depth: 0 },
    ];
  }

  async observe(): Promise<Observation> {
    this.revision += 1;
    const nodes = this.nodes();
    return {
      revision: this.revision,
      route: this.route,
      nodes,
      busy: false,
      tainted: false,
      treeText: renderTree(nodes, { refs: true }),
      treeHash: treeHash(nodes),
    };
  }

  async perform(action: DriverAction): Promise<ActionOutcome> {
    if (action.verb === 'navigate') {
      const checked = checkNavigation(action.url, this.options.baseURL, this.options.policy);
      if (!checked.ok) return fail('POLICY_DENIED', checked.reason);
      const url = new URL(checked.url);
      this.route = url.pathname + url.search;
      return { ok: true, navigatedTo: checked.url };
    }
    if (action.verb !== 'click') return fail('VERB_UNSUPPORTED', `counter driver cannot ${action.verb}`);
    const match = /^r(\d+):e(\d+)$/.exec(action.target.ref);
    if (match === null || Number(match[1]) !== this.revision) {
      return fail('STALE_REF', `ref ${action.target.ref} is not from the latest observation`);
    }
    const node = this.nodes()[Number(match[2])];
    if (node === undefined || node.role !== 'button') return fail('TARGET_NOT_FOUND', `no button for ${action.target.ref}`);
    if (node.name === 'Increment') this.count += 1;
    else if (node.states.disabled !== true) this.count = 0;
    return { ok: true };
  }

  async close(): Promise<void> {
    // Nothing to release: the state lives in this object.
  }
}

/** A driver for a toy in-memory app: a heading, a counter and two buttons. */
export function counterDriver(): DriverFactory {
  return {
    id: 'counter',
    async create(): Promise<Driver> {
      let sessions = 0;
      return {
        id: 'counter',
        version: '1.0.0',
        capabilities: CAPABILITIES,
        async openSession(options: SessionOptions): Promise<DriverSession> {
          sessions += 1;
          return new CounterSession(`counter-${sessions}`, options);
        },
        async selfCheck() {
          return { ok: true, problems: [] };
        },
        async dispose() {},
      };
    },
  };
}
```

Register it like any driver (`drivers: { counter: counterDriver() }`), or publish a package that exports `createDriverFactory(options)` and use it from JSON config with `{ "use": "my-driver-package" }`.

### Checklist for a real driver

1. **Accessible names.** Map the platform's accessibility tree to ARIA-like roles and names. Recordings select by role, name and named ancestors; whatever you expose must be stable between runs.
2. **Busy detection.** If you cannot tell when the app is loading, steps judge half-rendered screens. Report `busy` for every loading signal you can see.
3. **Stable ordering and hash.** Document order, no random attributes, no timestamps in names you control.
4. **Isolation.** One scenario, one session, no shared state. Declare `exclusiveResource` if the world cannot be shared.
5. **Policy in depth.** Block disallowed navigation inside the platform, not just in `navigate`.
6. **Secrets.** Taint on use; never expose typed values; only claim `maskingProven` if you can show it with a test.
7. **Version.** Bump the major version when a change would invalidate recordings (different roles, names or ref semantics).

### Conformance kit

Inside this repository, `packages/sdk/test/kit/driver-conformance.ts` exports `runDriverConformance(name, makeFactory, options)`, a vitest suite that checks capabilities, observation shape and `treeHash` stability, stale-ref rejection, navigation policy (`javascript:`, `data:`, `file:`, off-host, credentials), taint after secret fills, busy detection, session isolation and `request()`. The app-level tests expect the Acme app (`startAcmeApp` from `@ai-bdd/testing`), so a driver for another platform adapts the same assertions. The kit is not published; copy it or import it relatively in a workspace.

```ts
import { runDriverConformance } from '../../sdk/test/kit/driver-conformance.ts';
import { myDriver } from '../src/index.ts';

runDriverConformance('my driver', ({ appUrl }) => myDriver({ baseURL: appUrl }), { appUrl: process.env.ACME_URL });
```
