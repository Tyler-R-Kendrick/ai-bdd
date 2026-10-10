# Concepts

The lifecycle in one picture:

```
docs/**/*.md ──discover──► chunks + sections ──┐
                                               ├─► compile ──► plan (committed JSON)
previous plan ──which sections are dirty?──────┘      (model calls only for dirty sections)

plan ──► run ──► per scenario: session → steps → status
                  │  first run:  characterize (agent + judge) → probe → confirm run → recording (committed JSON)
                  │  later runs: replay recording + generated checks, no model; fuzzy steps still use agent / judge
                  └► evidence (run dir) → reports
```

## Documents, chunks, sections

- A **chunk** is a block-level leaf of a markdown document: a heading, paragraph, list item, table body row, code block or blockquote. Each has an address (`docs/billing.md#billing/upgrading-to-pro/p2`), the plain text, a SHA-256 `hash` of that text, and its source range.
- A **section** is the unit of extraction: a heading of level 1 or 2 plus everything under it (`extract.sectionDepth`, default 2). Oversized sections (`extract.maxSectionChars`, default 12000) split at deeper headings, then at chunk boundaries (`…/part-1`, `…/part-2`).
- **Directives** are HTML comments (`<!-- ai-bdd: ignore -->`) that steer extraction and execution. See [authoring-docs.md](authoring-docs.md).
- Formatting inside a chunk is dropped (links keep their text, images their alt text), so a hash changes only when words change. Moving a paragraph changes its address but not its hash.

## Compile

`ai-bdd compile` turns changed sections into reviewable plan elements. It is explicit: `run` never extracts unless you let it compile stale docs first (not in CI).

1. **Find dirty sections.** A section is dirty if there is no plan, `--full` is set, its hash changed, or a feature or scenario sourced from it cites a chunk that vanished or changed. Before judging dirtiness the planner relocates references by hash: if exactly one current chunk has the old hash, the reference moves with it. Moving an unedited paragraph dirties nothing.
2. **Extract.** For each dirty section the extractor asks the `extract` model for features, user stories, scenarios and steps. The model sees chunk **handles** (`[c7]`), never real addresses, and the document text arrives inside `<document>` delimiters as untrusted data.
3. **Validate, deterministically.** The output must parse against a strict schema (one repair retry, then the section fails and keeps its previous features). Then:
   - unknown handles are dropped;
   - every cited quote must be a normalized substring of the cited chunk (case, whitespace, curly quotes and dash variants ignored; at least 12 characters unless the chunk is shorter);
   - a feature with no valid quote is dropped with all its scenarios, as is a scenario that cannot inherit grounding;
   - a step marked `quoted` without a valid quote is downgraded to `inferred`;
   - fixture calls must exist in the configured catalog, match its types, and every string argument must occur in the step text;
   - `<secret:name>` tokens must name configured secrets;
   - scenarios you rejected before are dropped.
4. **Merge.** New drafts are reconciled against the previous plan so ids and review states survive (below).

Recompiling an unchanged project makes zero model calls and rewrites nothing.

## Plan

One file per document: `.ai-bdd/plans/<docUri>.plan.json`, written with sorted keys, 2-space indent, LF, no timestamps, so diffs are minimal and byte-stable across machines.

A plan holds:

- **Features** (title, optional story `asA / iWant / soThat`, tags, sources) with **scenarios**, each with **steps** (`given` / `when` / `then`). Every element carries `sources`: `{chunkId, hash, quote, relation}`.
  - `relation: source` means "derived from this chunk". Edits to it make the element stale.
  - `relation: context` means supporting material. Edits only warn (`PLAN_CONTEXT_CHANGED`).
  - A step with `grounding: inferred` is a reasonable inference, not a quote (for example "navigate to the billing page"). Reviewers see these flagged.
- **Coverage**: `uncovered` (content chunks no element cites) and `notTestable` (chunks the model judged unobservable through the UI, with a reason, for example a latency target).
- **Review state** per feature and scenario: `unreviewed`, `accepted`, `rejected`. **Pinned** features are never overwritten by a recompile.
- **`rejected`**: fingerprints of rejected scenarios. They never run and are never proposed again.

**Ids** are stable and human-readable. Feature: `<doc-slug>--<title-slug>`. Scenario: `<feature-id>/<title-slug>`. Step key: `<kind>:<12 hex of the normalized text hash>`.

**Reconciliation.** When a section is re-extracted, each new draft is matched to a previous element by equal fingerprint, then equal normalized title, then token similarity of 0.6 or more. A match inherits the id. Review state survives only if the fingerprint (title and step texts) is equal; any real change resets it to `unreviewed`. Unmatched previous elements are removed.

**Status** of a doc: `new` (no plan), `fresh`, `stale` (a dirty section or a pinned feature with changed sources), `orphaned` (plan without a doc). `--frozen` runs and `compile --check` fail with exit 4 unless every doc is `fresh`.

## Run

`ai-bdd run` selects non-rejected scenarios (by id, id prefix ending in `/` or `--`, doc glob, `--tag`, `--grep`), opens one driver session per scenario, and processes steps in order. After the first `failed`, `blocked` or `error` step the remaining steps are `skipped`. Scenarios run concurrently (`--workers`, default 4) in isolated sessions.

Per step:

| Step | Path | What happens |
|---|---|---|
| `given` with a fixture | `fixture` | The configured setup function runs; its cleanup runs at the end, in reverse order. |
| `given` that needs data the UI cannot create, without a fixture | blocked | `FIXTURE_REQUIRED`, with a ready-to-paste fixture stub in the error details. Nothing is improvised through the UI. |
| `given` / `when` (action) with a deterministic recording | `replay` | Re-target by selector, perform, verify the recorded effect. Zero model calls. |
| action, replay diverged | `heal` | The agent redoes the step with the old actions as hints. Status `healed`. |
| action, fuzzy or no recording | `agent` | The agent acts (the recording is created if this is a characterization). |
| `then` with a deterministic check | `check` | Evaluate the predicate program against the settled page. Zero model calls. |
| `then`, fuzzy or subjective | `judge` | The judge evaluates the criterion each run. |
| `then`, no recording | `check+judge` or `judge` | Judge first, then generate a check (below). |

A `then` step is only evaluated on a **settled** page: no ARIA busy signal and an unchanged accessibility tree for `settle.quietMs` (300 ms). If the page does not settle within `settle.timeoutMs` the step fails with `SCREEN_NOT_SETTLED`. CSS-only animations carry no ARIA signal and are invisible to settle.

**Statuses** and precedence for a scenario: `error` > `failed` > `inconclusive` > `blocked` > `healed` > `passed` > `skipped`. `healed` passes unless `--strict`, and is reported prominently.

**Modes**: `characterize` (no usable recording, or `-u`), `replay` (every step has a valid recording), `mixed` (a prefix replays, the rest characterizes).

## Characterization

A characterization run produces recordings. The design question is how to avoid baking in a bug, because the first run records what the app *does*, while the doc says what it *should* do.

- **The doc is the oracle.** On the first run every `then` step goes to the judge first, with the criterion text, before and after accessibility trees, and no knowledge of what the agent did. If it does not pass, nothing is generated. A recording is saved **only if the whole scenario passes**.
- **Actions** become an **ActProgram**: semantic selectors (role, accessible name, up to three named ancestors, and `index` among `of` matches) plus an **effect signature** (elements that appeared or disappeared, state or value changes, route before and after). Volatile names and anything that is not stable on a delayed probe are excluded.
- **Assertions** become a **CheckProgram**: a small declarative predicate list over the accessibility tree (`exists`, `count`, `text`, `state`, `route`). There are no regexes. It is classified `change` (false before, true after) or `invariant` (no action preceded it).
- **Probe.** After the action the engine waits `characterize.probeMs` (500 ms) and observes again. A check must hold on both observations, and must not touch content that differs between them.
- **Discriminative.** A `change` check must be false on the *before* state. Volatile-looking literals (times, dates, UUIDs, hex ids, long numbers, "5 minutes ago") are rejected unless the step text itself contains them.
- **Confirm run.** After the scenario passes, `characterize.confirmRuns` (1) fresh sessions replay the new recording with no healing. A step that fails confirmation is reclassified `fuzzy`; if the scenario cannot pass after that, the recording is discarded and the scenario fails with `CHARACTERIZATION_UNSTABLE`.
- **Prefix invalidation.** When you edit a step, recordings for earlier steps stay valid and later ones are discarded (state after the edit is unknown). The run is `mixed`. A change of the driver's **major** version invalidates everything.

Replay is not "click and hope": the recorded effect must be **observed again and be newly true**. An effect that already held before the replay never verifies. A no-op regression therefore shows up as a divergence, never a silent pass.

## Deterministic and fuzzy

A step is **deterministic** only because the engine demonstrated it. Otherwise it is **fuzzy** and keeps running through the agent or judge, with a reason code you can act on:

| Reason | Meaning | Typical fix |
|---|---|---|
| `directive` | The doc says `fuzzy` (or the scenario has tag `@fuzzy`). | Intended. |
| `subjective` | A `then` step judged a matter of taste ("feels friendly"). | Intended, or make the criterion observable. |
| `volatile-content` | A check would depend on content that changes (timestamps, ids, counters). | Assert something stable; or accept fuzzy. |
| `check-not-discriminative` | No check could be found that is false before and true after. | Make the expected change visible in the UI text or ARIA state. |
| `check-generation-failed` | The model never produced a valid check. | Rephrase the criterion; inspect `checkgen` artifacts. |
| `no-observable-effect` | The action changed neither the tree nor the route. | Add visible feedback, or accept fuzzy. |
| `coordinate-action` | The target had no role or accessible name. | Give the control an accessible name. |
| `confirm-replay-failed` | The action did not replay in a fresh session. | Usually environment-dependent behaviour. |
| `confirm-check-failed` | The check failed in the confirm run. | Same. |
| `heal-threshold` | The step healed `characterize.healThreshold` (2) times and was demoted. | The UI keeps changing; review the step. |
| `agent-only-driver` | The driver lacks verbs needed to replay. | Use a fuller driver. |

`ai-bdd show --recordings` lists the determinism and reasons per step. Fuzziness costs model calls on every run, so each reason is something to fix in the doc or the app, not noise.

## Judge

The judge sees only a `JudgeRequest`: criterion, parameters, before and after tree text (redacted, refs removed, truncated to `judge.maxTreeChars`), optionally masked screenshots, and whether an action preceded. The type has no field for agent transcripts or action summaries, so it cannot be told what the agent claims it did.

It takes `judge.samples` (3) votes at temperature 0.7. A vote is a probability; a verdict that contradicts its probability counts as 0.5. Aggregation: spread above `judge.maxSpread` (0.5) is `inconclusive` (`reason: spread`); mean at or above `passThreshold` (0.8) passes; at or below `failThreshold` (0.3) fails; in between is `inconclusive` (`reason: band`). Pass and fail verdicts are cached in `.ai-bdd/cache/judge/` by a hash of the evidence; every judgment is appended to `.ai-bdd/cache/judgments.jsonl`.

`ai-bdd run --audit` also runs the judge next to each deterministic check and fails on disagreement (`CHECK_JUDGE_DISAGREEMENT`).

## Files in a project

| Path | Committed | Written by |
|---|---|---|
| `ai-bdd.config.ts` / `.mjs` / `.js` / `.json` | yes | you |
| `.ai-bdd/plans/<docUri>.plan.json` | yes | `compile` |
| `.ai-bdd/recordings/<driverId>/<scenarioId>.json` | yes | `run` (read-write mode only) |
| `.ai-bdd/cache/` (judge cache, `judgments.jsonl`) | no | `run` |
| `.ai-bdd/runs/<runId>/` (artifacts, `manifest.json`, `events.jsonl`, reports) | no | `run` |
| `.ai-bdd/report/` (latest `report.json`, `junit.xml`, `summary.md`) | no | `run` |

Recordings are per driver: switching driver means characterizing again.

## Residual risks

- A judge that approves a wrong first run produces a recording that encodes the bug. Mitigations: multi-sample scoring with an inconclusive band, `notTestable` and `subjective` routing, human review of recordings ([review-guide.md](review-guide.md)), `--audit`, `judgments.jsonl` for later calibration.
- A weak-but-discriminative check can keep passing after an unrelated regression. Doc edits invalidate affected recordings, and `--audit` compares checks with the judge.
- Determinism is demonstrated on one confirm run by default. Raise `characterize.confirmRuns` for flaky apps.
