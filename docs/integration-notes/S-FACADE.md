# S-FACADE integration notes

Owner: `packages/sdk/src/config/`, `packages/sdk/src/engine/`, tests under `packages/sdk/test/{config,engine}/`, API section of `packages/sdk/README.md`.

## config

- `resolveConfig(user, { projectRoot, configPath?, env })` is pure and implements the defaults table, strict zod validation (`CONFIG_INVALID` lists every offending path and never echoes values), `SECRET_TOO_SHORT`, CI detection, `AI_BDD_RECORDINGS` and the `baseURL` host in `policy.allowHosts`. An invalid `AI_BDD_RECORDINGS` is `CONFIG_INVALID`. User `policy.allowHosts` replace the localhost defaults (the baseURL host is still added). `defaultDriver` falls back to the only configured driver. `defaultDriver` membership is **not** validated at resolve time, so a caller can patch `drivers`/`defaultDriver` after resolving (the former CLI fake mode did; it is removed); `doctor` reports a bad default and the runner raises `CONFIG_INVALID` on use.
- `loadConfig` sets `projectRoot = cwd` (also when `configPath` is given). `.ts` configs use plain `import()`; `ERR_UNKNOWN_FILE_EXTENSION` becomes `CONFIG_TS_UNSUPPORTED`. JSON `{use, options}` entries are resolved for `drivers.*` and `models` (also honored for non-JSON configs). Bare package names are resolved from `projectRoot` first, then from the SDK itself; `./relative` paths against `projectRoot`.
- Extra exports from `config/index.ts` (not re-exported by `src/index.ts`): `CONFIG_FILE_NAMES`, `MIN_SECRET_LENGTH`.

## engine

Public behavior is documented in `packages/sdk/README.md` ("API: configuration and engine").

`createEngine(config, overrides?)` accepts, besides `Partial<EngineDeps>`, an internal `modules?: Partial<EngineModules>` override (type exported from `engine/index.ts`). Every sibling is reached only through its public index barrel, and only when first needed, so creating an engine works while siblings are stubs.

### Assumptions about sibling modules (please verify at integration time)

1. **Runner and `sessionFactory`.** With `opts.sessionFactory` the engine does not create any driver and passes an empty-or-partial `drivers` map. The runner must not require the configured driver to exist in that case (it should take `driverId` from the adopted session). Without `sessionFactory` the engine creates, before the run, the drivers named by `scenario.driver ?? opts.driver ?? config.defaultDriver`. A factory whose `create` throws is replaced by a stand-in whose `openSession` throws `DRIVER_UNAVAILABLE` (so the scenario becomes `error`, exit 3). Unknown driver names are left out of the map: the runner must raise `CONFIG_INVALID`.
2. **Judge cache dir.** `createJudge` receives `cacheDir: config.cacheDir` (not `<cacheDir>/judge`); the judge should append `judge/` itself (spec 3.1: `.ai-bdd/cache/judge/*.json`).
3. **Evidence.** One store per `run()` (new `runId`); one shared lazily created store for all `runScenario` calls of an engine, finalized by `close()`. `run()` calls `finalize()` after the reporters ran. The engine does not call `evidence.record()` itself (the runner owns `events.jsonl`).
4. **Reporters** are rendered with `outDir = <run dir>` (files at the top level of the run dir, e.g. `report.json`) and then copied to `<dirname(runsDir)>/report/` (default `.ai-bdd/report/`), which is cleared first. **S-EVIDENCE `verifyRun` must therefore only check `artifacts/` and `manifest.json` and ignore the report files and `events.jsonl`**, otherwise `verify-run` on a fresh run dir would flag them as "extra".
5. **Redaction of the report.** `run()` passes the whole `RunReport` through `redactor.redactJson` before the reporters see it and before `run-end` is emitted.
6. **Planner/compile.** The engine always calls `planner.merge` for every discovered doc (even when no section is dirty) so relocated refs are persisted; it only calls `store.save` when the stable-JSON bytes differ from the stored plan. `meta.extractor` is taken from the first extraction result of that doc, else from the previous plan, else from the configured model id and `EXTRACT_PROMPT_VERSION`, so a no-op recompile never changes bytes. `planner.status` is used for freshness (`compile --check`, `--frozen`, `status`, `doctor`): orphaned plans (doc deleted) make a frozen run fail with exit 4.
7. **Plan store** is created with `readOnly: false`. The engine never calls `loadAllSync`.
8. **Usage.** `RunReport.usage` is the delta over the whole `run()` call (including the implicit compile), counted by a decorator on the `ModelSet`; models passed to siblings are the decorated ones. `estimatedCostUsd` looks up `prices[response.modelId] ?? prices[model.id]`.

### Behavior the CLI needs to know

- `run()` and `runScenario()` **throw** `AiBddError` for usage-level problems instead of returning `exitCode: 2`: `RECORDING_READ_ONLY` (`-u` with read-only recordings, checked before anything else), `SCENARIO_NOT_FOUND` (a selector matching nothing; `listScenarios` itself is lenient), `DOC_READ_FAILED`, `CONFIG_INVALID` (e.g. no model configured when one is needed in a replay-only gap). The CLI should map those, `USAGE`, `CONFIG_*`, `SECRET_*` to exit 2.
- `compile()` returns `exitCode` 2 only for `DOC_READ_FAILED` with severity `error` diagnostics; 3 if a `MODEL_UNAVAILABLE` was observed; 1 for failed sections or error diagnostics; 4 for `check` on a non-fresh project.
- A frozen violation returns a normal `RunReport` with `exitCode: 4`, `scenarios: []`, and `PLAN_STALE` warnings; no run dir is created.
- `prune()` throws `RECORDING_READ_ONLY` in read-only mode (dry-run still works).
- `doctor()` plan check: `stale`/`orphaned` docs fail it, docs that were never compiled (`new`) do not.
- `JUDGE_SAME_AS_ACTOR` is a `warning` diagnostic in every `RunReport.warnings` of that engine and a single `log` (warn) event.

### Open question for X-INTEGRATOR

- Spec 9.2 lets `scenario.driver` win over the CLI `--driver`; the engine follows that when deciding which drivers to create. If P-CLI expects `--driver` to override scenario directives, the runner and `neededDrivers` in `engine/run.ts` change together.

## VERIFY outcomes

- V1 (native type stripping of `.ts` config): verified on Node 22.22.0 with bare `node`: a script importing `packages/sdk/src/config/index.ts` loaded a `.ts` config containing a type annotation through `loadConfig` (2026-10-10). The `CONFIG_TS_UNSUPPORTED` mapping is unit-tested through an injected importer.
