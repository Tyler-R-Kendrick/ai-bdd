# @ai-bdd/driver-cua

An ai-bdd driver for [Cua Driver](https://cua.ai/docs/cua-driver), the open-source (MIT) driver from [Cua](https://cua.ai/) that lets an agent operate native apps and browsers on macOS, Windows and Linux. ai-bdd starts `cua-driver mcp`, reads each window through its accessibility tree (`get_window_state`) and acts with its input tools (`click`, `type_text`, `press_key`, `scroll`).

> Status: exercised against Cua Driver 0.34 on Linux (X11, AT-SPI) driving Chromium. The macOS and Windows paths use the same tools but have not been run.

## Install

1. Install Cua Driver: <https://cua.ai/docs/cua-driver/quickstart>. Check it with `cua-driver --version` and `cua-driver call health_report` (or `ai-bdd doctor`).
2. `pnpm add -D @ai-bdd/driver-cua`.

On Linux the driver needs an X11 display, a window manager (Cua Driver foregrounds windows), the AT-SPI bus, and an application that exposes its accessibility tree. Chromium does so with `--force-renderer-accessibility`.

## Configure

```js
// ai-bdd.config.mjs
export default {
  baseURL: 'http://localhost:3000',
  drivers: {
    desktop: {
      use: '@ai-bdd/driver-cua',
      options: {
        kind: 'browser',
        launch: {
          command: '/usr/bin/chromium',
          args: ['--user-data-dir={profile}', '--force-renderer-accessibility', '--no-first-run', '{url}'],
        },
      },
    },
  },
  defaultDriver: 'desktop',
};
```

Each session starts its own copy of the application (`{profile}` becomes a fresh temporary directory, `{url}` the `baseURL`) and quits it when the session closes. To drive an application that is already running, use `window` instead of `launch`:

```js
options: { kind: 'app', window: { title: '^Calculator$' } }
```

| Option | Default | Meaning |
|---|---|---|
| `kind` | `app` | `browser` adds the `navigate` and `back` verbs (through the address bar) and observes the page content only. |
| `launch` | | `{ command, args?, env?, cwd? }`. One process per session. `{url}` and `{profile}` are replaced in `args`. |
| `window` | | `{ title?, app? }` (regular expressions). Selects a running window, or narrows the windows of the launched process. One of `launch` and `window` is required. |
| `scope` | `content` for browsers, else `window` | Observe only the web content, or the whole window. |
| `delivery` | `auto` | `auto`: background input first, foreground once the app refuses it (Chromium and Electron do). `background`, `foreground`: always. |
| `cuaDriver` | `{ command: 'cua-driver', args: ['mcp'] }` | How to start Cua Driver. |
| `titleSuffix` | common browser names | Regular expression removed from the window title to form the route. |
| `startTimeoutMs` / `treeTimeoutMs` / `actionTimeoutMs` | 20000 / 3000 / 10000 | Window appearance, one accessibility-tree walk, one input action. |
| `settleMs` | 100 | Pause after an input action. |
| `maxSessions` | 1 | Real input is global to the desktop, so sessions share one screen. |

In a JS config you can also import the factory: `import { cua } from '@ai-bdd/driver-cua'` and put `cua({ ... })` under `drivers`.

## What the driver gives ai-bdd

- **Observations** are the window's accessibility tree with ARIA-style roles (`button`, `textbox`, `checkbox`, `link`, `heading`, ...), accessible names and states (`checked`, `disabled`, `selected`). Layout containers without a name are pruned. Refs look like `r<revision>:e<index>` and are valid for one observation.
- **Verbs**: `click`, `fill`, `press`, `check`, `scroll`, `wait`, and for browsers `navigate` and `back`. `hover`, `select` and `request` are not offered, so steps needing them fall back to the agent.
- **Recordings** replay by role and accessible name, never by coordinates.

## Limits

- **Observation takes about a second** (an accessibility-tree walk), much slower than a DOM snapshot. The text of live regions (`status`, `log`, `timer`, `marquee`) is left out of the settle hash, so a ticking clock does not keep the screen from settling; checks and the judge still read it.
- **The page URL is not observable.** `route` is the window title (browser suffix removed), `url` is absent. Route assertions are not available; role and name assertions are.
- **Foreground input moves the focus.** Chromium refuses background input to an unfocused renderer, so `auto` delivery takes the foreground after the first refusal; scenarios must not share the desktop with a person using it.
- **Navigation policy** (`policy.allowHosts`) is enforced on the `navigate` verb only. A click on a link navigates by itself; confine the browser at the platform level (proxy, locked-down VM) if that matters.
- **Secrets are typed as real key events.** The session is tainted, so screenshots (never marked masked) do not reach a model. Keep Cua Driver's trajectory recording and Computer History disabled for runs that type secrets; they would capture the typed text.
- **Disabled controls** may be missing from the tree (Cua Driver lists actionable elements).
- The environment given to Cua Driver and to launched apps carries only what a desktop process needs (display, session and accessibility buses, locale, paths) plus `launch.env`; provider keys and test secrets stay out.

## Test it

`pnpm test:unit packages/driver-cua` runs the mapping tests everywhere and, when `cua-driver`, an X display and Chromium are present, the real-product suite. `pnpm test:acceptance cua` runs the characterization and replay flows through Cua Driver. CI's `cua` job provides the desktop.
