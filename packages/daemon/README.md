# @ai-bdd/daemon

The orchestrator daemon: one tool table, two surfaces.

```bash
ai-bdd serve --http          # Streamable HTTP MCP + the JSON mirror at /v1/*
ai-bdd serve --stdio         # MCP over stdio, for agents and IDEs
```

## The two surfaces

| Surface | For | Shape |
| --- | --- | --- |
| MCP (`aibdd_<tool>`) | agents and IDEs | tools generated from `TOOL_TABLE`, input and output schemas attached, `_meta.traceparent` accepted |
| HTTP JSON mirror (`POST /v1/<tool>`) | language plugins | same body, same result, `Authorization: Bearer <token>` required, `traceparent` header accepted and echoed |

Both go through `callTool`, which validates the input against the checked-in JSON Schema, calls the
session manager and validates the result. A test asserts the MCP `tools/list` input schema is
byte-identical to `packages/contracts/schemas/tools/<tool>.input.schema.json`, so the surfaces
cannot drift.

## Sessions

`aibdd_open_session` creates one driver session per scenario. `aibdd_resolve_step` decides between
`invoke-local` (the plugin calls its own function and reports back) and `run-step` (the daemon runs
the step: act loop, checks, judge). Sessions write `.ai-bdd/sessions/<sessionId>.json`, and the
daemon reaps entries whose pid is gone at startup.

`aibdd_run` runs specs natively inside the daemon, which is how an agent drives a whole corpus.

## Auth and discovery

The token is generated per daemon and written to `.ai-bdd/daemon.json` with mode `0600`
(atomic temp + rename). Plugins read it, then send it as a bearer token. MCP over stdio needs no
token because it is not reachable over the network.

## Evidence

`aibdd_get_evidence` resolves an evidence id through the manifest and returns its absolute path.
The path is confined to the run directory, so a client cannot ask for arbitrary files.
