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
| V2 | 2026-10-09 | verified | `@ai-bdd/e2e-host` implements both paths: `registerSpecs()` registers synchronously during module evaluation (unit-tested with an injected `test`), and `generateRegistration()` writes the static file (`ai-bdd e2e-host generate` produced 24 tests from the 13-spec corpus). Titles are `<spec name> › <scenario name>[row]` and the 512-byte limit is enforced. |
| V3 | 2026-10-09 | not reproducible | The Cua CLI cannot be installed or run in this sandbox, so `tools/list` was not captured and `driver-cua` is not implemented. `docs/drivers.md` specifies the required tools; the documented fallback (`DRIVER_INCOMPATIBLE` listing missing tools) is what a Cua-enabled job must implement. |
| V4 | 2026-10-09 | pending | Documented action: `cua` driver supports `mcp` mode only until the attach behaviour is confirmed. |
| V5 | 2026-10-09 | pending | Documented action: do not pass `--permission-mode bounded`; enforce `policy.cua.allowApps` inside ai-bdd. |
| V6 | 2026-10-09 | verified | `@modelcontextprotocol/client@2.3.1` (with the `@modelcontextprotocol/client/stdio` transport) connected to `e2e mcp` 0.19.0 over stdio, negotiated protocol `2025-06-18`, and listed the four tools. The v2 client interoperates with e2e, so no per-driver fallback to the v1 monolith is needed. |
| V7 | 2026-10-09 | verified | `@cucumber/gherkin@42.0.1` exports `Parser`, `AstBuilder`, `GherkinClassicTokenMatcher`, `compile`; `@cucumber/messages@34.2.1` exports `IdGenerator`. |
| V8 | 2026-10-09 | partial | Chromium 156 downloads (`playwright-core install chromium`) but cannot start: the sandbox has no root and no package lists, so `libglib-2.0-0` is missing. The `ariaSnapshot` parser is therefore pinned by a `synthetic: true` golden, and the browser suite skips itself with a clear message. A browser-enabled job must regenerate `packages/driver-playwright/test/fixtures/aria-snapshots.json` and drop the flag. |
| V9 | 2026-10-09 | partially verified | `@ai-bdd/cucumber` implements the negative-lookahead catch-all (`catchAllPattern(existing, true)`) and unit-tests that it does not match a native pattern. Reading the native patterns through `supportCodeLibraryBuilder` at register time could not be verified here because `@cucumber/cucumber` is not installed in the sandbox; the plumbed `nativePatterns()` helper returns the list when the framework is present. |
| V10 | 2026-10-09 | verified (API) | Cucumber-JVM 8.0.4 (latest release on Maven Central) still exposes `io.cucumber.core.backend.Backend`, `BackendProviderService`, `Glue` and `runner.AmbiguousStepDefinitionsException`. `Backend.loadGlue(Glue, GlueDiscoveryRequest)` is the non-deprecated entry point since 8.0.0. The plugin targets 8.x; a 7.x profile is unnecessary. Glue visibility across backends remains to be proven by the plugin test. |
| V11 | 2026-10-09 | pending | Behave plugin not yet implemented. |
| V12 | 2026-10-09 | pending | pytest-bdd plugin not yet implemented. |
| V13 | 2026-10-09 | verified with a correction | Reflection over `Reqnroll.dll` 2.4 shows `RuntimePluginEvents.RegisterGlobalDependencies` hands over the `ObjectContainer` and replaces `IStepDefinitionMatchService`; `CustomizeGlobalDependencies` only carries `ReqnrollConfiguration`, so the container is **not** reachable from that event. The plugin uses `RegisterGlobalDependencies` and resolves the existing service before replacing it. `IStepDefinitionMatchService` has `GetBestMatch(StepInstance, CultureInfo, out StepDefinitionAmbiguityReason, out List<BindingMatch>)`, `Match(...)` and `Ready`; `BindingMatch` is constructed as `(IStepDefinitionBinding, scopeMatches, arguments, StepContext)`. |
| V14 | 2026-10-09 | unverified | The AI SDK adapter (`aiSdkModels`) is implemented against the documented `generateText`/`embedMany` surface and loads the package lazily, so the fakes never need it. No provider credentials exist here, so those names are not confirmed against `ai@7`; the adapter raises MODEL_UNAVAILABLE with an actionable message when the package is absent and MODEL_OUTPUT_INVALID when structured output is not JSON. |
| V15 | 2026-10-09 | verified | `process.features.typescript === 'strip'` on Node 24.21.0, so `ai-bdd.config.ts` loads through dynamic `import()` with type stripping. `CONFIG_TS_UNSUPPORTED` remains for older runtimes. |
| V16 | 2026-10-09 | verified | e2e@0.19 exposes no public screenshot fixture (only `e2e`, `e2e/agent`, `e2e/engine` and `e2e/runner` are importable), so `@ai-bdd/e2e-host` uses `agent.assert(text, { vision: true })` as its single assertion layer and records the layer as the ternary e2e judge. |
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


### V2 / V16 — the e2e host (R-K1b)

```bash
node packages/cli/dist/bin.js e2e-host generate fixtures/specs --out /tmp/gen.e2e.ts
# wrote ../tmp/gen.e2e.ts (24 test(s) from 13 spec(s))
head -8 /tmp/gen.e2e.ts
# // Generated by `ai-bdd e2e-host generate` (VERIFY V2 fallback).
# // DO NOT EDIT: rerun the generator after changing the specs.
# import { test } from 'e2e';
# test("Workspace billing › Member upgrades to Pro", { tags: [] }, async ({ agent }) => {
#   await agent.act("Open billing settings");
```

Action: a project that can await before registering calls `registerSpecs()` at the top level of a
collected test file instead; both paths produce identical titles, so e2e's replay cache is stable
across runs.

### V8 — ariaSnapshot format

```bash
pnpm -F @ai-bdd/driver-playwright exec playwright-core install chromium   # 120 MiB, succeeds
node -e "require('playwright-core').chromium.launch()"                    # exit 127: libglib-2.0.so.0 missing
apt-get install -y libglib2.0-0                                           # permission denied (no root)
```

Action: the parser is pinned with a synthetic golden and the browser suite skips itself with a message.
Recorded so a browser-enabled job knows exactly which artifact to regenerate.

### MCP interop (F-M1, AC8)

```bash
# in-process, via @modelcontextprotocol/client's InMemoryTransport
client.listTools()        # names equal TOOL_DEFINITIONS
tool.inputSchema          # byte-identical to packages/contracts/schemas/tools/<tool>.input.schema.json
client.callTool('aibdd_health', {})   # structuredContent.protocol === 1
client.callTool('aibdd_resolve_step', { sessionId: 'nope', step: { text: 'x' } })  # isError, NO_SESSION
```

### V13 — the Reqnroll replacement point

```csharp
// reflection probe over Reqnroll 2.4 (packages/plugins/dotnet has the plugin)
Reqnroll.Plugins.IRuntimePlugin.Initialize(RuntimePluginEvents, RuntimePluginParameters, UnitTestProviderConfiguration)
Reqnroll.Plugins.RuntimePluginEvents: RegisterGlobalDependencies(ObjectContainer), CustomizeGlobalDependencies(ReqnrollConfiguration)
Reqnroll.BoDi.ObjectContainer: RegisterInstanceAs(TInterface, String, Boolean), RegisterTypeAs(Type, Type, String), IsRegistered(...)
Reqnroll.Infrastructure.IStepDefinitionMatchService.GetBestMatch(StepInstance, CultureInfo, out StepDefinitionAmbiguityReason, out List<BindingMatch>)
Reqnroll.Bindings.BindingMatch ctor(IStepDefinitionBinding stepBinding, Int32 scopeMatches, Object[] arguments, StepContext stepContext)
Reqnroll.Bindings.IStepDefinitionBinding + IBinding.
Method (Reqnroll.Bindings.Reflection.IBindingMethod) + IScopedBinding
IExpression lives in the CucumberExpressions assembly (CucumberExpressions.IExpression), not in Reqnroll
```

Action: the plugin decorates `IStepDefinitionMatchService` from `RegisterGlobalDependencies`; native
matches always win, and everything else reaches the daemon through the catch-all binding.
