# @ai-bdd/e2e-host

Runs ai-bdd specs inside [TesterArmy e2e](https://github.com/tester-army/e2e)'s own runner, using
only e2e's public API (R-K1b, N5).

```ts
// tests/ai-bdd.e2e.ts — collected by e2e's runner
import { registerSpecs } from '@ai-bdd/e2e-host/register';

registerSpecs({ globs: ['specs/**/*.spec.md', 'features/**/*.feature'] });
```

or commit the generated file instead:

```bash
ai-bdd e2e-host generate --out tests/ai-bdd.generated.e2e.ts
```

## Why there are two ways

e2e registers tests during **module evaluation**, and `e2e/runner` exports only `list`,
`ConfigurationError` and `isE2EError` — `run()` is not public (verified, VERIFY V1). So a host cannot
re-discover specs and then drive the runner: it must either register synchronously while the module
is evaluated, or be generated ahead of time. Both are supported, and both produce the same stable
titles (`<spec name> › <scenario name>[row]`) so e2e's replay cache keeps working across runs (F-E5).

## What it does per scenario

| Step kind | Behaviour |
| --- | --- |
| setup / bound | handled locally by the ai-bdd registry (same bindings the native runner uses) |
| action, unbound | `agent.act(text, { params })` — e2e's own agent, so you get its record/replay cache |
| assertion, unbound | `agent.assert(text, { vision: true })` and the report marks the layer `judge: 'e2e-ternary'`, because e2e@0.19 exposes no public screenshot fixture for ai-bdd's own scored judge (VERIFY V16) |

## Peer dependency

`e2e >=0.19 <0.21`, optional: the package imports it lazily so the rest of ai-bdd works without it.
