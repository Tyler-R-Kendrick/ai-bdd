# AiBdd.Reqnroll

The Reqnroll runtime plugin. Listing it in `reqnroll.json` is the whole installation.

## Minimum glue (documented, verified)

```json
{
  "runtime": {
    "plugins": [ { "type": "AiBdd.Reqnroll.AiBddRuntimePlugin, AiBdd.Reqnroll" } ]
  }
}
```

```csharp
public class BillingSteps
{
    [AiBddStep("Seed a workspace {string} on the {string} plan",
               "Seeds a workspace with a name and a plan tier", "setup")]
    public bool SeedWorkspace(string name, string plan) { ... }
}
```

Your existing `[Given]`/`[When]`/`[Then]` bindings keep working untouched: the plugin is a decorator,
not a replacement for native bindings.

## How it hooks in (verified against Reqnroll 2.4 by reflection)

| Step | Detail |
| --- | --- |
| Discovery | `[assembly: RuntimePlugin(typeof(AiBddRuntimePlugin))]` plus the `reqnroll.json` entry |
| Container | `RuntimePluginEvents.RegisterGlobalDependencies` hands over the `ObjectContainer`. `CustomizeGlobalDependencies` only carries the configuration, so the container is not reachable from there — that is the correction recorded as V13 |
| Replacement | the existing `IStepDefinitionMatchService` is resolved **before** it is replaced, then `RegisterInstanceAs<IStepDefinitionMatchService>` installs `AiBddStepDefinitionMatchService` around it (BoDi replaces a registration in place) |
| Fallback | `GetBestMatch` returns the native match when there is one; otherwise it returns the catch-all binding `^(.*)$`, whose `Execute` runs the step on the daemon |
| Coexistence | the plugin never shadows a native binding, so `AmbiguousSteps` from ai-bdd's side cannot happen; an ai-bdd ambiguity surfaces as a failure whose message carries `STEP_AMBIGUOUS` |
| Heals | a healed step is a pass here and is listed through `AiBddRuntime.Healed`; the ai-bdd reporters still show it as healed (R-K22) |

`AiBddStepDefinitionBinding` implements `IStepDefinitionBinding` in full (`StepDefinitionType`,
`SourceExpression`, `ExpressionType`, `Regex`, `Method` via `IBindingMethod`/`IBindingType`, `IsScoped`,
`BindingScope`), because Reqnroll resolves a binding's invocation through those members.

## Options

The daemon connection comes from `AI_BDD_DAEMON_URL` / `AI_BDD_DAEMON_TOKEN`,
the `ai-bdd.daemonUrl` / `ai-bdd.daemonToken` AppDomain values, or `.ai-bdd/daemon.json` (mode 0600).

## Tests

```bash
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 dotnet test AiBdd.Reqnroll.Tests/AiBdd.Reqnroll.Tests.csproj
```

15 tests: the client against an in-process HTTP fake daemon (bearer auth, `daemon.json`, typed error
payloads), the local binding table (expression compilation, positional capture, typed conversion,
descriptor publishing), the runtime loop (agent step, heal, failure code, ambiguity, local binding
execution with reporting) and the match-service decorator (fallback, no shadowing, full binding
surface).
