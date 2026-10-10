# @ai-bdd/cli

The `ai-bdd` command line. It is a thin layer over the public `@ai-bdd/sdk` API: it translates flags into
`CompileOptions` / `RunOptions`, prints summaries, and maps errors to exit codes. It imports only `@ai-bdd/sdk`
and `@ai-bdd/sdk/contracts` (plus `commander`). It runs exactly the models and drivers the loaded config registers; it has no
built-in test doubles and reads no environment flag to swap them in.

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

## Choosing drivers and models

Drivers and models are chosen by the config file (`ai-bdd.config.{ts,mjs,js,json}`, or `-c <file>`), never by environment
flags. A missing config file, including a `-c` path that does not exist, is `CONFIG_NOT_FOUND` (exit 2).

- `drivers`: a map of name to a driver. Each entry is either a factory object or `{ use, options }`, where `use` names a
  package that exports `createDriverFactory(options)`. `defaultDriver` picks the entry used when `--driver` is not given.
- `models`: either a `ModelSet` built with `createModelSet`, or `{ use, options }` for a package that exports
  `createModelSet(options)`, such as `@ai-bdd/models-ai-sdk`.

```js
// ai-bdd.config.mjs
export default {
  docs: ['docs/**/*.md'],
  drivers: {
    web: { use: '@ai-bdd/driver-playwright', options: { browser: 'chromium', headless: true } },
    // any package exporting createDriverFactory(options) works the same way:
    desktop: { use: './drivers/cua.mjs', options: {} },               // your own package wrapping Cua Driver (https://cua.ai)
    agent: { use: 'my-browser-use-driver', options: { /* ... */ } }, // browser-use style driver
  },
  defaultDriver: 'web',                                             // `ai-bdd run --driver desktop` overrides it
  models: { use: '@ai-bdd/models-ai-sdk', options: { extract: 'anthropic/claude-sonnet-5.5', act: 'anthropic/claude-sonnet-5.5' } },
};
```

In a JS config a driver can also be a factory object (for example `drivers: { web: myDriverFactory }`), and `models` can be
the value returned by `createModelSet(...)`. Deterministic test doubles live in `@ai-bdd/testing` and are selected the same
way, through a config file: `writeTestConfig({ projectDir })` writes `ai-bdd.config.test.mjs`, which extends the project's real
config and registers the fake driver and fake models; run it with `ai-bdd -c ai-bdd.config.test.mjs ...`.

## Programmatic use

```ts
import { main } from '@ai-bdd/cli';
const exitCode = await main(['status'], { cwd: '/path/to/project' }, { /* optional deps overrides */ });
```

`main(argv, io?, deps?)` never throws. `deps` (`loadConfig`, `resolveConfig`, `createEngine`,
`createRecordingStore`, `verifyRun`, `nodeVersion`, `signal`) defaults to the SDK; tests inject
an in-memory `Engine`.
