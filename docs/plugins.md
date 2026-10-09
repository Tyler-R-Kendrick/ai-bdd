# Plugins

ai-bdd ships thin plugins for the mainstream BDD frameworks. A plugin discovers or launches the
daemon, registers local bindings, installs a catch-all step definition, opens one session per
scenario, and forwards each step to the daemon. Local bindings still execute **in your
language**; the daemon orchestrates.

"Zero glue" is never claimed. The table below is the exact minimum.

| Framework | Package | Minimum glue | Binding declaration | Coexistence |
| --- | --- | --- | --- | --- |
| cucumber-js 13.x | `@ai-bdd/cucumber` **(reference implementation, shipped)** | `--import @ai-bdd/cucumber/register` in your `cucumber.js` profile | `import { Given, When, Then, bind } from '@ai-bdd/cucumber'` (same signatures as Cucumber, plus an optional options object) | `register({ coexist: true })` builds the catch-all as a negative lookahead over your own patterns |
| Cucumber-JVM 8.x | `dev.ai-bdd:ai-bdd-cucumber` | the dependency on the classpath (ServiceLoader `BackendProviderService`) plus `ai-bdd.properties` | `@AiBddStep(pattern = …, description = …, kind = …)` on public methods in glue packages | the same negative-lookahead approach, computed from the glue the backend receives |
| Behave 1.3.x | `ai-bdd-behave` | `from ai_bdd_behave import install; install()` at the end of `features/steps/zz_ai_bdd.py` | normal `@given`/`@when`/`@then` (first match wins), plus `describe(func, description=…, examples=…)` | native: Behave's first-match order already prefers your steps |
| pytest-bdd 9.0 | `ai-bdd-pytest` | one test module containing `scenarios("features/")` (the plugin is a `pytest11` entry point) | normal steps plus `@ai_bdd_pytest.describe(…)` | native by fixture specificity |
| Reqnroll | `AiBdd.Reqnroll` | the package reference plus the plugin entry in `reqnroll.json` | `[AiBddStep("pattern", Description = "…")]` or your existing `[Given]`/`[When]`/`[Then]` | a replacement `IStepDefinitionMatchService` returns native matches first and delegates to the daemon only on none or ambiguous |
| Godog | `github.com/ai-bdd/ai-bdd-go/godogbdd` | `godogbdd.Register(ctx)` as the last line of `InitializeScenario` | `godogbdd.Bind(ctx, pattern, description, fn)` | native first-match in non-strict mode; in strict mode all bindings must use `Bind` |

## Why a catch-all, and why "register last" is not enough everywhere

The plugin installs one catch-all step definition (`^(.*)$`) that forwards unknown steps to the
daemon. Whether that creates ambiguity depends on the framework — this was verified in source,
and it corrects a widespread assumption:

| Framework | What happens when two definitions match | Consequence |
| --- | --- | --- |
| cucumber-js 13.x | `AMBIGUOUS` status; every definition whose `matchesStepName` is true is collected | register the catch-all **last** is not enough: use the negative lookahead in coexist mode, or let ai-bdd own the steps |
| Cucumber-JVM 8.x | `AmbiguousStepDefinitionsException` | same: negative lookahead over discovered glue |
| Behave 1.3.x | first match wins in registration order, and step-type lists are searched before the generic list | a generic catch-all registered last is safe |
| pytest-bdd 9.0 | every matching step fixturedef is collected and the most specific (by fixture path) is injected | safe: your `conftest` steps are more specific |
| Reqnroll | `AmbiguousSteps` unless scope matching differs (more scope matches win) | the replaced match service handles it |
| Godog | first match in registration order; in `Strict` mode multiple matches are `ErrAmbiguous` | safe non-strict; in strict mode all bindings must go through `Bind` |

Also note: Behave's custom matchers and pytest-bdd's parsers are **per definition**. They cannot
compute a global top-1/top-2 margin across all bindings, so global semantic resolution always
happens in the daemon behind the catch-all.

## What a plugin does per step

1. `aibdd_open_session` per scenario.
2. `aibdd_register_bindings` for local bindings (the server computes the hashes).
3. Per step: `aibdd_resolve_step`.
   - `next: 'invoke-local'` → call your function with the extracted parameters, then
     `aibdd_report_binding_result` (so evidence and timing are recorded).
   - `next: 'run-step'` → `aibdd_run_step` runs the act loop, the checks and the judge
     server-side.
   - `next: 'fail'` → map the error to your framework's ambiguous/undefined/failed status.
4. `aibdd_close_session`, then attach evidence by reference (path + sha256).

Plugins talk to the **HTTP JSON mirror** (`POST /v1/<tool>`, same schemas, keep-alive), not to
MCP: the mirror avoids MCP transport latency for a per-step call pattern, and both surfaces are
generated from one tool table so they cannot diverge.

## Conformance

Every plugin passes the plugin conformance suite: `packages/conformance/plugin/` ships feature
files plus a scripted fake daemon (`ai-bdd serve --fake`, deterministic responses from
`script.json`) and the expected result tables. Each plugin also has its own CI job.

## Adding a plugin

See `docs/BUILD-NOTES.md` for the environment and `docs/INTERFACES.md` for the tool contract.
The essential loop is above; the framework-specific parts are (a) the catch-all installation,
(b) the mapping from `StepResult` to the framework's statuses, and (c) the evidence attachment
API, which must be verified per framework and recorded in
[the verification log](verification-log.md).
