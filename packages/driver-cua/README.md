# @ai-bdd/driver-cua

Drives native desktop windows through the Cua Driver MCP surface (`cua-driver mcp`, attaching to a
running `cua-driver serve` when there is one).

```ts
import { cua } from '@ai-bdd/driver-cua';
export default { drivers: { desktop: cua({ app: 'com.example.Billing', windowTitle: 'Billing', mode: 'mcp' }) } };
```

## Behaviour

| Concern | Implementation |
| --- | --- |
| Observation | `get_window_state` with the accessibility tree and an optional screenshot; element tokens (`^s[0-9a-f]{8}:\d+$`) become node test ids and refs, and are only valid against the newest observation |
| Actions | `click` (element token or coordinates, with an explicit window target), `type_text`, `press_key`, `hotkey`, `scroll`, `drag`, `move_cursor` |
| Predicates | `verify_state` with 1–8 predicates; `unknown` is mapped to `unknown` and therefore **fails** the assertion |
| Policy | `policy.cua.allowApps` (bundle id or process name) is checked before anything else; an empty list refuses every application |
| Concurrency | `exclusiveResource: 'desktop:<display>'` and `maxSessions: 1`, because `type_text` targets the foreground application. With `backgroundOnly: true` the driver allows several sessions, always uses `delivery_mode: 'background'`, and refuses `type`/`typeSecret`/`press`/`scroll`/`drag` with `POLICY_DENIED` (R-K13) |
| Mistakes early | `selfCheck()` reports `DRIVER_INCOMPATIBLE` and lists the missing contract tools instead of failing mid-run |

`navigate` is deliberately absent from the verb list: a native desktop has no URL bar.

## Fixtures are synthetic

The Cua CLI cannot run in the sandbox this repository was built in, so
`test/fixtures/tools-list.json` is hand-authored from the documented contract tools
(contract version 0.8.0) and marked `synthetic: true` (VERIFY V3). A Cua-enabled job must regenerate
it with a real `tools/list` snapshot and drop the flag; the tests replay the snapshot through an
injectable `McpCaller`, so they need no installation.

```bash
pnpm -F @ai-bdd/driver-cua test   # 17 tests
```
