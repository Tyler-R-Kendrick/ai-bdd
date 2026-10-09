# @ai-bdd/conformance

Three kits that every ai-bdd integration must pass.

## Driver conformance

```ts
import { runDriverConformance } from '@ai-bdd/conformance';
runDriverConformance(fake(), { navigate: { verb: 'navigate', value: '/settings/billing' }, knownSelector: { role: 'button', name: 'Upgrade to Pro' } });
```

Checks observe/perform/close semantics, ref invalidation after a new observation, honest
capabilities, refusal of undeclared verbs, taint after a secret fill, and a clean close.

## Plugin conformance

The kit lives in `plugin/`: 20 feature files, a scripted fake daemon (`script.json`, used by
`ai-bdd serve --fake`) and the expected per-step results in `plugin/expected/`. A plugin runs
`runPluginConformance({ run })`, where `run` executes one feature file through its own
framework integration and returns the mapped step results.

## Daemon protocol conformance

`runProtocolConformance({ baseUrl, token })` proves that the HTTP JSON mirror requires the
bearer token, rejects unknown fields with `INVALID_ARGUMENT`, echoes `traceparent`, and — when
an MCP `tools/list` payload is supplied — exposes byte-identical input schemas to the
checked-in files in `@ai-bdd/contracts/schemas/tools/`.
