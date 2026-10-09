# @ai-bdd/driver-e2e

An ai-bdd driver for [TesterArmy e2e](https://github.com/tester-army/e2e) that talks to
`e2e mcp` over MCP stdio. e2e is a **driver**, not the engine: `e2e mcp` exposes raw session
tools only (`open_session`, `tools`, `call`, `close_session`), so the act loop, the caches,
the checks and the judge all live in the ai-bdd daemon (R-K1a, R-K2).

```ts
import { e2e } from '@ai-bdd/driver-e2e';

export default { drivers: { mobile: e2e({ config: './e2e.config.ts', target: 'ios', maxSessions: 4 }) } };
```

## What it does

- spawns `npx e2e mcp --config <path> --target <name> --max-sessions <n>` (flag names verified
  against e2e 0.19.0) through `@modelcontextprotocol/client` v2 (`./stdio` transport);
- `openSession` calls `open_session`, reads the session's tool catalog and derives capabilities
  from it, so a verb the target does not support is simply absent;
- `observe` calls `call { tool: 'observe' }`, parses the `#id role "name"` line format into
  observed nodes, and calls `screenshot` when pixels are requested and the session is clean;
- `perform` maps ai-bdd verbs onto the catalog (`tap`, `double_tap`, `type`, `type_secret`,
  `press`, `select`, `check`, `hover`, `scroll`, `scroll_to`, `drag`, `navigate`, `back`,
  `tap_at`, `type_at`, `upload`, `right_click`, ...);
- e2e error codes map to ai-bdd codes: `PIXEL_TAINTED`, `POLICY_DENIED`, `SESSION_OPEN` ->
  `SESSION_LIMIT`, `CONFIG_IN_USE`/`ENGINE_IN_USE` -> `RESOURCE_LOCKED`, `NO_SESSION`;
- `selfCheck()` runs the catalog check and reports missing tools instead of throwing
  (`DRIVER_INCOMPATIBLE` at the daemon boundary).

## Tests without e2e installed

The unit tests inject a `McpCaller` that replays `test/fixtures/e2e-mcp-0.19.0.jsonl`. The live
test is opt-in: `AI_BDD_LIVE_E2E=1` with `e2e` installed and a target that can reach
`fixtures/app`.

## Concurrency

The driver caps sessions at `--max-sessions` (1..16, default 4). e2e closes sessions after 30
idle minutes or 4 hours; the ai-bdd scheduler closes them in `finally` blocks and reaps orphans
from `.ai-bdd/sessions/*.json` at daemon start.
