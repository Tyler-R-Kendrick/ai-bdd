# @ai-bdd/sdk

The public SDK of ai-bdd. The CLI and every framework integration are built on this package only.

## API: configuration and engine

```ts
import { defineConfig, loadConfig, resolveConfig, createEngine } from '@ai-bdd/sdk';
```

### Configuration

| Function | Behavior |
|---|---|
| `defineConfig(userConfig)` | Identity helper for typed config files. |
| `resolveConfig(userConfig, { projectRoot, configPath?, env })` | Pure. Validates with a strict schema (unknown keys, bad values, `judge.failThreshold >= judge.passThreshold`, thresholds outside `[0,1]`, `samples` outside `1..9` all throw `CONFIG_INVALID`), applies the defaults table, makes every path absolute, adds the `baseURL` host to `policy.allowHosts`, detects CI (`CI=true` or `CI=1`) and sets `recordingsMode` (`CI ? 'read-only' : 'read-write'`, overridden by `AI_BDD_RECORDINGS=read-write\|read-only\|off`). `secrets` keep only `{ env }` names: secret **values are never stored** in the result; an env value shorter than 4 characters throws `SECRET_TOO_SHORT`. |
| `loadConfig({ cwd, configPath?, env? })` | Finds `ai-bdd.config.ts`, `.mjs`, `.js`, `.json` (in that order) in `cwd`, or loads `configPath`. `.ts` is loaded with native `import()` (Node type stripping); if the runtime cannot, it throws `CONFIG_TS_UNSUPPORTED`. In the JSON form `drivers.<name>` and `models` may be `{ "use": "<package or ./file>", "options": {...} }`; the package must export `createDriverFactory(options)` / `createModelSet(options)`. Missing file: `CONFIG_NOT_FOUND`. `projectRoot` is `cwd`. |

### Engine

`createEngine(config, overrides?)` is async, cheap and idempotent per config object (when no overrides are passed). Sibling modules, drivers, the redactor and run directories are created lazily on first use. `overrides` may carry `models`, `drivers`, `clock` and `env` (see `EngineDeps`). Secrets are read from `env` once, at creation, into the redactor and `secretValue()` only.

| Method | Behavior |
|---|---|
| `compile(opts?)` | discover, chunk, dirty sections, extract (concurrently, `extract.concurrency`), merge, save. An unchanged doc makes **zero** model calls and rewrites nothing. Plans of deleted docs are removed. `check` writes nothing and returns `exitCode: 4` when any doc is not `fresh`; `dryRun` extracts but writes nothing. A failed section keeps its previous features. `exitCode`: 2 doc read error, 3 model unavailable, 1 extraction errors, 4 stale (check), else 0. |
| `status()` / `plans()` | Plan freshness per doc (no model calls) / the stored plans. |
| `listScenarios(filter?)` | Non-rejected scenarios, ordered by `docUri` then plan order, filtered by `selectors` (scenario id, feature id, id prefix ending in `/` or `--`, doc glob), `tags` (any, scenario or feature tag, `@` optional) and `grep` (case-insensitive title substring). |
| `review(id, action)` | `accept`, `reject`, `pin`, `unpin` on a feature or scenario id; saves the plan. |
| `run(opts?)` | Frozen check (stale plan: `exitCode` 4 and nothing runs), optional compile (default unless frozen or `compile: false`), select, `runner.runAll`, reporters (written into the run dir, then copied to `<.ai-bdd>/report/`), `RunReport`. CI defaults to `frozen`. `updateRecordings` with read-only recordings throws `RECORDING_READ_ONLY`; a selector that matches nothing throws `SCENARIO_NOT_FOUND`. |
| `runScenario(id, opts?)` | One scenario. With `opts.sessionFactory` the host's session is adopted and no configured driver is created. All `runScenario` calls of one engine share one lazily created run directory, finalized by `close()`. |
| `verifyRun(dir)`, `prune({ dryRun })`, `doctor({ offline })` | Integrity check of a run dir; delete recordings whose scenario is in no plan (refused in read-only mode); environment diagnostics that report, never throw. |
| `on(listener)` | Streams `RunEvent`s; returns an unsubscribe function. |
| `close()` | Finalizes the engine's run dir and disposes drivers. Idempotent. |

#### Run report

- `totals`: one counter per scenario status.
- `usage`: counted by a decorator around each model purpose (`byPurpose.extract|act|checkgen|judge`); it covers the compile done inside `run()`. `estimatedCostUsd` is present only when `prices` (keyed by model id) are configured.
- `coverage`: per doc, non-heading chunks, how many are cited as `source`, plus the `uncovered` and `notTestable` chunk ids.
- `warnings`: compile diagnostics, `PLAN_STALE` for a frozen violation, and `JUDGE_SAME_AS_ACTOR` when the judge model id equals the actor model id.
- `exitCode` (R-RN3): `3` when any scenario is `error`, a driver or model was unavailable (`DRIVER_UNAVAILABLE` / `MODEL_UNAVAILABLE`); else `1` when any scenario is `failed`, `inconclusive` or `blocked`, a section failed to extract, or a `healed` scenario under `strict`; else `0`; `4` for a frozen violation. Usage and configuration errors are thrown as `AiBddError` instead (`USAGE`, `CONFIG_*`, `DOC_READ_FAILED`, `RECORDING_READ_ONLY`, `SCENARIO_NOT_FOUND`); the CLI maps them to exit code 2.
- The report is passed through the redactor before it is written (R-SE1).
