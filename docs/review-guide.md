# Review guide

ai-bdd commits two kinds of generated artifacts. Both are small, sorted JSON, made to be read in pull requests, like snapshots:

- **Plans** (`.ai-bdd/plans/**/*.plan.json`): what the model extracted from your docs.
- **Recordings** (`.ai-bdd/recordings/<driver>/**/*.json`): how each scenario is reproduced without a model.

A human is the last line of defence against two failure modes: the model inventing or mis-reading a requirement (plan), and the first run approving an app bug that then becomes the baseline (recording).

## Reviewing a plan

Do not read the JSON. Read what `show` renders:

```sh
ai-bdd show docs/billing.md          # one document
ai-bdd show docs-billing--downgrade-from-pro   # one feature (or scenario id, or id prefix)
ai-bdd status                         # what is stale, uncovered, notTestable, unreviewed
```

`show` prints Gherkin with the evidence under each step:

```text
Feature: Upgrade to Pro  [unreviewed]
  # id: docs-billing--upgrade-to-pro
  As a account owner
  I want to upgrade my account to the Pro plan
  # source: docs/billing.md:21 "Customers on the Free plan can upgrade from the billing page"

  Scenario: Upgrade from Free to Pro  [unreviewed, start=/settings/billing]
    When the customer clicks the upgrade button
      # source: docs/billing.md:23 "Clicking the upgrade button opens a confirmation dialog"
    Then the plan changes to Pro
      # source: docs/billing.md:25 "the plan changes to Pro"
```

### Plan checklist

1. **Does each quote support its step?** The quote is guaranteed to exist in the cited chunk (ungrounded output is dropped), but not to *mean* what the step says. Read the pair.
2. **Look for `inferred` steps.** They have no quote on purpose (a reasonable inference such as navigating to a page). Check that the inference is right.
3. **Missing coverage.** `ai-bdd status` lists `uncovered` chunks: content that no scenario cites. For each, decide: a requirement the model missed (rephrase the doc so it is observable), or genuinely not testable (leave it, or add `<!-- ai-bdd: ignore -->`).
4. **`notTestable`.** Each entry carries a reason. Confirm that it is true (a latency target is; "the page shows the total" is not).
5. **Fixtures.** For `Given` steps with a fixture, check the arguments against the sentence.
6. **Tags, `start`, `driver`.** These come from directives; confirm they landed on the right scenarios.
7. **Duplicates and noise.** Two scenarios that check the same thing, or a scenario with nothing to verify, are rejected, not fixed.
8. **Injected content.** Documents are untrusted input. A scenario that no sentence of the doc motivates, or one that acts outside the product (deleting users, visiting an external site), is a red flag. Reject it and investigate the doc.

### Acting on the review

```sh
ai-bdd review accept docs-billing--upgrade-to-pro          # a feature accepts all its scenarios
ai-bdd review reject docs-billing--upgrade-to-pro/upgrade-button-is-visible-on-the-free-plan
ai-bdd review pin docs-billing--downgrade-from-pro         # keep this feature as it is on recompiles
ai-bdd review unpin docs-billing--downgrade-from-pro
```

- **accept** marks it reviewed. Review state is attached to the scenario's *fingerprint* (title and step texts). If a recompile changes the content, the state resets to `unreviewed`, so a changed scenario is never silently trusted. Unchanged scenarios keep their id and state across recompiles and section edits.
- **reject** stores the fingerprint. The scenario never runs and is never proposed again, even after `compile --full`. Rejecting a feature rejects all its scenarios.
- **pin** protects a feature from being overwritten. If its source chunks later change, `compile` warns with `PLAN_PINNED_STALE`, `status` lists it under stale features, the doc is `stale`, and `--frozen` fails until you unpin and recompile or accept the drift.

Unreviewed scenarios still run. The run report lists "Unreviewed scenarios that ran" so you can enforce your own policy (for example fail the CI job when that list is not empty).

### Reading a plan diff in a PR

Typical, healthy diffs:

- A doc edit touches one section: only that section's features change. Everything else is byte-identical.
- A paragraph moved: refs get new chunk ids, no content changes.
- A title tweak by the model with the same steps: same id, same review state.

Investigate:

- Many features changed after a small doc edit (a heading was renamed or the doc was reflowed so hashes changed).
- A feature disappeared: its section failed extraction (`EXTRACT_SECTION_FAILED`; the previous features are *kept*, not removed, so check the compile output) or the model stopped proposing it.
- `extractor.modelId` or `promptVersion` changed: expect broad wording churn.

## Reviewing recordings

```sh
ai-bdd show docs-billing--upgrade-to-pro --recordings
```

adds, under every step:

```text
    When the customer clicks the upgrade button
      # determinism: deterministic
      # replay: 1 action(s)
    Then the confirmation dialog shows the prorated charge
      # determinism: deterministic
      # check: change, 2 predicate(s)
    Then the new todo shows the time it was added
      # determinism: fuzzy (volatile-content)
```

Then open the JSON for the steps that matter. A recording step looks like this (trimmed):

```json
{
  "kind": "then",
  "stepKey": "then:a1356eec4635",
  "determinism": "deterministic",
  "check": {
    "classification": "change",
    "predicates": [
      { "op": "exists", "query": { "role": "dialog", "name": "Confirm upgrade" } },
      { "op": "text", "match": "contains", "value": { "literal": "$12.50" },
        "query": { "role": "paragraph", "within": { "role": "dialog", "name": "Confirm upgrade" } } }
    ],
    "verified": { "beforeFalse": true, "afterTrue": true, "probeTrue": true, "judgePassed": true }
  },
  "stats": { "healCount": 0 }
}
```

and an action step:

```json
{
  "kind": "when",
  "determinism": "deterministic",
  "act": {
    "actions": [
      { "verb": "click",
        "target": { "role": "button", "name": "Upgrade to Pro", "ancestors": [{ "role": "region", "name": "Plan" }], "index": 0, "of": 1 } }
    ],
    "effect": { "appeared": [ { "role": "dialog", "name": "Confirm upgrade" } ], "disappeared": [], "changed": [],
                "routeBefore": "/settings/billing", "routeAfter": "/settings/billing" }
  }
}
```

### Recording checklist

| Look at | Good | Red flag |
|---|---|---|
| Check predicates | They say the thing the sentence says: a dialog exists, text contains the prorated amount, a state is `true`. | Only `exists` of a generic role (`main`), or a predicate the step text does not motivate. A check that cannot fail does not protect you. |
| `classification` | `change` for a `then` after an action. | `invariant` after an action passes even if the action did nothing. Fine when the sentence states a standing fact ("the upgrade button is visible while on Free"), suspicious otherwise. |
| `verified` | `beforeFalse: true` (for `change`), `afterTrue`, `probeTrue`, `judgePassed` all `true`. | `beforeFalse: null` on a `change` check. |
| Literals in `text` predicates | Strings from your doc, the step text, or a `{param}`. | A literal copied from data that varies by account, date or environment. |
| Selectors | A role plus an accessible name, with a distinguishing `ancestors` entry when `of` is greater than 1. | `index` greater than 0 with `of` greater than 1 and no ancestors: replay depends on DOM order. |
| Effect signature | The stable consequences of the action. Volatile elements (times, counters) are excluded by design, so an add-to-list effect may list only the vanished "No todos yet". | Empty effect with the same route: the step is then `fuzzy` (`no-observable-effect`), not deterministic. |
| `fuzzyReasons` | Each reason is intended or you have a plan to fix it ([concepts.md](concepts.md#deterministic-and-fuzzy)). | Many `check-not-discriminative` or `check-generation-failed`: the page gives the checker nothing to hold on to. |
| `stats.healCount` | 0. | 1 means the step healed once; at the threshold it is demoted to fuzzy. |

Also read the **run output** that created the recording: the first run must show the judge passing every `then` step. If a scenario passed because the agent's story was convincing but the page is wrong, the judge saw the page, not the story; still, verify the screen at least once by eye.

### What a healthy PR looks like

- `.ai-bdd/recordings/` gains files only for newly accepted scenarios, or changes only for steps whose text changed. A changed recording for an *unchanged* step means the app changed (a heal) or you re-characterized with `-u`: ask why.
- No file is `discarded`: the run summary says `Recordings (read-write): N created, M updated`.
- `ai-bdd run` on the PR branch with `CI=1` replays everything without model calls (`Model calls: 0` plus the fuzzy steps).

### When replay diverges later

| Report shows | Meaning | Do |
|---|---|---|
| `healed` step | The recorded selector or effect no longer matched; the agent redid it and the judge agreed. | Read the diff of the re-recorded actions. The UI changed, or the app has a regression the agent routed around. Under `--strict` this fails. |
| `CHECK_FAILED` with predicate actuals | The page no longer satisfies a check. No judge call was made. | Real regression, or an intended change: update the doc, recompile, run with `-u`. |
| `CHECK_JUDGE_DISAGREEMENT` (`--audit`) | The cheap check and the judge disagree. | Inspect which one is right. A check that passes while the judge fails is too weak; sharpen the criterion in the doc and re-characterize with `-u`. |
| `REPLAY_DIVERGED` (`--strict`) | Healing was needed and is forbidden. | Same as `healed`. |
| `CHARACTERIZATION_UNSTABLE` | The recording did not survive its own confirm run. | The scenario is flaky, or a fixture is not idempotent. |

To rebuild recordings after an intended UI change: `ai-bdd run -u <selector>` locally (not allowed in CI unless `AI_BDD_RECORDINGS=read-write`), review the diff, commit.

## Evidence

Each run keeps `.ai-bdd/runs/<runId>/` (not committed): `artifacts/` named by content hash (observations, screenshots, agent transcripts, judge requests and responses, check generation attempts, `extract-request`/`extract-response`), `events.jsonl`, `manifest.json` and the reports. `ai-bdd verify-run <runDir>` detects corruption or edited artifacts ([security.md](security.md#evidence-integrity) for what that does and does not prove). `.ai-bdd/cache/judgments.jsonl` keeps every judgment (criterion, evidence hashes, samples) for later calibration of your judge.
