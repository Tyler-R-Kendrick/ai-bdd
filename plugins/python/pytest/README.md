# ai-bdd-pytest

The pytest-bdd plugin. Installed as a `pytest11` entry point; the catch-all is registered at import.

## Minimum glue (documented, verified)

```python
# tests/test_billing.py
from pytest_bdd import scenarios

scenarios('../features')
```

Your own steps are ordinary pytest-bdd steps; they stay **more specific** than the catch-all and win
(pytest-bdd injects the most specific matching fixturedef).

```python
from pytest_bdd import given, parsers
from ai_bdd_pytest import describe

@given(parsers.parse('Seed a workspace "{name}" on the "{plan}" plan'))
@describe(description="Seeds a workspace with a name and a plan tier", kind="setup")
def seed_workspace(name, plan):
    ...
```

pytest-bdd 9 treats a plain string as an **exact** match, so parameterised steps declare
`parsers.parse(...)` or `parsers.cfparse(...)`. The plugin's own `AiBddParser` matches everything and
passes the raw text as `text`.

## How the plugin hooks in

| Piece | Purpose |
| --- | --- |
| `AiBddParser` | the catch-all `StepParser` |
| module-level `given/when/then/step(parser)` | pytest-bdd injects the step fixture into the **caller's module globals**, so the registration must happen at module scope — registering from inside a function would put the fixture in that function's locals, where pytest never looks |
| `ai_bdd_session` fixture | one daemon session per scenario, closed in `finally` with the scenario's status |
| `pytest_runtest_makereport` | records `rep_call` so the session can be closed as failed |
| `--ai-bdd-no-daemon` | runs the scenario without opening a session (for pure unit-style runs) |

The plugin reads the project's step definitions through `step_function_context_registry` plus the
fixture manager, which is the only object that sees conftest, plugin and test-module fixtures at
once. That is how `register_bindings` publishes your steps and how an `invoke-local` answer finds the
right function.

## Conformance

```bash
cd plugins/python && . .venv/bin/activate
python -m pytest pytest/tests
```

20 kit features against the scripted daemon, plus unit tests for the parser, the client and the
user-step-wins guarantee.
