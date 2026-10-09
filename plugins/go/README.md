# ai-bdd-go

The Go integration: `aibdd` (client and local binding table) and `godogbdd` (godog plugin).

## Minimum glue (documented, verified)

```go
func InitializeScenario(sc *godog.ScenarioContext) {
    // your own steps first, so they win in non-strict mode
    sc.Step(`^I have a wallet$`, func() error { return nil })

    // then the ai-bdd catch-all, session hooks and the local bindings
    godogbdd.Register(sc)
}
```

```go
// strict mode, or when you want semantic matching to target the step:
godogbdd.BindStep(sc, `Seed a workspace {string} on the {string} plan`, godogbdd.StepOptions{
    Description: "Seeds a workspace with a name and a plan tier",
    Kind:        "setup",
}, func(ctx context.Context, params map[string]string) error {
    return seed(params["string"])
})
```

## Why `Register` goes last

godog matches steps in registration order and, in **non-strict** mode, the first match wins, so a
catch-all registered last never shadows your own steps. In **Strict** mode godog turns multiple
matches into `ErrAmbiguous`, so every binding must go through `BindStep`: the pattern is then
published to the daemon and the function stays in your process.

## What happens per step

| Daemon answer | Plugin behaviour |
| --- | --- |
| `invoke-local` | look up the binding id, or the pattern that matches the sentence, call it with the captured parameters, then `report_binding_result` |
| `run-step` | the daemon runs the act loop, the checks and the judge |
| `fail` | return an error whose message carries the ai-bdd code (`SETUP_UNBOUND`, `STEP_AMBIGUOUS`, ...) |
| `healed` | counted as a pass here, listed through `godogbdd.Healed(ctx)`; the ai-bdd reporters still show `healed` (R-K22) |

Scenario state (the client, the local table and the session id) travels in the `context.Context`
that the `Before`/`After` hooks install, so scenarios never share it.

## Conformance

```bash
PATH=/workspace/.toolchains/go/bin:$PATH go test ./...
```

`godogbdd/conformance_test.go` runs all 20 kit features through godog against
`ai-bdd serve --fake-script` and compares the reported step statuses with the kit's expectations,
accepting the framework-specific spellings listed in `status-aliases.json`.
