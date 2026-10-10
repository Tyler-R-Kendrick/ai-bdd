# CLI reference

The `ai-bdd` command is a thin layer over the public SDK: it turns flags into engine options, prints summaries, and maps errors to exit codes. In a project, run it with `pnpm exec ai-bdd` (or `npx ai-bdd`). The examples below write plain `ai-bdd`.

```text
ai-bdd [-c, --config <path>] [-V] <command>

init [--yes] [--json]
compile [docs...] [--full] [--dry-run] [--check]
status [--json]
show [id|docUri] [--json] [--recordings]
review <accept|reject|pin|unpin> <id...>
run [selectors...] [--tag <tags>] [--grep <text>] [--driver <name>] [--frozen] [--no-compile] [--strict]
    [-u|--update-recordings] [--no-agent] [--audit] [--workers <n>] [--reporter <names>]
verify-run <runDir>
prune [--dry-run]
doctor [--offline]
```

`-c, --config <path>` loads that config instead of searching for `ai-bdd.config.{ts,mjs,js,json}` in the current directory. The project root is always the current directory.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Everything passed. `healed` counts as passed unless `--strict`. |
| 1 | A scenario `failed`, was `inconclusive` or `blocked`; `compile` had extraction errors; `verify-run` found problems; a `doctor` check failed. |
| 2 | Usage, config or doc-read error. Also `RECORDING_READ_ONLY`, `SCENARIO_NOT_FOUND` and corrupt plans. |
| 3 | Infrastructure: driver or model unavailable, a scenario ended `error`, or an unexpected internal error. Takes precedence over 1. |
| 4 | Frozen violation: a stale, new or orphaned plan under `--frozen` or `compile --check`. Checked before anything runs. |

Set `AI_BDD_DEBUG=1` to print stack traces for unexpected errors.

## `init`

```sh run in=project
cd "$(mktemp -d)"
ai-bdd init
ai-bdd init
```

Writes `ai-bdd.config.ts` (`--json`: `ai-bdd.config.json`), `docs/example.md`, adds `.ai-bdd/runs/` and `.ai-bdd/cache/` to `.gitignore`, and creates `.ai-bdd/plans/`. It never overwrites an existing file; the second run reports `skipped`. `--yes` overwrites.

## `compile [docs...]`

```sh run in=project
ai-bdd compile docs/billing.md
```

Discovers docs, chunks them, finds dirty sections, extracts them, merges into the plans, saves, and removes the plans of deleted docs. Per document it prints `fresh`, `stale` or `new` state, counts of added, updated and removed elements, and diagnostics; at the end the number of model calls. `docs...` are paths or globs (default: all configured `docs`).

| Flag | Effect |
|---|---|
| `--full` | Re-extract every section regardless of staleness. Rejected scenarios still do not return. |
| `--dry-run` | Extract (model calls happen) but write nothing. |
| `--check` | Write nothing, call no model, exit 4 if any doc is not `fresh`. Use it in CI. |

```sh run in=project exit=4
# Only billing is compiled so far; the other documents are "new".
ai-bdd compile --check
```

```sh run in=project
ai-bdd compile
ai-bdd compile --check
```

Compiling an unchanged project prints `Model calls: 0` and rewrites nothing. If a section fails (model unavailable, schema invalid twice) its previous features are kept and the section stays dirty.

## `status`

```sh run in=project
ai-bdd status
```

No model calls. Per document: `fresh`, `stale`, `new` or `orphaned`; dirty sections; stale (pinned) features; counts of `uncovered` and `notTestable` chunks; unreviewed scenarios. `--json` prints `{ docs: [{ docUri, state, dirtySections, staleFeatures, notTestable, uncovered, unreviewedScenarios }] }`.

## `show [id|docUri]`

```sh run in=project
ai-bdd show docs-billing--upgrade-to-pro
```

Renders plan elements as Gherkin-like text with `# source: <docUri>:<line> "<quote>"` under every step. The argument is a document path, a feature id, a scenario id or an id prefix; without it, everything is shown. `--recordings` adds per step `determinism`, fuzzy reasons, and a summary of the replay program or check. `--json` prints the plan elements as JSON.

## `review <accept|reject|pin|unpin> <id...>`

```sh run in=project
ai-bdd review accept docs-billing--upgrade-to-pro
ai-bdd review reject docs-billing--upgrade-to-pro/upgrade-button-is-visible-on-the-free-plan
ai-bdd review pin docs-billing--upgrade-to-pro
```

Edits the plan files. `ids` are feature or scenario ids. Accepting or rejecting a feature applies to all its scenarios. Rejecting stores the scenario fingerprint so it never returns. Pinned features are never overwritten by `compile`. See [review-guide.md](review-guide.md).

## `run [selectors...]`

```sh run in=project
ai-bdd run docs-billing--upgrade-to-pro
ai-bdd run docs-billing--upgrade-to-pro
```

The first command characterizes (`characterize, recording created`); the second replays with zero model calls. Output per scenario: a status label (`PASS`, `HEAL`, `FAIL`, `ERROR`, ...), mode, recording result and duration; failing steps with their error code; then totals, step paths (`replayed`, `by agent`, `healed`, `fuzzy`), fuzzy reasons, model calls, recording results, unreviewed scenarios that ran, the run directory and the exit code.

**Selectors** are scenario ids, feature ids, id prefixes ending in `/` or `--`, or doc globs. A selector that matches nothing is `SCENARIO_NOT_FOUND` (exit 2). `docs-billing--` selects every scenario of `docs/billing.md`; `docs-billing--upgrade-to-pro/` one feature. Rejected scenarios never run.

Without `--frozen` and `--no-compile`, `run` first compiles stale docs (and then needs a working `extract` model).

| Flag | Effect |
|---|---|
| `--tag <tags>` | Only scenarios with any of these tags (comma-separated or repeated; leading `@` optional; scenario or feature tags). |
| `--grep <text>` | Only scenarios whose title contains the text (case-insensitive). |
| `--driver <name>` | Driver to use. A scenario's own `driver` directive wins. |
| `--frozen` | Do not compile; exit 4 if any plan is not fresh. **Default when `CI` is `true` or `1`.** |
| `--no-compile` | Do not compile stale docs first. |
| `--strict` | A `healed` step fails with `REPLAY_DIVERGED`, without calling the agent. |
| `-u`, `--update-recordings` | Ignore existing recordings and characterize again; overwrite them if the scenario passes. |
| `--no-agent` | Any step that needs the agent fails with `ACT_NO_AGENT`. Use it to prove a suite replays purely. |
| `--audit` | Also run the judge next to every deterministic check; a disagreement fails with `CHECK_JUDGE_DISAGREEMENT`. Costs judge calls. |
| `--workers <n>` | Scenarios in parallel (default 4). Sessions are isolated; `exclusiveResource` drivers serialize. |
| `--reporter <names>` | Subset of `json`, `junit`, `markdown` (comma-separated or repeated). Default: all three. |

See [Frozen and CI runs](#frozen-and-ci-runs) for `--frozen` and the `CI` defaults.

### Outputs

Each run writes `.ai-bdd/runs/<runId>/` (`artifacts/`, `manifest.json`, `events.jsonl`, `report.json`, `junit.xml`, `summary.md`) and copies the reports to `.ai-bdd/report/`. `summary.md` has totals, failures, healed and fuzzy steps, the unreviewed scenarios that ran, the traceability matrix (doc section, chunk, scenarios, status), uncovered and not-testable chunks, and usage per purpose. `junit.xml` has one suite per feature and one case per scenario.

## `verify-run <runDir>`

```sh run in=project
ai-bdd verify-run "$(ls -d .ai-bdd/runs/* | tail -1)"
```

Recomputes every artifact hash and the manifest digest. Exit 0 with `OK`, or exit 1 listing `missing`, `modified`, `extra` or `digest mismatch` problems. Run ids sort by time, so `ls | tail -1` is the latest. It works outside a project (no config needed). It detects corruption and naive edits, not a malicious host ([security.md](security.md#evidence-integrity)).

## `prune`

```sh run in=project
ai-bdd prune --dry-run
```

Deletes recordings whose scenario exists in no plan (for example after a rejected or removed feature). `--dry-run` lists them. Refused when recordings are read-only.

## `doctor`

```sh run in=project
ai-bdd doctor --offline
```

Checks Node version, config loading, each driver's `selfCheck`, model reachability and plan freshness, and prints `[ok]` or `[FAIL]` per check. Exit 1 if any fails. It reports missing drivers instead of crashing. Without `--offline` it also probes each model with a minimal request, which can cost a few tokens.

## Environment variables

| Variable | Effect |
|---|---|
| `CI=true` or `CI=1` | CI defaults: `run` is `--frozen`, recordings are read-only. |
| `AI_BDD_RECORDINGS` | `read-write`, `read-only` or `off`. Overrides the CI default. `off` neither reads nor writes recordings. |
| `AI_BDD_DEBUG=1` | Stack traces for unexpected errors. |
| `AI_BDD_CHROMIUM_PATH` | Chromium executable for the Playwright driver. |
| `PLAYWRIGHT_BROWSERS_PATH` | Where the Playwright driver looks for browsers. |
| Names listed under `secrets` in config | The secret values (at least 4 characters). Every printed line is scrubbed of them. |
| `AI_BDD_FAKE=1` | Test mode, below. |

### `AI_BDD_FAKE=1`

Replaces `config.models` with the deterministic rule-based fake model (`createFakeModels({ rulesDir: $AI_BDD_FAKE_RULES })`), registers the `fake` driver (`fakeDriver({ flags: $AI_BDD_FAKE_FLAGS split on "," })`), makes it the default driver unless `--driver` is given, and prints `ai-bdd: FAKE models/driver active` to stderr. It loads `@ai-bdd/testing`; if that is not installed, the CLI exits 2. Without a config file the SDK defaults are used.

| Variable | Meaning |
|---|---|
| `AI_BDD_FAKE_RULES` | Directory of fake-model rule files (`*.json`). A missing rule is a loud `MODEL_NO_RULE`. |
| `AI_BDD_FAKE_FLAGS` | Acme app flags for the fake driver: `v2` (renames the upgrade button to "Go Pro"), `bug-upgrade-noop` (Confirm closes the dialog but changes nothing). |
| `AI_BDD_FAKE_LOG` | Append every fake model request and response to this JSONL file. |

This mode exists for tests and the README quickstart. The bundled corpus (`packages/testing/corpus`) shows rule files, docs with directives, and a config.

## Frozen and CI runs

`--frozen` guarantees a run uses exactly the committed plans: if any doc is `new`, `stale` or `orphaned`, the run exits 4 before anything executes, with a `PLAN_STALE` warning per doc.

```sh run in=project exit=4
# Edit a document; the frozen run refuses to start.
printf '\nAdditional note appended to the last paragraph.\n' >> docs/billing.md
ai-bdd run --frozen
```

When `CI` is `true` or `1`:

- `run` defaults to `--frozen` (and never compiles);
- recordings are `read-only`: nothing is written, and `-u` fails with `RECORDING_READ_ONLY` (exit 2) unless `AI_BDD_RECORDINGS=read-write`.

```sh run in=project exit=2
CI=1 ai-bdd run -u
```

There is no implicit `--strict`. Healed steps are reported prominently in the summary and in the JUnit output (`ai-bdd.healed` property).

A typical CI job:

```text
ai-bdd compile --check     # exit 4 if docs changed and the plan was not recompiled and committed
ai-bdd run                 # CI=1: frozen, read-only recordings, replay
```
