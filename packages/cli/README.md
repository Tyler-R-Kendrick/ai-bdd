# @ai-bdd/cli

The `ai-bdd` command line. It is a thin layer over the public `@ai-bdd/sdk` API: it translates flags into
`CompileOptions` / `RunOptions`, prints summaries, and maps errors to exit codes. It imports only `@ai-bdd/sdk`
and `@ai-bdd/sdk/contracts` (plus `commander`), and loads `@ai-bdd/testing` dynamically only when `AI_BDD_FAKE=1`.

```sh
ai-bdd init [--yes] [--json]
ai-bdd compile [docs...] [--full] [--dry-run] [--check]
ai-bdd status [--json]
ai-bdd show [id|docUri] [--json] [--recordings]
ai-bdd review <accept|reject|pin|unpin> <id...>
ai-bdd run [selectors...] [--tag t1,t2] [--grep text] [--driver name] [--frozen] [--no-compile] [--strict]
           [-u|--update-recordings] [--no-agent] [--audit] [--workers n] [--reporter r...]
ai-bdd verify-run <runDir>
ai-bdd prune [--dry-run]
ai-bdd doctor [--offline]
```

Global option: `-c, --config <path>` selects a config file instead of the default lookup.

## Exit codes (R-RN3)

| Code | Meaning |
|---|---|
| 0 | Everything passed. Healed counts as passed unless `--strict`. |
| 1 | A scenario failed, was inconclusive or blocked; `compile` had extraction errors; `verify-run` found problems; `doctor` had a failing check. |
| 2 | Usage, config or doc read error (also `RECORDING_READ_ONLY`, `SCENARIO_NOT_FOUND`, corrupt plans). |
| 3 | Infrastructure: driver or model unavailable, a scenario `error`, or an unexpected internal error. Takes precedence over 1. |
| 4 | Frozen violation: a stale or missing plan under `--frozen` or `compile --check`. Nothing runs. |

`run` takes the exit code from `RunReport.exitCode`; `compile` from `CompileResult.exitCode`. Any `AiBddError`
thrown by the SDK is mapped by its code (`src/exit.ts`).

## CI defaults (R-RN4)

When `CI` is `true` or `1` (or the resolved config says `ci`), `run` defaults to `--frozen` (and never compiles),
and `-u` fails with `RECORDING_READ_ONLY` (exit 2) unless `AI_BDD_RECORDINGS=read-write`. There is no implicit
`--strict`. The engine enforces the same defaults; the CLI only translates them.

## `AI_BDD_FAKE=1`

Replaces `config.models` with `createFakeModels({ rulesDir: $AI_BDD_FAKE_RULES })`, registers driver `fake`
(`fakeDriver({ flags: $AI_BDD_FAKE_FLAGS split on "," })`), makes it the default driver unless `--driver` is given,
and prints `ai-bdd: FAKE models/driver active` to stderr. Without a config file, SDK defaults are used. Exits 2 if
`@ai-bdd/testing` is not installed.

## Programmatic use

```ts
import { main } from '@ai-bdd/cli';
const exitCode = await main(['status'], { cwd: '/path/to/project' }, { /* optional deps overrides */ });
```

`main(argv, io?, deps?)` never throws. `deps` (`loadConfig`, `resolveConfig`, `createEngine`,
`createRecordingStore`, `verifyRun`, `importTesting`, `nodeVersion`, `signal`) defaults to the SDK; tests inject
an in-memory `Engine`.
