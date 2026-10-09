# Changelog

## 0.1.0

- `AiBddRuntimePlugin` registered through `reqnroll.json`, replacing `IStepDefinitionMatchService` with a
  decorator that falls back to the ai-bdd daemon.
- `AiBddStepDefinitionBinding` implementing the full `IStepDefinitionBinding` surface.
- `AiBddRuntime` with session lifecycle, local binding invocation, heals and ai-bdd error codes.
- `AiBddClient` on `System.Net.Http` + `System.Text.Json`, plus the `[AiBddStep]` attribute.
- Tests: 15 unit/integration tests against an in-process fake daemon.
