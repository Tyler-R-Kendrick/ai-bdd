# @ai-bdd/codegen

Emits deterministic step-definition source from what a run recorded (G13).

```bash
ai-bdd codegen --framework cucumber-js --out .ai-bdd/generated
```

Inputs are the committed caches (`.ai-bdd/cache/act/<key>.json`, `.ai-bdd/cache/check/<key>.json`)
and `ai-bdd.lock.json`. Output is:

| File | Contents |
| --- | --- |
| `ai-bdd.steps.ts` | one `When` per ActProgram (Playwright locator chains built from the recorded selectors, parameter slots as function arguments) and one `Then` per CheckProgram (`expect(...)` assertions). |
| `ai-bdd.support.ts` | the base URL, the secret proxy, and the `aiBdd.assert` helper judge-only assertions use. |
| `ai-bdd.evidence.json` | the source cache keys, so a reviewer can trace generated code back to the run. |
| `ai-bdd.spec.ts` | the Playwright-flavoured variant (`--framework playwright`). |

Rules that keep the output trustworthy:

- **Deterministic**: files are sorted by step text then cache key, and nothing depends on wall
  clock or iteration order.
- **Judge-only assertions keep calling the daemon.** An assertion with no deterministic program
  cannot be emitted as a check, so codegen emits `await aiBdd.assert('<criterion>')` and lists
  it in `ai-bdd.evidence.json`. It is never turned into a weaker assertion.
- **Selectors are structural**: `getByRole(role, { name, exact: true })` or `getByTestId`, with
  `nth()` only where the recording needed disambiguation. No CSS paths.
- **Secrets are never inlined**: a recorded `{ secret: name }` slot becomes `secrets.<name>`, read
  from `AI_BDD_SECRET_<NAME>` at run time.
- Every file carries a `DO NOT EDIT` header.
