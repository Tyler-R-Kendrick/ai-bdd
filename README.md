# ai-bdd

Driver-agnostic, behavior-driven acceptance testing with **semantic step bindings** and
**AI fallback execution**, producing formal evidence for every step.

- **Gauge-style markdown is the primary format.** Specs run with no step code at all.
  Each step resolves through: exact binding → semantic match (embeddings + deterministic
  guards + validated parameter extraction) → agent fallback (act agent for actions, check
  plus judge for assertions).
- **Gherkin is a dialect of the same engine**, not a second one. Because the kind is
  explicit, ai-bdd can generate real step-definition source from cached recordings.
- **Assertions prefer determinism.** A generated `CheckProgram` is cached and must be
  *discriminative* (true on the after state, false on the before state); a judge model then
  scores before/after settled screenshots against the criterion text only.
- **Every resolution is reviewable.** Non-exact resolutions are written to
  `ai-bdd.lock.json`, which is committed and diffed in review.
- **Every step produces evidence**: content-addressed artifacts, a hash-chained manifest,
  optional ed25519 signing, and `ai-bdd verify-evidence`.

## 60-second quickstart

```bash
pnpm install
pnpm build

# 1. Run the fixture app (a dependency-free Node server)
node fixtures/app/server.mjs --port 0

# 2. Run a spec with the deterministic fake model and fake driver
AI_BDD_FAKE=1 node packages/cli/dist/bin.js run fixtures/specs/billing.spec.md

# fixtures/specs also holds the acceptance corpus: several files fail on purpose
# (the negation trap, the settle timeout, the judge band). See docs/status.md.
AI_BDD_FAKE=1 node packages/cli/dist/bin.js resolve fixtures/specs

# 3. Inspect what the run produced
head -40 .ai-bdd/report.json
node packages/cli/dist/bin.js verify-evidence .ai-bdd/runs/<runId>
node packages/cli/dist/bin.js codegen --framework cucumber-js
```

To point ai-bdd at a real browser and a real model, copy the config in
[`docs/config.md`](docs/config.md) into `ai-bdd.config.ts` and run
`node packages/cli/dist/bin.js run --driver web`.

## How a step resolves

| Stage | What happens | Failure code |
| --- | --- | --- |
| Exact | Cucumber Expression, regex, or Gauge `<param>` template matches the whole step | `STEP_AMBIGUOUS` (multiple matches) |
| Semantic | Embedding similarity ≥ threshold **and** top-1 − top-2 ≥ margin, then polarity/quantity/kind guards, then model parameter extraction validated deterministically | `STEP_AMBIGUOUS` (margin) |
| Agent (action) | Act loop with record/replay (`ActProgram`) and effect verification | `ACT_BUDGET_EXHAUSTED`, `ACT_TARGET_AMBIGUOUS` |
| Agent (assertion) | Generated `CheckProgram` + judge over settled before/after evidence | `CHECK_NOT_DISCRIMINATIVE`, `JUDGE_INCONCLUSIVE`, `SCREEN_NOT_SETTLED` |
| Setup | Never falls back to the UI by default (opt in with `resolution.allowAgentSetup`) | `SETUP_UNBOUND` |

## Repository layout

```
packages/contracts        shared contracts (normative)
packages/spec-gauge       Gauge markdown parser + concepts + printer
packages/spec-gherkin     Gherkin dialect adapter
packages/spec-directives  directive grammar, kind inference, lint rules
packages/registry         binding registry and exact matching
packages/semantic         embeddings, guards, parameter extraction
packages/lock             resolution chain + ai-bdd.lock.json
packages/cache            act/check caches and invalidation strategies
packages/act              act loop, ActProgram record/replay
packages/assert           CheckProgram generation, linting, evaluation
packages/judge            scored judge over before/after evidence
packages/evidence         content-addressed evidence, hash chain, signing, settle
packages/models           AI SDK adapter + deterministic fakes
packages/driver-fake      in-memory driver for CI
packages/driver-playwright, driver-e2e, driver-cua   real drivers
packages/runtime          scheduler, sessions, step pipeline, trace ids
packages/daemon           MCP (stdio, Streamable HTTP) + HTTP JSON mirror
packages/reporters        json, junit, markdown, cucumber-messages
packages/codegen          step-definition source from locked resolutions
packages/cli, packages/core   the ai-bdd binary and the TS facade
fixtures/app              dependency-free fixture web app (+ model.json)
fixtures/specs            shared spec corpus and goldens
fixtures/fake-model       deterministic fake model rules and synonyms
```

## Documentation

- [Concepts](docs/concepts.md) · [Gauge format](docs/gauge-format.md) ·
  [Gherkin dialect](docs/gherkin-dialect.md) · [Directives](docs/directives.md)
- [Resolution and lockfile review](docs/resolution-and-lockfile.md)
- [Assertions and judge calibration](docs/assertions-and-judge.md)
- [Caching and invalidation](docs/caching.md) · [Evidence and verification](docs/evidence.md)
- [Security model](docs/security.md) · [Errors](docs/errors.md) (generated)
- [Verification log](docs/verification-log.md) · [Build notes](docs/BUILD-NOTES.md) ·
  [Internal interfaces](docs/INTERFACES.md)

## Status

This repository is an in-progress implementation of the ai-bdd specification. What is
implemented, what is synthetic, and what is deferred is tracked in
[`docs/status.md`](docs/status.md) and [`docs/verification-log.md`](docs/verification-log.md).

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
