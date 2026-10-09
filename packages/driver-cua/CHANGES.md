# Changelog

## 0.1.0

- `cua()` driver factory over the typed contract tools, with `mcp` and `daemon` modes.
- Window resolution through `list_apps`/`list_windows` plus `policy.cua.allowApps`.
- `verify_state` native predicates with `unknown` counted as a failure.
- Background-only mode, exclusive desktop resource and policy refusals.
- Synthetic contract fixtures plus 17 tests replaying them through an injectable MCP caller.
