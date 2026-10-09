# @ai-bdd/cli

The `ai-bdd` command line (section 9.2 of the specification).

```bash
ai-bdd init [--yes]
ai-bdd run [globs...] [--driver n] [--tag expr] [--grep re] [--frozen] [--no-cache] [--strict-cache] [--repeat-each n] [--workers n] [--reporter r...] [--update-lock]
ai-bdd resolve [globs...] [--json] [--update-lock] [--frozen]
ai-bdd lint [globs...]
ai-bdd lock verify [globs...]
ai-bdd codegen [--framework cucumber-js|playwright] [--out dir]
ai-bdd verify-evidence <runDir>
ai-bdd calibrate --labels labels.jsonl [--json]
ai-bdd doctor [--offline] [--config path]
ai-bdd serve [--stdio|--http] [--port n]
```

Global flag: `--fake` (same as `AI_BDD_FAKE=1`) swaps in the deterministic fake driver and fake
models, which is how the README quickstart and every CI job run. Without it, a JSON config
triple-slash cannot express model objects, so `ai-bdd` asks for a `.ts` config built with
`aiSdkModels()`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | everything passed |
| 1 | at least one scenario failed (including ambiguous, unbound, inconclusive) |
| 2 | usage, config or spec parse error |
| 3 | infrastructure (driver or model unavailable) |
| 4 | frozen-lock violation only |

`ai-bdd run` returns the runtime's exit code directly, so CI can distinguish a failing
assertion from a stale lockfile from a broken driver.

## Programmatic use

The commands are exported as functions taking an `io` object and returning an exit code, so
tests and the daemon can drive them in-process:

```ts
import { runCli } from '@ai-bdd/cli';
const code = await runCli(['--fake', 'run', 'fixtures/specs/billing.spec.md'], io);
```

When a glob names a directory, it expands to that directory's `*.spec.md`, `*.spec`,
`*.feature` and `*.cpt` files, so `ai-bdd run fixtures/specs` does what you expect.
