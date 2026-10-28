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

`-c, --config <path>` loads that config instead of searching for `ai-bdd.config.{ts,mjs,js,json}` in the current directory. The project root is always the current directory. Use it for several setups side by side (for example `ai-bdd -c ai-bdd.desktop.config.mjs run` to drive the same docs through another driver, for example one built on Cua Driver, see [drivers.md](drivers.md#plugging-in-a-driver)) and for test configs that plug in deterministic doubles ([sdk.md](sdk.md#test-doubles)). A path that does not exist is `CONFIG_NOT_FOUND` (exit 2). Place it before the command; the examples in this file that run in CI go through a wrapper that supplies a test config, which is the checker's own harness and not something you need.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Everything passed. `healed` counts as passed unless `--strict`. |
| 1 | A scenario `failed`, was `inconclusive` or `blocked`; `compile` had extraction errors; `verify-run` found problems; a `doctor` check failed. |
| 2 | Usage, config or doc-read error. Also `RECORDING_READ_ONLY`, `SCENARIO_NOT_FOUND`, corrupt plans, and an output directory that is a file, a symlink loop, or a symlink out of the project. |
| 3 | Infrastructure: driver or model unavailable, a scenario ended `error`, or an unexpected internal error. Takes precedence over 1. |
| 4 | Frozen violation: a stale, new or orphaned plan under `--frozen` or `compile --check`. Checked before anything runs. |

Set `AI_BDD_DEBUG=1` to print stack traces for unexpected errors.

Ctrl-C asks the run to finish up: the call in flight is abandoned (even a driver or model call that never returns), the scenario ends `error` with `ABORTED` (exit 3), sessions are closed and the reports are written. A second Ctrl-C quits at once (exit 130). After the run the process is ended after five seconds if a driver left something open.

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

The first command characterizes (`characterize, recording created`); the second replays with zero model calls. Output per scenario: a status label (`PASS`, `HEAL`, `FAIL`, `ERROR`, ...), mode, recording result and duration; failing steps with their error code; then totals, step paths (`replayed`, `by agent`, `healed`, `fuzzy`), fuzzy reasons, model calls, recording results, unreviewed scenarios that ran, the run directory (not after a frozen violation, which creates none) and the exit code.

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
| `--no-agent` | Any step that needs the agent fails with `ACT_NO_AGENT`. Use it to prove that no step falls back to the agent. It does not stop the judge: a subjective step is still judged, see [Run report and release gates](#run-report-and-release-gates). |
| `--audit` | Also run the judge next to every deterministic check; a disagreement fails with `CHECK_JUDGE_DISAGREEMENT`. Costs judge calls. |
| `--workers <n>` | Scenarios in parallel (default 4). Sessions are isolated; `exclusiveResource` drivers serialize. |
| `--reporter <names>` | Subset of `json`, `junit`, `markdown` (comma-separated or repeated). Default: all three. |

See [Frozen and CI runs](#frozen-and-ci-runs) for `--frozen` and the `CI` defaults.

### Outputs

Each run writes `.ai-bdd/runs/<runId>/` (`artifacts/`, `manifest.json`, `events.jsonl`, `report.json`, `junit.xml`, `summary.md`) and copies the reports to `.ai-bdd/report/`, replacing each file and removing the report files that run did not produce. A run that ends with exit 2 or 4 writes no report, so `.ai-bdd/report/` then still holds the report of the last run that wrote one, and it leaves no run directory, unless a compile in that same run called a model: its evidence stays in `.ai-bdd/runs/<runId>/`. `summary.md` has totals, failures, healed and fuzzy steps, the unreviewed scenarios that ran, the traceability matrix (doc section, chunk, scenarios, status), uncovered and not-testable chunks, and usage per purpose. `junit.xml` has one suite per feature and one case per scenario.

## `verify-run <runDir>`

```sh run in=project
ai-bdd verify-run "$(ls -d .ai-bdd/runs/* | tail -1)"
```

Recomputes every artifact hash and the manifest digest. Exit 0 with `OK`, or exit 1 listing `missing`, `modified`, `extra` or `digest mismatch` problems. It also checks a v2 report's feature obligations: selected features need tests, required evidence kinds (including formal proof) must be in this run's manifest, carried-forward evidence must name its own run, and every scenario's feature must be present. Run ids sort by time, so `ls | tail -1` is the latest. It works outside a project (no config needed). It detects corruption and naive edits, not a malicious host ([security.md](security.md#evidence-integrity)).

## Run report and release gates

`report.json` is the result of `ai-bdd run` for scripts and for the release gates of other repositories: the `RunReport` of `@ai-bdd/sdk/contracts`, `schemaVersion` 2. Its JSON Schema (draft 2020-12) ships with the SDK.

| Where | Path |
|---|---|
| In this repository | `packages/sdk/schema/run-report.v2.schema.json` |
| In a project | `@ai-bdd/sdk/schema/run-report.v2.json`, an `exports` entry of `@ai-bdd/sdk` (the file is `node_modules/@ai-bdd/sdk/schema/run-report.v2.schema.json`) |
| Legacy reports | `@ai-bdd/sdk/schema/run-report.v1.json` remains exported and frozen |

Every object in the schema is closed (`additionalProperties: false`). For version 2, `features` is required (it is `[]` for a report with no planned features, such as a frozen violation). A report with a field that version 2 does not define is invalid, and so are a scenario status that is not one of the seven, a negative count, duration or estimated cost, a judge `score`, `spread` or sample `probability` outside 0 to 1, an exit code above 4 and a hash that is not 64 lowercase hex characters. `startedAt` and `finishedAt` match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, UTC with milliseconds as `Date.prototype.toISOString()` writes them for the years 0000 to 9999 (outside that range it writes a signed six-digit year, which the pattern rejects); the engine never redacts them or `runId` ([security.md](security.md#secrets)). The schema uses that `pattern` rather than `format: date-time`, which Ajv in strict mode refuses unless `ajv-formats` is added. The file is generated from the same zod schema that a compile-time check ties to the contract type, object by object (`pnpm gen:report-schema`); a test fails when it is stale.

The v1 file is frozen once released: a test pins its sha256, and it never changes. Version 2 adds feature verification and a new artifact/error surface in a new file, `run-report.v2.schema.json`, next to v1. Pin the `@ai-bdd/sdk` version you validate with. [Ajv](https://ajv.js.org) in strict mode compiles it:

```ts check
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '@ai-bdd/sdk/schema/run-report.v2.json' with { type: 'json' };

const validate = new Ajv2020({ strict: true }).compile(schema);
const report: unknown = JSON.parse(readFileSync('.ai-bdd/report/report.json', 'utf8'));
if (!validate(report)) throw new Error(`invalid run report: ${JSON.stringify(validate.errors)}`);
```

What a gate reads:

| Field | Meaning |
|---|---|
| `exitCode` | The exit code of `ai-bdd run`, table below. |
| `totals` | Scenarios per status; all seven statuses are present: `passed`, `failed`, `healed`, `blocked`, `skipped`, `inconclusive`, `error`. |
| `scenarios[]` | Per scenario: `status`, `mode` (`characterize`, `replay`, `mixed`), `recording`, `error` (`code`, `message`) and `steps[]` with their own `status`, `path`, `error`, `check` and `judge`. |
| `usage` | Model calls and tokens, also `byPurpose` (`extract`, `act`, `checkgen`, `judge`). |
| `features[]` | Per documented feature: latest `status`, whether it was `selected`, binary `target`, `risk`, `requiredEvidence`, `formalVerificationRequired`, associated `tests`, content-addressed `evidence`, verification `problems`, `runId` and `lastRunAt`. See [verification.md](verification.md). |
| `coverage`, `warnings` | Uncovered and not-testable chunks per doc; diagnostics such as `PLAN_STALE`. |
| `runId` | Also the name of the run directory, `.ai-bdd/runs/<runId>/`. |

### Exit codes of a gate

The exit codes are those of [Exit codes](#exit-codes). For a gate that runs `ai-bdd run`:

| Exit | Meaning | `report.json` |
|---|---|---|
| 0 | Every scenario `passed`, or `healed` without `--strict`. | written |
| 1 | A scenario `failed`, was `inconclusive` or `blocked`; or a selected feature lacked tests or evidence (including formal proof). | written |
| 2 | Usage or config error: a bad flag, a selector that matches nothing, `-u` with read-only recordings. | not written |
| 3 | Infrastructure: a scenario ended `error` (a driver or model is unavailable, a secret the scenario uses is not set), or an unexpected internal error. | written when a scenario ended `error` or a model was unavailable; not written after an unexpected internal error once the scenarios were selected (the runner or the report writer failed), which keeps its run directory |
| 4 | Frozen violation: a plan is `new`, `stale` or `orphaned`. | not written |

"Not written" means the previous `.ai-bdd/report/report.json` is still there. Read the exit code first, or compare `runId` with the run you started: an exit 3 alone does not tell whether this run wrote the report.

### The replay-only gate

Three commands check a project against its committed plans and recordings, with no compile and no agent:

```sh run in=project
ai-bdd compile --check
ai-bdd run --frozen --no-agent --reporter json,junit docs-billing--upgrade-to-pro
ai-bdd verify-run ".ai-bdd/runs/$(node -p "require('./.ai-bdd/report/report.json').runId")"
```

- `ai-bdd compile --check` writes nothing and calls no model. It exits 4 when a doc is `new`, `stale` or `orphaned`: the committed plans do not describe the docs.
- `ai-bdd run --frozen --no-agent --reporter json,junit` does not compile (a stale plan is exit 4), replays the recordings and writes `.ai-bdd/report/report.json` and `junit.xml`. A step that would need the agent, because it has no usable recording, fails with `ACT_NO_AGENT` and the run exits 1. Add selectors to run part of the suite; scenarios that were never characterized, or whose recording was discarded, need the agent.
- `ai-bdd verify-run <runDir>` recomputes the hashes of the run's evidence: exit 0 with `OK`, exit 1 listing what differs.

`--no-agent` stops the agent, not the judge. A subjective step is judged on every run, from the verdict cache in `.ai-bdd/cache/` when it holds the verdict and by a model call when it does not. The cache is not committed, so a fresh checkout calls the judge: `usage.byPurpose.judge.modelCalls` is above 0 and `usage.byPurpose.act.modelCalls` is 0. `usage.modelCalls` is 0 only when no step needs the judge or the cache is warm.

## `prune`

```sh run in=project
ai-bdd prune --dry-run
```

Deletes recordings whose scenario exists in no plan (for example after a rejected or removed feature). `--dry-run` lists them. Refused when recordings are read-only.

## `doctor`

```sh run in=project
ai-bdd doctor --offline
```

Checks Node version, config loading, the drivers (at least one configured, a usable `defaultDriver`, and each driver's `selfCheck`: can its browser or device be reached?), the models (configured at all, and without `--offline` every distinct model id probed with a minimal request, which can cost a few tokens) and plan freshness, and prints `[ok]` or `[FAIL]` per check. Exit 1 if any fails. A failing driver or an unreachable model is reported as a failed check instead of crashing, so run it first after changing `drivers` or `models`. A `use` package that cannot be loaded fails earlier, while the config loads (`CONFIG_INVALID`, exit 2).

## Environment variables

| Variable | Effect |
|---|---|
| `CI=true` or `CI=1` | CI defaults: `run` is `--frozen`, recordings are read-only. |
| `AI_BDD_RECORDINGS` | `read-write`, `read-only` or `off`. Overrides the CI default. `off` neither reads nor writes recordings. |
| `AI_BDD_DEBUG=1` | Stack traces for unexpected errors. |
| `AI_BDD_CHROMIUM_PATH` | Chromium executable for the Playwright driver. |
| `PLAYWRIGHT_BROWSERS_PATH` | Where the Playwright driver looks for browsers. |
| Names listed under `secrets` in config | The secret values (at least 4 characters). Every printed line is scrubbed of them. |
| `AI_BDD_MODEL`, `AI_BDD_JUDGE_MODEL` | Read by the demo project's `ai-bdd.config.mjs` (`packages/testing/corpus`), not by the CLI. Your own config decides which variables it reads. |
| Provider keys (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, ...) | Read by your model adapter (the AI SDK), not by the CLI. |

The CLI has no test or demo mode: it always uses the drivers and models your config plugs in. To run it without a model or a browser (ai-bdd's own tests do), write a config file that plugs in deterministic doubles and select it with `-c`; see [sdk.md](sdk.md#test-doubles).

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
