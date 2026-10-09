# Changelog

## 0.1.0

- Commands: `init`, `run`, `resolve`, `lint`, `lock verify`, `codegen`, `verify-evidence`,
  `calibrate`, `doctor`, and `serve` (which requires `@ai-bdd/daemon`).
- `--fake` / `AI_BDD_FAKE=1` support with configured driver names mapped onto the fake driver.
- Exit codes per section 9.2, mapped from `AiBddError.group`.
- Directory arguments expand to spec globs; `--json` output for `resolve` and `calibrate`.
