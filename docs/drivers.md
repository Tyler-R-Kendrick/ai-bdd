# Drivers

A **driver** gives ai-bdd a way to see and operate one application. It is the only part of the system that touches the app. Everything else (agent, recorder, asserter, judge) works on what a driver returns: an **observation** (an accessibility-style tree) and the **outcome** of an action.

| Driver | Package | Use |
|---|---|---|
| `playwright` | `@ai-bdd/driver-playwright` | Real browsers (Chromium default). The driver for web apps, and the only one that ships. |
| Cua Driver | not shipped; you wrap [Cua Driver](https://cua.ai/docs/cua-driver) (`cua-driver`) in a `createDriverFactory` package | Native desktop apps and browsers on macOS, Windows and Linux, operated in the background. See [(b) Cua Driver](#b-cua-driver-cuaai). |
| Yours | any package that exports `createDriverFactory(options)` | A browser-use agent runtime, a native or mobile bridge, another screen-driving engine. See [Plugging in a driver](#plugging-in-a-driver). |

Drivers are always real: they operate a real application. (`@ai-bdd/testing` has an in-memory double of the demo app for ai-bdd's own tests; it is not a product mode, see [sdk.md](sdk.md#test-doubles).)

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

In `ai-bdd.config.json` (or any JS config), name a package that exports `createDriverFactory(options)`:

```json
{ "drivers": { "web": { "use": "@ai-bdd/driver-playwright", "options": { "browser": "chromium" } } }, "defaultDriver": "web" }
```

`use` may also be a `./relative/file.mjs` resolved from the project root. [Plugging in a driver](#plugging-in-a-driver) shows both forms for several engines.

Which driver runs a scenario: the `driver` directive in its source chunks, else `--driver <name>`, else `defaultDriver` (the only configured driver if there is just one). The names are your config keys; recordings are filed under the driver's **id** (for example `playwright`): `.ai-bdd/recordings/<driverId>/<scenarioId>.json`. Switching drivers means characterizing again, and a change of the driver's **major** version invalidates its recordings.

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

## Plugging in a driver

A driver is a config entry. ai-bdd does not care what is behind it, only that it implements the [driver interface](#the-driver-interface). Every driver is plugged in one of two equivalent ways:

- **`{ use: '<package or ./file>', options }`**: ai-bdd imports the package (resolved from the project root) and calls its `createDriverFactory(options)`. It works in `.json`, `.mjs` and `.js` configs, so the choice of engine can be a one-line JSON change.
- **A factory object**: import the factory yourself and put it under `drivers`. This is the only form a typed `.ts` config accepts (`defineConfig` types `drivers` as `DriverFactory` values).

The examples below use the built-in Playwright driver, [Cua Driver](https://cua.ai/) through a driver package you write, and one **hypothetical** package, `my-browser-use-driver`, a placeholder for whatever browser-use runtime package you publish. ai-bdd ships only the Playwright driver; neither Cua Driver nor `my-browser-use-driver` has an ai-bdd package yet. Everything else in the config (docs, models, secrets, policy, `baseURL`) stays the same when you swap the driver.

### (a) The built-in Playwright driver

```js
// ai-bdd.config.mjs (or .json): the package form
export default {
  baseURL: 'http://localhost:3000',
  drivers: { web: { use: '@ai-bdd/driver-playwright', options: { browser: 'chromium', headless: true } } },
  defaultDriver: 'web',
};
```

```ts check
// ai-bdd.config.ts: the factory form
import { defineConfig } from '@ai-bdd/sdk';
import { playwright } from '@ai-bdd/driver-playwright';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  drivers: { web: playwright({ browser: 'chromium', headless: true }) },
  defaultDriver: 'web',
});
```

### (b) Cua Driver (cua.ai)

[Cua Driver](https://cua.ai/docs/cua-driver) is a specific product from [Cua](https://cua.ai/): an open-source (MIT) driver that lets an agent operate native apps and browsers on macOS, Windows and Linux in the background, without taking the system cursor or focus where the platform allows. It is reached through the `cua-driver` CLI (`cua-driver call <tool>`) or as an MCP server over stdio (`cua-driver mcp`); install it from the [Cua Driver quickstart](https://cua.ai/docs/cua-driver/quickstart). Its tools include `get_window_state`, `click`, `type_text`, `press_key` and `invoke_menu`; run `cua-driver list-tools` and `cua-driver describe <tool>` for the exact names and input schemas, and see the [CLI reference](https://cua.ai/docs/cua-driver/reference/cli) and [Connecting an agent](https://cua.ai/docs/cua-driver/guides/connect-your-agent).

ai-bdd does not ship a Cua Driver package. To use it you write a small driver package (your own repository, or a `./drivers/cua.mjs` file in the project) whose `createDriverFactory(options)` returns a `DriverFactory` that translates ai-bdd's `observe()` and `perform(action)` into Cua Driver tool calls. The mapping is the one in [Screenshot-and-coordinate drivers](#screenshot-and-coordinate-drivers-honest-limits): turn the window state Cua Driver reports into `ObservedNode`s with a role and an accessible name, and turn `click`, `fill` and `press` on those refs into Cua Driver calls. Check what `get_window_state` returns on your platform before relying on it; ai-bdd steps whose targets have no role or name stay `fuzzy`.

```js
// ai-bdd.config.mjs: the package form (the package is the one you wrote around Cua Driver)
export default {
  drivers: {
    desktop: { use: './drivers/cua.mjs', options: { app: 'Acme', command: 'cua-driver' } },
  },
  defaultDriver: 'desktop',
  // models, secrets ... unchanged
};
```

```js
// ai-bdd.config.mjs: the factory form (a JS config can await the factory)
import { createDriverFactory } from './drivers/cua.mjs';

export default {
  drivers: { desktop: await createDriverFactory({ app: 'Acme', command: 'cua-driver' }) },
  defaultDriver: 'desktop',
};
```

`app` and `command` are options of the package you write, not of Cua Driver or ai-bdd. Run `ai-bdd doctor` first (it calls the driver's `selfCheck`, which should verify that `cua-driver` is installed and has its OS permissions), then `ai-bdd run --driver desktop` or set `defaultDriver`. Recordings are filed under the driver's id (`.ai-bdd/recordings/<driverId>/`), so characterizing on `desktop` does not touch the recordings made on `playwright`. Desktop windows are one shared resource, so declare `exclusiveResource` and `maxSessions: 1` and scenarios run one at a time. Confine navigation yourself: Cua Driver operates real apps and does not know `policy.allowHosts`.

### (c) A browser-use driver package

A browser-use style runtime drives a browser through the DevTools protocol and usually can report the page's accessibility tree and element handles, which is exactly what ai-bdd records against. With a hypothetical `my-browser-use-driver`:

```js
// ai-bdd.config.mjs: the package form
export default {
  baseURL: 'http://localhost:3000',
  drivers: { agentic: { use: 'my-browser-use-driver', options: { headless: true, cdpUrl: 'ws://localhost:9222' } } },
  defaultDriver: 'agentic',
};
```

```js
// ai-bdd.config.mjs: the factory form
import { createDriverFactory } from 'my-browser-use-driver';

export default {
  baseURL: 'http://localhost:3000',
  drivers: { agentic: await createDriverFactory({ headless: true, cdpUrl: 'ws://localhost:9222' }) },
  defaultDriver: 'agentic',
};
```

You can keep several drivers in one config (`drivers: { web: ..., desktop: ... }`) and pick per scenario with the `driver` directive in the doc or per run with `--driver <name>`; `-c <file>` selects a different config file altogether (`ai-bdd -c ai-bdd.cua.config.mjs run`).

### What a driver package must export

| Export | Contract |
|---|---|
| `createDriverFactory(options)` | Required by the `{ use }` form. Receives the `options` object from the config (or `{}`); validate it and throw an `AiBddError('CONFIG_INVALID', ...)` for unknown or ill-typed keys. Returns a `DriverFactory` (or a promise of one). Do no heavy work here: launch browsers and connect to devices in `factory.create(ctx)` or on first `openSession`. |
| the `DriverFactory` | `{ id, create(ctx) → Driver }`. `id` is the recording directory name: short, stable, filesystem-safe. `ctx` is `{ projectRoot, baseURL?, policy, artifactsDir }`. |
| the `Driver` | `{ id, version, capabilities, openSession(opts), selfCheck(), dispose() }`. Bump the **major** `version` when a change would invalidate recordings. |
| `capabilities` | `{ verbs, pixels, maskingProven, request, maxSessions, exclusiveResource? }`, honest and static (see [Capabilities](#capabilities)). The agent is offered only your `verbs`; the runner never exceeds `maxSessions`; a recording that needs a verb you lack becomes fuzzy. |
| sessions | `DriverSession { id, driverId, driverVersion, capabilities, observe(), perform(action), request?(), close() }`, isolated from each other. |

A driver package may also export convenience constructors (Playwright exports `playwright(opts)` next to `createDriverFactory`), but the config loader calls only `createDriverFactory`. Declare `@ai-bdd/sdk` as a peer dependency and import types from `@ai-bdd/sdk/contracts`.

Typical capability sets (illustrative, set them to what your implementation really does):

| | `verbs` | `pixels` | `maskingProven` | `request` | `maxSessions` | `exclusiveResource` |
|---|---|---|---|---|---|---|
| Playwright | all ten | `true` | `true` | `true` | 8 | none |
| Screen driver, one shared screen | `navigate click fill press scroll hover wait` | `true` | `false` | `false` | 1 | `'screen'` |
| Browser-use over CDP | the ten, if the runtime has them | `true` | `false` until you can show masking | `false` | a few | none |

### Screenshot-and-coordinate drivers (honest limits)

ai-bdd's action surface is **ref-based**: the agent picks a node from `observe()` and the driver performs `click` or `fill` on that ref. A screen-driving backend (Cua Driver, for example) speaks screenshots, window state and `(x, y)` or element indexes. The driver is the bridge:

1. **`observe()` must still return nodes.** Per observation, take a screenshot and produce `ObservedNode`s with an ARIA role and an accessible name (and `level`, `states`, `url` where you can). The best source is the platform's accessibility tree (CDP accessibility tree, UIA, AX, AT-SPI) read at the same moment as the screenshot, keeping each node's bounding box in the session. If you only have pixels, a vision model can propose labelled regions, but that is a model call inside your driver on every observation, and its labels will wobble from run to run.
2. **Refs carry the revision (`r<rev>:e<n>`) and map to boxes.** A `click` on a ref becomes a click at the centre of its box; `fill` is click, select all, type (resolve `{secret}` values at the moment of typing and taint the session); `hover` moves the mouse; `scroll` is a wheel event at a point; `press` sends the key; `navigate` and `back` use the browser or the OS. Reject refs of an older revision with `STALE_REF`. Verbs the backend cannot do reliably (`select` on a native dropdown, `check`) should be left out of `capabilities.verbs`.
3. **Screenshots are evidence, not the oracle.** Set `pixels: true` to let `observe({ pixels: true })` return a PNG. They reach a model (the judge, with `judge.vision`) only while the session is untainted or when the PNG is `masked` **and** `maskingProven`. A coordinate-based backend cannot mask password fields unless you draw the masks yourself; leave `maskingProven: false` unless a test proves it.

What this does and does not buy you:

- **Recordings replay by selector, not by coordinate.** A recorded action stores the target's role, accessible name, named ancestors and index, never a pixel position. On replay ai-bdd observes, resolves the selector to a fresh ref, and your driver translates that ref to the current coordinates. Layout changes therefore do not break a replay as long as the role and name are still there.
- **Coordinate-only targets are fuzzy.** If the node the agent acted on has no role or accessible name (an unlabelled region from a vision pass, a canvas), there is nothing stable to select, the step gets the reason `coordinate-action`, and it keeps running through the agent (model calls on every run) instead of replaying. Fixing it means exposing a real name (an accessibility tree, a label), not tuning coordinates.
- **Missing verbs make steps fuzzy.** A step that needs a verb outside your `verbs` is `agent-only-driver`.
- **No `busy` signal, no determinism.** If the screen cannot tell when it is loading, set `busy` from what you can see (a spinner node, a pending navigation); otherwise steps judge half-rendered screens and checks will not prove themselves.
- **Navigation policy is yours to enforce.** `checkNavigation` guards the `navigate` verb, but a click on a link navigates by itself. A screen-driving backend must be confined at the platform level (a proxy, a browser policy, a locked-down VM) to the hosts in `policy.allowHosts`.
- **Cost and speed.** The computer-use model that sits inside such a driver is separate from ai-bdd's own `act` model. Keep them from fighting: either ai-bdd's agent decides (the driver is only hands and eyes), or the driver embeds its own planner and exposes one coarse verb, in which case recordings will not be fine-grained.

The skeleton below shows the bridge for a hypothetical `ScreenBackend`. It typechecks against the contracts; the backend and the perception layer are yours.

```ts check
import { checkNavigation, renderTree, sha256Hex, treeHash } from '@ai-bdd/sdk';
import { AiBddError } from '@ai-bdd/sdk/contracts';
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a computer-use harness gives you: pixels in, mouse and keyboard out, plus some form of perception. */
interface ScreenBackend {
  screenshot(): Promise<Uint8Array>;
  /** Labelled regions with pixel boxes: from the accessibility tree read next to the screenshot, or from a vision pass. */
  perceive(): Promise<Array<{ role: string; name: string; box: Box; level?: number }>>;
  click(x: number, y: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(x: number, y: number, dy: number): Promise<void>;
  openUrl(url: string): Promise<void>;
  close(): Promise<void>;
}

declare function connectBackend(options: { display: string }): Promise<ScreenBackend>;

const CAPABILITIES: DriverCapabilities = {
  verbs: ['navigate', 'click', 'fill', 'press', 'scroll', 'hover', 'wait'],
  pixels: true,
  maskingProven: false,
  request: false,
  maxSessions: 1,
  exclusiveResource: 'screen',
};

const centre = (b: Box): [number, number] => [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];

class ScreenSession implements DriverSession {
  readonly id: string;
  readonly driverId = 'my-screen';
  readonly driverVersion = '1.0.0';
  readonly capabilities = CAPABILITIES;
  private readonly backend: ScreenBackend;
  private readonly options: SessionOptions;
  private readonly boxes = new Map<string, Box>();
  private revision = 0;
  private route = '/';
  private tainted = false;

  constructor(id: string, backend: ScreenBackend, options: SessionOptions) {
    this.id = id;
    this.backend = backend;
    this.options = options;
  }

  async observe(opts?: { pixels?: boolean }): Promise<Observation> {
    this.revision += 1;
    const found = await this.backend.perceive();
    this.boxes.clear();
    const nodes: ObservedNode[] = found.map((f, i) => {
      const ref = `r${this.revision}:e${i}`;
      this.boxes.set(ref, f.box);
      const node: ObservedNode = { ref, role: f.role, name: f.name, states: {}, depth: 0 };
      if (f.level !== undefined) node.level = f.level;
      return node;
    });
    const observation: Observation = {
      revision: this.revision,
      route: this.route,
      nodes,
      busy: found.some((f) => f.role === 'progressbar'),
      tainted: this.tainted,
      treeText: renderTree(nodes, { refs: true }),
      treeHash: treeHash(nodes),
    };
    if (opts?.pixels === true) {
      const png = await this.backend.screenshot();
      observation.screenshot = { png, sha256: sha256Hex(png), masked: false };
    }
    return observation;
  }

  async perform(action: DriverAction): Promise<ActionOutcome> {
    if (this.options.policy.denyVerbs.includes(action.verb)) return this.fail('POLICY_DENIED', `${action.verb} is denied by policy`);
    if (action.verb === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, Math.min(action.ms, 5000)));
      return { ok: true };
    }
    if (action.verb === 'navigate') {
      const checked = checkNavigation(action.url, this.options.baseURL, this.options.policy);
      if (!checked.ok) return this.fail('POLICY_DENIED', checked.reason);
      await this.backend.openUrl(checked.url);
      this.route = new URL(checked.url).pathname;
      return { ok: true, navigatedTo: checked.url };
    }
    if (action.verb === 'back' || action.verb === 'select' || action.verb === 'check') {
      return this.fail('VERB_UNSUPPORTED', `this driver cannot ${action.verb}`);
    }
    if (action.verb === 'press' && action.target === undefined) {
      await this.backend.key(action.key);
      return { ok: true };
    }
    if (action.verb === 'scroll' && action.target === undefined) {
      await this.backend.scroll(0, 0, action.direction === 'down' ? 600 : -600);
      return { ok: true };
    }
    const ref = action.target?.ref ?? '';
    const box = this.boxes.get(ref);
    if (box === undefined) return this.fail('STALE_REF', `ref ${ref} is not from the latest observation`);
    const [x, y] = centre(box);
    switch (action.verb) {
      case 'click':
        await this.backend.click(x, y);
        break;
      case 'hover':
        await this.backend.moveMouse(x, y);
        break;
      case 'scroll':
        await this.backend.scroll(x, y, action.direction === 'down' ? 600 : -600);
        break;
      case 'press':
        await this.backend.click(x, y);
        await this.backend.key(action.key);
        break;
      case 'fill':
        if ('secret' in action.value) this.tainted = true; // taint first, even if typing fails
        await this.backend.click(x, y);
        await this.backend.key('ctrl+a');
        await this.backend.typeText(this.options.resolveValue(action.value));
        break;
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    // The screen is shared by every session of this driver; the driver's dispose() releases it.
  }

  private fail(code: 'STALE_REF' | 'POLICY_DENIED' | 'VERB_UNSUPPORTED', message: string): ActionOutcome {
    return { ok: false, error: { code, message, retryable: false } };
  }
}

/** The export a `{ use: 'my-screen-driver', options }` config entry calls. */
export function createDriverFactory(options: unknown): DriverFactory {
  const display = (options as { display?: unknown } | null)?.display;
  if (typeof display !== 'string') throw new AiBddError('CONFIG_INVALID', 'my-screen-driver: options.display must be a string');
  return {
    id: 'my-screen',
    async create(): Promise<Driver> {
      const backend = await connectBackend({ display });
      let sessions = 0;
      return {
        id: 'my-screen',
        version: '1.0.0',
        capabilities: CAPABILITIES,
        async openSession(opts: SessionOptions): Promise<DriverSession> {
          sessions += 1;
          return new ScreenSession(`my-screen-${sessions}`, backend, opts);
        },
        async selfCheck() {
          try {
            await backend.screenshot();
            return { ok: true, problems: [] };
          } catch (err) {
            return { ok: false, problems: [`cannot capture the screen: ${err instanceof Error ? err.message : String(err)}`] };
          }
        },
        async dispose() {
          await backend.close();
        },
      };
    },
  };
}
```

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

Validate a driver package with the shared conformance kit. It lives in this repository at `packages/sdk/test/kit/driver-conformance.ts` and exports `runDriverConformance(name, makeFactory, options)`, a vitest suite that checks capabilities, observation shape and `treeHash` stability, stale-ref rejection, navigation policy (`javascript:`, `data:`, `file:`, off-host, credentials), taint after secret fills, busy detection, session isolation and `request()`. The same kit runs against the Playwright driver in this repository (`packages/driver-playwright/test/conformance.test.ts`). The kit is not published as a package.

To run it for your driver package:

1. Work in a checkout of this repository (add your package as a workspace package under `packages/`, or keep it next to the checkout and import the kit by relative path), with `pnpm install` done. The kit needs `vitest`, which the workspace provides.
2. Start the Acme demo app that the app-level tests drive: `startAcmeApp` from `@ai-bdd/testing` returns `{ url, close() }`. Without an `appUrl` the capability, policy-denial and identity tests still run and the app-dependent ones are skipped, so a skipped suite is not a pass.
3. Write one test file that hands the kit a factory-maker, then run it with `pnpm exec vitest run <your test file>` from the repository root. Give slow backends room with `vi.setConfig({ testTimeout: 60_000 })`.

```ts
import { afterAll, vi } from 'vitest';
import { startAcmeApp } from '@ai-bdd/testing';
import { runDriverConformance } from '../../sdk/test/kit/driver-conformance.ts';
import { createDriverFactory } from '../src/index.ts'; // the same export the config's { use } entry calls

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const app = await startAcmeApp({});
afterAll(() => app.close());

runDriverConformance('my-screen-driver', () => createDriverFactory({ display: ':1' }), { appUrl: app.url });
```

The app-level cases look for Acme roles and names (`/login`, `/settings/billing`, `/todos`, `/forms/two`, `/slow`, `/notes`). A driver that perceives the page through a vision model may not reproduce them exactly: treat the failures as information about how stable your perception is, since recordings depend on exactly that stability. `options` also takes `testToken`, `adminPassword`, `allowHosts` and `slowMs` for apps that differ from the defaults. If the kit does not fit your platform, copy it and adapt the assertions; the contracts it checks are the ones listed above in this document.

Before publishing, also run `ai-bdd doctor` and one real characterize-then-replay of a scenario against your app with your driver plugged in through the config; the second run must report zero model calls for the steps you expect to be deterministic.
