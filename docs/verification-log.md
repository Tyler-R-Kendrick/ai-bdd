# Verification log

Every VERIFY item in the implementation prompt, with the date it was run, the exact
command, the observed result, and the action taken. Run from `/workspace` on
Node `v24.21.0` / pnpm `12.10.1` unless stated otherwise.

Legend: **verified** = the check ran here and matched the specification; **synthetic** =
the real dependency could not run in this sandbox, so the recorded fixture is hand-authored
and marked `synthetic: true`; **pending** = not yet run by any work package.

| Id | Date | Status | Result / action |
| --- | --- | --- | --- |
| V1 | 2026-10-09 | verified | `e2e/runner` exports exactly `ConfigurationError,isE2EError,list`. No `run` export, so `@ai-bdd/e2e-host` uses the V2 static-generation fallback. |
| V2 | 2026-10-09 | pending | e2e-host not yet implemented; the fallback (`ai-bdd e2e-host generate` writing a static `*.e2e.ts`) is the design of record. |
| V3 | 2026-10-09 | pending | `cua-driver` is not installable in this sandbox; fixtures stay `synthetic: true` and the startup self-check fails with `DRIVER_INCOMPATIBLE` listing missing tools. |
| V4 | 2026-10-09 | pending | Documented action: `cua` driver supports `mcp` mode only until the attach behaviour is confirmed. |
| V5 | 2026-10-09 | pending | Documented action: do not pass `--permission-mode bounded`; enforce `policy.cua.allowApps` inside ai-bdd. |
| V6 | 2026-10-09 | verified | `@modelcontextprotocol/client@2.3.1` (with the `@modelcontextprotocol/client/stdio` transport) connected to `e2e mcp` 0.19.0 over stdio, negotiated protocol `2025-06-18`, and listed the four tools. The v2 client interoperates with e2e, so no per-driver fallback to the v1 monolith is needed. |
| V7 | 2026-10-09 | verified | `@cucumber/gherkin@42.0.1` exports `Parser`, `AstBuilder`, `GherkinClassicTokenMatcher`, `compile`; `@cucumber/messages@34.2.1` exports `IdGenerator`. |
| V8 | 2026-10-09 | pending | Playwright driver work: `ariaSnapshot` format is pinned by a parser golden captured from the fixture app. |
| V9 | 2026-10-09 | pending | cucumber-js plugin not yet implemented. |
| V10 | 2026-10-09 | verified (API) | Cucumber-JVM 8.0.4 (latest release on Maven Central) still exposes `io.cucumber.core.backend.Backend`, `BackendProviderService`, `Glue` and `runner.AmbiguousStepDefinitionsException`. `Backend.loadGlue(Glue, GlueDiscoveryRequest)` is the non-deprecated entry point since 8.0.0. The plugin targets 8.x; a 7.x profile is unnecessary. Glue visibility across backends remains to be proven by the plugin test. |
| V11 | 2026-10-09 | pending | Behave plugin not yet implemented. |
| V12 | 2026-10-09 | pending | pytest-bdd plugin not yet implemented. |
| V13 | 2026-10-09 | pending | Reqnroll plugin not yet implemented. |
| V14 | 2026-10-09 | pending | AI SDK adapter work; `ai@7.0.137` is the current release. |
| V15 | 2026-10-09 | verified | `process.features.typescript === 'strip'` on Node 24.21.0, so `ai-bdd.config.ts` loads through dynamic `import()` with type stripping. `CONFIG_TS_UNSUPPORTED` remains for older runtimes. |
| V16 | 2026-10-09 | pending | e2e-host work; the public screenshot fixture question is unresolved, so the ternary `agent.assert` path is the documented fallback. |
| V17 | 2026-10-09 | verified | Maven Central metadata for `io.cucumber:cucumber-core` reports release `8.0.4`; 8.x is the target major. |
| V18 | 2026-10-09 | pending | Plugin attachment APIs are verified per plugin and recorded here when each plugin lands. |

## Evidence

### V1 — public e2e surface (F-E1)

```bash
mkdir -p /tmp/v1 && cd /tmp/v1 && npm install e2e@0.19.0
node -e "import('e2e/runner').then(m=>console.log(Object.keys(m).sort().join(',')))"
# ConfigurationError,isE2EError,list
node -e "import('e2e/agent').then(m=>console.log(Object.keys(m).sort().join(',')))"
# AgentError,createToolLoopExecutor,defineTool,getToolContext,isAgentError
node -e "import('e2e/engine').then(m=>console.log(Object.keys(m).sort().join(',')))"
# includes defineEngine and ENGINE_SPI_VERSION
```

Action: `@ai-bdd/e2e-host` MUST NOT import `e2e/run/runner` or `e2e/dist/**`; the static
generation fallback (V2) is the design of record.

### V6 / F-E3 — e2e mcp catalog

```bash
node scripts/mcp-tools-snapshot.mjs node /tmp/v1/node_modules/e2e/dist/cli/bin.js mcp
# serverInfo: { name: "e2e", version: "0.19.0" }, protocolVersion: 2025-06-18
# tools: open_session,tools,call,close_session
# open_session input properties: target,config,headed
node /tmp/v1/node_modules/e2e/dist/cli/bin.js mcp --help
# --config <path> --target <name> --max-sessions <n> (1..16, default 4), --headed
```

Action: the four-tool catalog and the `e2e mcp` flag names in section 11.2 are correct as
written; the snapshot is committed as a driver fixture
(`docs/evidence/e2e-mcp-0.19.0.tools.json`).

```bash
cd /tmp/v1 && npm install @modelcontextprotocol/client@2.3.1
node v6.mjs
# protocol: { name: 'e2e', title: 'e2e', version: '0.19.0' }
# tools: open_session,tools,call,close_session
```

The v2 SDK exposes `Client` at the package root and `StdioClientTransport` at the `./stdio`
subpath; the root module does not export a stdio transport.

### V17 / V10 — Cucumber-JVM release and SPI

```bash
curl -s https://repo1.maven.org/maven2/io/cucumber/cucumber-core/maven-metadata.xml | grep release
# <release>8.0.4</release>
unzip -l cucumber-core-8.0.4.jar | grep -E 'backend/(Backend|BackendProviderService|Glue)\.class'
# io/cucumber/core/backend/Backend.class, BackendProviderService.class, Glue.class, runner/AmbiguousStepDefinitionsException.class
```

Action: the JVM plugin targets `io.cucumber:cucumber-java:8.0.4` and implements
`Backend.loadGlue(Glue, GlueDiscoveryRequest)`.

### V15 — native TypeScript config loading

```bash
node -e "console.log(process.features.typescript)"   # strip
```

Action: `ai-bdd.config.ts` is loaded with dynamic `import()`; only erasable TypeScript
syntax is allowed in config files, and `CONFIG_TS_UNSUPPORTED` is raised on runtimes
without type stripping.

### V7 — Gherkin and Messages API names (F-G1)

```bash
cd /tmp/v1 && npm install @cucumber/gherkin@42.0.1 @cucumber/messages@34.2.1
node -e "import('@cucumber/gherkin').then(g=>console.log(Object.keys(g).sort().join(',')))"
# AstBuilder,Errors,GherkinClassicTokenMatcher,GherkinInMarkdownTokenMatcher,Parser,TokenScanner,compile,dialects,generateMessages,makeSourceEnvelope
node -e "import('@cucumber/messages').then(m=>console.log(JSON.stringify(m.PickleStepType)))"
# {"UNKNOWN":"Unknown","CONTEXT":"Context","ACTION":"Action","OUTCOME":"Outcome"}
```

Action: section 7.2's kind mapping (`Context`->setup, `Action`->action, `Outcome`->assertion)
and the `IdGenerator` usage are correct as written; no adaptation needed.
