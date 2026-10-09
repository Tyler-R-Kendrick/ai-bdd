# ai-bdd-behave

The Behave plugin. One `install()` call, then every unbound step goes to the daemon.

## Minimum glue (documented, verified)

```python
# features/steps/zz_ai_bdd.py  — the module name sorts last, so user steps win
from ai_bdd_behave import install

install()
```

```python
# features/environment.py — sessions per scenario
from ai_bdd_behave import after_scenario, before_scenario
```

Behave loads step modules alphabetically and searches the typed lists (`given`/`when`/`then`)
before the generic one, in registration order, so a user step always wins over the catch-all.
`chain_hooks(environment_module)` composes the plugin's hooks with hooks you already have instead
of clobbering them.

## What `install()` does

1. `register_step_matcher_class("ai_bdd", AiBddMatcher)` and sets it as the current matcher.
   The matcher must subclass `behave.matchers.Matcher`, implements `compile()` and returns
   `Argument` instances from `check_match()`, which is what behave 1.3 requires.
2. Registers one generic step (`@step("{text}")`) under that matcher and restores the previous
   matcher, so your own definitions keep their own parsing.

## Per step

1. `resolve_step` — the answer is `invoke-local`, `run-step` or `fail`.
2. `invoke-local`: the plugin calls your function (see `_invoke`, which respects `context` and
   keyword parameters) and reports through `report_binding_result`, so evidence and timing are
   recorded. A binding id that belongs to another provider is served by the plugin's own
   definition for that sentence, if it has one.
3. `run-step`: the daemon runs the act loop, the checks and the judge.
4. `healed` is recorded on `context.ai_bdd_healed` and passes here; the ai-bdd reporters still show
   the step as healed (R-K22). `fail` raises `AssertionError` with the ai-bdd code in the message.

## Conformance

The suite runs behave against the scripted daemon (`ai-bdd serve --fake-script`) over the 20 kit
feature files and compares the per-step statuses with `packages/conformance/plugin/expected/`.
Statuses the framework spells differently are accepted through the kit's `status-aliases.json`,
and the ai-bdd error code must appear in the failure message.

```bash
cd plugins/python && . .venv/bin/activate
python -m pytest behave/tests
```
