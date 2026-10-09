# Drivers

A driver observes and controls one UI surface through a session. Every driver implements the
same `Driver`/`DriverSession` contract, declares its capabilities and its concurrency, and
passes the driver conformance suite (`packages/conformance`).

| Driver | Package | Surface | Pixels | Native predicates | Exclusive resource |
| --- | --- | --- | --- | --- | --- |
| Playwright | `@ai-bdd/driver-playwright` | Browser (chromium/firefox/webkit) | yes | no | no |
| e2e | `@ai-bdd/driver-e2e` | Web and iOS/Android through `e2e mcp` | yes | no | no |
| Cua | `@ai-bdd/driver-cua` | Native desktop windows through `cua-driver mcp` | yes | yes (`verify_state`) | `desktop:<display>` |
| fake | `@ai-bdd/driver-fake` | In-memory fixture model | deterministic PNGs | no | no |

## Playwright

```ts
playwright({ browser: 'chromium', baseURL: 'http://localhost:3000', headless: true, video: false })
```

- one `BrowserContext` per session, which gives isolation;
- the tree comes from `page.locator('body').ariaSnapshot()` parsed into observed nodes; refs are
  `r<revision>-<n>` and map to `getByRole(role, { name, exact: true })` with `nth()`
  disambiguation recorded at observation time;
- screenshots mask password inputs and `[data-ai-bdd-secret]` elements; `maskingProven` is true
  when every observed `input[type=password]` was masked;
- navigation is checked against `policy.allowHosts`;
- settle waits for `document.readyState === 'complete'` and for no in-flight requests, ignoring
  websockets and `EventSource`.

## e2e (web and mobile)

```ts
e2e({ config: './e2e.config.ts', target: 'ios', maxSessions: 4 })
```

Spawns `npx e2e mcp --config <path> --target <t> --max-sessions <n>` (verified flag names, see
[the log](verification-log.md#v6--f-e3--e2e-mcp-catalog)) and talks to it over MCP stdio. The
four MCP tools are `open_session`, `tools`, `call` and `close_session`; the catalog of the
session determines the available verbs, so a verb the target does not support is simply absent.

e2e is a **driver** here, not the engine: `e2e mcp` is raw-only, so the agent loop, the caches,
the checks and the judge all live in ai-bdd. See
[FAQ](faq.md#why-not-use-e2e-as-the-base) for the `@ai-bdd/e2e-host` integration, which is the
other, separate way e2e is used.

## Cua (native desktop)

```ts
cua({ app: 'com.example.Billing', windowTitle: 'Billing', mode: 'mcp', backgroundOnly: false })
```

- modes: `mcp` (spawn `cua-driver mcp`), `daemon` (attach to a running `cua-driver serve`) and
  `call` (one-shot debugging through `cua-driver call`);
- the target window is resolved through `list_apps`/`list_windows` and must be inside
  `policy.cua.allowApps`;
- `get_window_state` returns snapshot-bound element tokens plus an optional accessibility tree
  and screenshot; tokens are only valid against the newest observation;
- `verify_state` evaluates 1–8 predicates deterministically against one window. `unknown` never
  implies success, so an unknown result counts as a failure;
- because `type_text` targets the foreground application, the driver declares an exclusive
  resource and one session unless `backgroundOnly` is set, in which case every action must use
  `delivery_mode: 'background'` with a window target and the foreground-only verbs are refused.

## fake (CI)

```ts
fake({ modelPath: 'fixtures/app/model.json', fault: { spinnerMs: 0, flakyNode: false } })
```

An in-memory state machine over `fixtures/app/model.json`, generated from the same screen
definitions the fixture web app renders from, so both describe identical UIs. Screenshots are
deterministic PNGs rendered from the node list (text is drawn as hashed pixel blocks). Fault
injection covers spinners, flaky nodes, secure fields and duplicate forms — the levers behind
M5, M6, M10 and M11.

## Writing a driver

Implement `Driver` and `DriverSession` from `@ai-bdd/contracts`:

- `observe({ pixels })` returns an `Observation` (nodes, tree hash, optional screenshot, taint,
  settle state);
- `perform(action)` executes one verb and reports policy/taint effects;
- declare `capabilities` honestly: the act agent is only offered verbs you declare;
- declare `concurrency`, and set `exclusiveResource` when two sessions would corrupt each other;
- `selfCheck()` must fail with a list of missing tools rather than throwing
  (`DRIVER_INCOMPATIBLE`).

Then run the conformance suite:

```ts
import { runDriverConformance } from '@ai-bdd/conformance';
runDriverConformance(fake, { appUrl: 'http://localhost:0' });
```
