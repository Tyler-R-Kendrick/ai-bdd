# FAQ

## Why not Gherkin or Gauge?

Because the documents already exist and are written as prose. Requirements, READMEs and runbooks do not come as `.feature` files, and keeping a second copy in sync is the maintenance problem ai-bdd removes: the plan cites the exact paragraph and quote behind every step, so the prose stays the source of truth. Gherkin also needs step definitions, which are code someone writes and maintains; here the recording is the executable artifact, produced and verified by the engine.

Nothing stops structured input: the `Extractor` interface is a seam where a deterministic `.feature` or Gauge reader could be added later, producing the same plan format.

## Why not snapshot the screen (pixels or DOM)?

Pixel and DOM snapshots break on every cosmetic change and say nothing about intent. ai-bdd records *semantics*:

- for actions, a selector made of role, accessible name and named ancestors, plus the **effect** the action had (what appeared, disappeared or changed, route before and after);
- for assertions, a small predicate list over the accessibility tree.

Neither mentions colours, layout or markup. Screenshots are used only as optional evidence for a vision-capable judge, and only when no secret could be in them. Visual regression is a different job; the `RunEvent` stream and `ai-bdd` artifacts can feed a tool built for it.

## Why a separate compile step?

If extraction ran inside `run`, tests would change on every run. Compile makes extraction a reviewed, committed artifact. Unchanged documents recompile byte-for-byte with zero model calls, and CI runs `--frozen`, so a stale plan fails the build (exit 4) instead of silently testing something else.

## What does "deterministic" mean here?

A step is **deterministic** when the engine *demonstrated* that it can be reproduced without a model:

- an action step has a replay program whose effect was observed in the original run, did not depend on volatile content, and replayed in a fresh session in the confirm run;
- a `then` step has a predicate check that is false before the action, true after, true again on a delayed probe, free of volatile literals, and that agreed with the judge when recorded (`check+judge`).

It does **not** mean the application is deterministic, or that the test can never go red. On replay the effect must be observed again and be newly true, and checks are evaluated on the live page, so a regression fails (`CHECK_FAILED`) or heals visibly (`healed`), never passes silently. Everything else is `fuzzy` by name, with a reason code ([concepts.md](concepts.md#deterministic-and-fuzzy)), and keeps using the agent or judge on every run.

## How do I know the first run did not record a bug?

You do not, automatically; this is the design's main residual risk. The protections:

- The oracle is the document. The judge evaluates the doc's criterion against the page; the recording is saved only if the whole scenario passes.
- The judge never sees the agent's actions or narrative.
- It takes several samples and has an `inconclusive` band; ambiguous verdicts are not recorded.
- Recordings are committed and reviewable ([review-guide.md](review-guide.md)): predicates, selectors and effects are readable.
- `--audit` re-runs the judge next to the checks and fails on disagreement; `.ai-bdd/cache/judgments.jsonl` keeps every judgment so you can measure your judge.

Look at the app yourself the first time you characterize a feature.

## How much does it cost?

Rough shape, per model purpose:

| Purpose | When it is called |
|---|---|
| `extract` | Once per **dirty** section at compile; zero for unchanged docs. |
| `act` | Per turn of the agent on a characterization, on every `fuzzy` action step, and when healing. Zero on replay. |
| `judge` | 3 samples per judged `then` step: on characterization, on every `fuzzy` or `subjective` `then`, and with `--audit`. Pass and fail verdicts on identical evidence are cached. |
| `checkgen` | 1 to 3 calls per characterized `then` step. |

So the steady state of a healthy suite is zero model calls, and cost is proportional to what is fuzzy. Every report prints model calls and tokens per purpose; set `prices: { '<modelId>': { inputPerMTok, outputPerMTok } }` in config to get `estimatedCostUsd`. To reduce cost: fix `fuzzy` reasons (stable text, accessible names, observable feedback), keep subjective criteria few, use a cheaper `act` model than `judge`, and run `ai-bdd run --no-agent` in CI if you want proof that nothing needs a model.

## Which models should I use?

Anything the AI SDK can reach that supports tool calls and structured output. The model ids in the templates are examples. Use a **different** model for `judge` than for `act`: if both are the same id, the engine emits the warning `JUDGE_SAME_AS_ACTOR`, because a model tends to approve its own mistakes. A vision-capable judge can use masked screenshots (`judge.vision`). To use another provider, write a `ChatModel` adapter ([sdk.md](sdk.md#models)).

## Why was my scenario `blocked`?

A `Given` that needs data the UI cannot create ("a customer with two unpaid invoices") has no fixture. The report prints a ready-to-paste fixture stub. Register the fixture in config and recompile ([authoring-docs.md](authoring-docs.md#fixtures)). The agent will not improvise database state through the UI.

## Why `inconclusive`?

The judge's samples disagreed (spread above `judge.maxSpread`) or the mean score fell between `failThreshold` and `passThreshold`. Make the criterion in the doc more concrete, or accept it as subjective.

## Why `ACT_TARGET_AMBIGUOUS`?

The page has several controls with the same role and name (two "Submit" buttons) and the step text does not name any distinguishing region or dialog. This is deliberate: a recording that clicked an arbitrary one would pass while testing the wrong thing. Mention the region in the doc ("submits the Shipping section").

## Why `SCREEN_NOT_SETTLED`?

Assertions only run on a settled page: not busy, and unchanged for `settle.quietMs`. A page that keeps changing (a clock, an animation, polling) never settles within `settle.timeoutMs`. Report loading with `aria-busy` or a progress role, or stop the churn in test builds. `settle.requireSettled: false` disables the gate and is rarely wise.

## A step became `healed`. Is that good?

It means the recording no longer matched, the agent redid the step, and the judge approved the result. The UI changed, or a regression was routed around. It passes (unless `--strict`) but is listed prominently: read the re-recorded actions in the diff. After `characterize.healThreshold` (2) heals the step is demoted to `fuzzy`.

## Do I commit recordings?

Yes: `.ai-bdd/plans/` and `.ai-bdd/recordings/`. Review them like snapshots. CI runs with read-only recordings and never writes them. Do not commit `.ai-bdd/runs/`, `.ai-bdd/cache/` or `.ai-bdd/report/` (`ai-bdd init` ignores the first two; add the third, see below).

```text
.ai-bdd/runs/
.ai-bdd/cache/
.ai-bdd/report/
```

## Can I edit the plan by hand?

Prefer editing the document. A hand-edited feature survives recompiles only if it is **pinned** (`ai-bdd review pin <id>`); otherwise a re-extraction of its section may replace it. Plan files are validated strictly on load.

## Can it test things other than web apps?

The engine only needs a `Driver`: an accessibility-style tree to observe, actions to perform and a navigation policy. Only the Playwright driver and the Acme fake driver ship today ([drivers.md](drivers.md#writing-a-driver)).

## How does it behave in parallel and in CI?

Scenarios run in isolated sessions, `--workers` at a time. A driver's `maxSessions` caps its own sessions and `exclusiveResource` serializes sessions that share a world. In CI (`CI=1`) runs are frozen and recordings read-only; shard by selector or tag. Characterize locally, commit, replay in CI.

## Why Node 22.18 or newer?

The config and workspace sources are TypeScript run with Node's native type stripping, and the toolchain (commander 15, vitest 5) requires it. Use `.mjs` or `.json` config if your runtime cannot import `.ts` (`CONFIG_TS_UNSUPPORTED`).

## Why do fake-model runs take seconds?

Characterization waits in real time (settle windows, the 500 ms probe, a confirm run in a fresh session). Replays are much faster.

## Where do I look when something fails?

1. The run summary and `.ai-bdd/report/summary.md` (failure, error code, first failing step).
2. `ai-bdd show <id> --recordings` for what was recorded.
3. `.ai-bdd/runs/<runId>/artifacts/`: observations, agent transcripts, judge requests and responses, check-generation attempts, extraction requests and responses, all redacted. `events.jsonl` has the step timeline.
4. [errors.md](errors.md) for the code.
