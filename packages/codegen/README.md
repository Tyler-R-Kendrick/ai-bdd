# @ai-bdd/codegen

Emits step definitions from what a run recorded (G13). Two styles, one CLI flag.

```bash
ai-bdd codegen --framework cucumber-js --style delegate   # default
ai-bdd codegen --framework cucumber-js --style inline
ai-bdd codegen --framework playwright
ai-bdd codegen --framework e2e                            # writes the file e2e's runner collects
```

| Style | What the emitted binding does |
| --- | --- |
| `delegate` (default) | `When(...)` calls `aiBdd.act(text)` and `Then(...)` calls `aiBdd.assert(text)`, so the **cached program is the replayed driver code**: `.ai-bdd/cache/act/<key>.json` holds the recorded, effect-verified actions, and the binding stays a one-line, reviewable sentence. |
| `inline` | The recorded Playwright actions are written into the step, so the step no longer needs the daemon (judge-only assertions still delegate). |

```ts
// delegate: the binding is thin; the cache is the generated driver code
// cache: act program 0d59efa4… (driver fake, 1 action(s))
When(/^Open billing settings$/, async function () {
  await aiBdd.act('Open billing settings');
});

// inline: the recorded actions are in the step
When(/^Upgrade the workspace to the Pro plan$/, async function (world: AiBddWorld) {
  await world.page.getByTestId('upgrade').click();
  await world.page.getByTestId('confirmUpgrade').click();
});
```

## Why delegate is the default

A cached ActProgram is *generated, deterministic, replayable driver code*: recorded once, replayed with
effect verification on every later run, healed when the screen changed, and re-recorded only when the
impacted area moved. Emitting the container for it (a one-line binding) keeps the sentence that a
reviewer reads stable while the recorded actions evolve underneath. `inline` is for teams that want the
last hop removed once a flow has stopped changing.

## What is emitted

| File | Contents |
| --- | --- |
| `ai-bdd.steps.ts` | the bindings (delegate or inline), each with the source cache key in a comment |
| `ai-bdd.support.ts` | a per-scenario browser context (`world.page`), the secret proxy, and `aiBdd.act` / `aiBdd.assert` |
| `ai-bdd.evidence.json` | the style, the act and check keys, and the judge-only assertions |
| `ai-bdd.spec.ts` | the Playwright-flavoured suite (`--framework playwright`) |

Rules that keep the output trustworthy:

- **Deterministic**: files are sorted by step text then cache key; nothing depends on wall clock or
  iteration order.
- **Judge-only assertions keep calling the daemon.** An assertion with no deterministic program cannot be
  emitted as a check, so it is emitted as `await aiBdd.assert('<criterion>')` and listed in
  `ai-bdd.evidence.json`. It is never downgraded to a weaker assertion.
- **Secrets are never inlined**: a recorded `{ secret: name }` slot becomes `secrets.<name>` (read from
  `AI_BDD_SECRET_<NAME>` at run time).
- **Selectors are structural**: `getByRole(role, { name, exact: true })` or `getByTestId`.
- Every file carries a `DO NOT EDIT` header with its style.
