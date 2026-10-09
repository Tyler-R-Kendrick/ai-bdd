# @ai-bdd/cucumber

The cucumber-js plugin: one import, then every unbound step goes to the daemon.

## Minimum glue (documented, verified)

```js
// cucumber.js
module.exports = { default: { import: ['@ai-bdd/cucumber/register'] } };
```

```ts
// steps/billing.steps.ts — bindings stay in this process
import { Given, When, Then, bind } from '@ai-bdd/cucumber';

Given('Seed a workspace {string} on the {string} plan', 
  { description: 'Seeds a workspace with a name and a plan tier',
    examples: ['Seed a workspace "Acme" on the "free" plan'],
    counterExamples: ['Seed an empty workspace'] },
  async ({ name, plan }) => seedWorkspace(name, plan));
```

The signatures match Cucumber's; the optional second argument carries the semantics the resolver
needs (description, examples, counter-examples, kind, declared parameters).

## Why a catch-all, and why "register last" is not enough

cucumber-js collects **every** definition whose `matchesStepName` is true and reports
`TestStepResultStatus.AMBIGUOUS` when more than one matches (`src/assemble/assemble_test_cases.ts`,
`src/runtime/test_case_runner.ts`). So a plain `^(.*)$` catch-all does not merely sit last — it makes
every native step ambiguous. `coexist: true` therefore builds the catch-all as a negative lookahead
over the patterns you already registered:

```ts
register({ coexist: true });
```

`catchAllPattern(existingPatterns, true)` is a pure function and is unit-tested: it must not match a
native pattern, and must match everything else. Without coexist mode ai-bdd owns the steps.

## What happens per step

1. `Before` opens a session and publishes this file's bindings (`aibdd_register_bindings`).
2. The catch-all text calls `aibdd_resolve_step`.
   - `invoke-local` → the plugin calls your function and reports the outcome with
     `aibdd_report_binding_result`, so timing and evidence are recorded.
   - `run-step` → the daemon runs the act loop, the checks and the judge.
   - `fail` → the plugin throws, so cucumber-js reports `FAILED` with the ai-bdd error code.
3. `After` closes the session; a healed step is reported as `healed`, never as a silent pass.

## Evidence in Cucumber's own report

Evidence is attached **by reference** (relative path + sha256 + media type). cucumber-js's message
formatter shows the attachment names; `ai-bdd/report.json` carries the authoritative list.

## Configuration

The plugin reads `.ai-bdd/daemon.json` (written by `ai-bdd serve --http`, mode 0600). Pass `url` and
`token` to `register()` when the daemon runs elsewhere.
