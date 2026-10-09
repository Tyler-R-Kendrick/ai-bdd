# FAQ

## Why not use Gauge's own runner?

Gauge's runner validates that **every step has an implementation before execution**. That is a
good design for a deterministic runner and a fatal one for an AI fallback: there is no way to
say "this step has no binding yet, let the agent try". A custom Gauge language runner could
work around it, but it would be a plugin built on Gauge's gRPC protocol, which the
specification explicitly excludes from scope.

ai-bdd therefore reads Gauge-format files with its own runner. It is **Gauge-format
compatible**, never a Gauge plugin. The parser is validated against a conformance corpus
derived from Gauge's documented syntax (`packages/spec-gauge/test/corpus/`).

## Why not use e2e as the base?

Because e2e's agent is only available inside an e2e `test()` body, and its programmatic
`run()` is not exported (verified: `e2e/runner` exports exactly `ConfigurationError`,
`isE2EError`, `list` — see [the log](verification-log.md#v1--public-e2e-surface-f-e1)). Building
the product on private module paths would be fragile, and it would couple a driver-agnostic
system to one vendor.

e2e is integrated in exactly two public ways:

1. `@ai-bdd/driver-e2e` — an MCP client of `e2e mcp`, giving raw observe/act for web and
   mobile targets configured in `e2e.config.ts`.
2. `@ai-bdd/e2e-host` — a module that e2e's own runner imports as a test file. During module
   evaluation it reads ai-bdd specs, registers one `e2e test()` per scenario, routes unbound
   actions to e2e's `agent.act` (gaining e2e's native replay cache) and unbound assertions to
   ai-bdd's judge.

Because `run()` is not exported, the host generates a static registration file from the specs
(`ai-bdd e2e-host generate`) when top-level-await registration is not collected. That
generated file is committed.

## Why does the judge not see what the agent did?

Because an agent that is told "you just upgraded the plan" will tend to agree that the plan was
upgraded. The judge sees the criterion, the before/after evidence and the app vocabulary. A
canary test injects distinctive tokens into the act transcript and asserts that none of them
appear in the judge prompt.

## Why is a generated check rejected so often?

By design. A check that is true on the before state as well as the after state proves nothing,
and it would produce a false pass forever. The generator retries
(`assertions.checkGen.maxAttempts`), and when it cannot produce a discriminative program the
step falls back to judge-only, which is flagged in the report. If you want that to be a hard
failure, set `assertions.requireDeterministic: true`.

## Why is a healed step not a pass?

A healed step means the cached recording no longer matched the app and the agent had to finish
the job. That is usually a real UI change. It is reported as `healed`, counted separately, and
becomes a failure under `--strict-cache` (the default in `--frozen` CI).

## Do I need a model to run my existing bindings?

No. Exact bindings, deterministic checks and cached replays make zero model calls. The model is
only needed for semantic resolution of new sentences, act recording, check generation and the
judge.

## How much does a run cost?

The markdown report prints model calls, tokens and an estimated cost per run when you fill in
`prices`. Judge calls happen on every assertion by design (they are evidence); act replays,
deterministic checks and embeddings are cached, and verdicts are reused only on byte-identical
inputs.

## Can I use my existing Cucumber/Behave/pytest-bdd/Reqnroll/Godog steps?

Yes, and they keep winning over ai-bdd's catch-all. "Zero glue" is never claimed: each plugin
documents its exact minimum glue (one import line for cucumber-js, one `install()` call for
Behave, one `scenarios(...)` line for pytest-bdd, a package reference for Reqnroll, one
`Register(ctx)` line for Godog). See [Plugins](plugins.md).

## What about Windows and mobile?

Node `^22.22.3 || >=24.8.0` matches e2e. Cua drives native Windows desktops; e2e runs on
Windows only inside WSL. Mobile is reached through e2e targets (agent-device under the hood) —
there is no separate mobile driver.

## Is the visual gate included?

No. ai-bdd ships the hook interface (`hooks.visualGate`), a no-op implementation and tests. The
diff engine itself is out of scope.
