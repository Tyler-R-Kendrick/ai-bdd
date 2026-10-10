# P-CLI integration notes

## cli

Public behavior (see `packages/cli/README.md`):

- `main(argv, io?, deps?)` never throws; `deps` = `{ loadConfig, resolveConfig, createEngine, createRecordingStore, verifyRun, importTesting, nodeVersion, signal }`, all defaulting to the public SDK (lazily imported, so `--help` does not load the engine). `bin.ts` wires SIGINT to `deps.signal`.
- Exit codes: `src/exit.ts` has an exhaustive `Record<ErrorCode, ExitCode>`. `run` passes `RunReport.exitCode` through; `compile` passes `CompileResult.exitCode` and additionally returns 1 for failed sections / error diagnostics and 4 for `--check` when any doc state is not `fresh` (safety net over the engine).
- CI defaults: `frozen = flag ?? (config.ci || CI in {1,true})`; a frozen run sends `compile: false`; `-u` with `config.recordingsMode === 'read-only'` throws `RECORDING_READ_ONLY` (exit 2) before calling `engine.run`.
- `AI_BDD_FAKE` (1/true/yes/on): `@ai-bdd/testing` is loaded with a variable specifier (`import(specifier)`) so static boundary scripts do not see it. Config is replaced (models, drivers + `fake`, defaultDriver) and the same models/drivers are passed as `createEngine` overrides. If no config file exists in fake mode, `resolveConfig({}, ...)` defaults are used. Banner goes to stderr.
- `show --recordings` reads recordings through the SDK `createRecordingStore({dir, mode: 'read-only'})` (the `Engine` interface has no recordings accessor). Driver id: scenario driver, else `defaultDriver`, else the first driver with a recording.
- `verify-run` uses `engine.verifyRun`; if no config exists it falls back to the SDK `verifyRun` function so CI artifacts can be checked outside a project.
- `doctor` exit: config failure maps by error code (2); any failed check is 1. Engine checks named like ours (`node`, `config`) replace the CLI fallbacks.
- Output never contains secret values: values of env vars named in `config.secrets` are scrubbed from every printed line (defense in depth; the engine redacts first).
- Extra (not in the spec): global `-c, --config <path>`; `run --tag` / `--reporter` are repeatable and comma-separated.

## Requests / observations for X-INTEGRATOR

- `packages/cli/package.json` `exports["."].source` points at `./src/index.ts`; this file now exists (re-exports `main`).
- Real end-to-end CLI tests against the corpus (`AI_BDD_FAKE=1`, `AI_BDD_FAKE_RULES`) belong with X-CORPUS/X-INTEGRATOR; the unit tests here use an injected in-memory engine plus spawn smoke tests of `bin.ts`.
- Manual smoke against the current real engine (no corpus yet): `status`, `compile --check` (exit 4 on a new doc), `doctor --offline`, `show`, `prune --dry-run`, `CI=1 run -u` (exit 2) all behave per spec; `run` currently stops at `NOT_IMPLEMENTED: runner.createRunner` (exit 3) because the runner module is not there yet.

## VERIFY outcomes

- V1: `node --conditions=source packages/cli/src/bin.ts --help` works on Node 22.22.0 (2026-10-10), also covered by `packages/cli/test/help-and-spawn.test.ts`.
