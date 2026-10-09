# ai-bdd-cucumber (Cucumber-JVM)

The Cucumber-JVM backend. Add the artifact to the classpath and the `ServiceLoader` registers it; there is
no runner class and no glue annotation to add.

## Minimum glue (documented, verified)

```xml
<dependency>
  <groupId>dev.ai-bdd</groupId>
  <artifactId>ai-bdd-cucumber</artifactId>
  <version>0.1.0</version>
</dependency>
```

```java
public class BillingSteps {
    @AiBddStep(pattern = "Seed a workspace {string} on the {string} plan",
               description = "Seeds a workspace with a name and a plan tier",
               kind = "setup")
    public boolean seedWorkspace(String name, String plan) { ... }
}
```

## How it plugs into Cucumber-JVM 8

`AiBddBackendProvider` implements `io.cucumber.core.backend.BackendProviderService` and is listed in
`META-INF/services`, so `ServiceLoader` finds it. The backend implements the 8.x entry point
`loadGlue(Glue, GlueDiscoveryRequest)` (the `List<URI>` overload is kept for 7.x).

Two kinds of definitions are registered:

1. **One step definition per `@AiBddStep` method**, with `parameterInfos()` derived from the method
   signature. This is not optional: Cucumber validates arity per definition, so a step carrying a
   `DataTable` or a `DocString` can only be handled by a definition that declares it. The method runs
   in this process and the outcome is reported to the daemon (`report_binding_result`), so evidence and
   timing still land in the run.
2. **One catch-all** (`^(.*)$`) for everything else, which goes to the daemon: `resolve_step`, then
   either `run_step` or `invoke-local`.

The catch-all is built as a **negative lookahead over the annotated patterns** (plus whatever
`ai-bdd.properties` lists in `nativePatterns`). Cucumber-JVM raises
`AmbiguousStepDefinitionsException` when two definitions match, so a plain catch-all would shadow the
project's own steps — the lookahead is the JVM equivalent of cucumber-js's coexist mode. Verified by
`AiBddUnitTest.catchAllPatternExcludesNativePatterns`.

## Options

`ai-bdd.properties` on the classpath or in the project root:

| Key | Meaning |
| --- | --- |
| `nativePatterns` | comma-separated patterns the project's *java backend* defines; excluded from the catch-all |
| `projectRoot` | where the daemon lookup starts (defaults to the working directory) |

The daemon connection comes from `AI_BDD_DAEMON_URL` / `AI_BDD_DAEMON_TOKEN`, the
`ai-bdd.daemonUrl` / `ai-bdd.daemonToken` system properties, or `.ai-bdd/daemon.json` (mode 0600).

## Conformance

```bash
PATH=/workspace/.toolchains/jdk/bin:$PATH mvn test
```

`PluginConformanceTest` runs all 20 kit features through Cucumber-JVM against
`ai-bdd serve --fake-script` and compares the reported step statuses with the kit's expectations
(accepting the framework spellings in `status-aliases.json`). `AiBddUnitTest` covers the JSON reader,
the client, the binding table and the catch-all pattern.
