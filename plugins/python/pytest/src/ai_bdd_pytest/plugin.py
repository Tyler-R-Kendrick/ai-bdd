"""The pytest plugin: session fixtures, the catch-all step and the reporting hooks.

Registered through the ``pytest11`` entry point, so ``pip install ai-bdd-pytest`` is
all a project needs. A test module still needs one ``scenarios('features/')`` line;
that minimum glue is documented in the README (section 12 never claims zero glue).
"""

from __future__ import annotations

import os
from typing import Any, Dict, Generator, Optional

import pytest

from .client import DaemonClient, DaemonError
from .parser import AiBddParser, CATCH_ALL_PARSER_NAME, HAVE_PYTEST_BDD, describe

PLUGIN = {"name": "ai-bdd-pytest", "version": "0.1.0", "language": "python"}

client = DaemonClient()
_INSTALLED = False


def pytest_addoption(parser: Any) -> None:
    group = parser.getgroup("ai-bdd")
    group.addoption(
        "--ai-bdd-no-daemon",
        action="store_true",
        default=False,
        help="do not open an ai-bdd session for each scenario",
    )


def _step_contexts(module: Any) -> list[tuple[str, Any, Any]]:
    """Enumerates the step definitions a module owns.

    pytest-bdd registers a step by injecting a fixture named
    ``pytestbdd_stepdef_<type>_<parser name>`` into the caller's module globals and
    recording its ``StepFunctionContext`` in ``step_function_context_registry``,
    keyed by that fixture function. Reading the registry is the only public way a
    plugin can see the project's own steps (the fixtures themselves raise when
    called directly).
    """
    contexts: list[tuple[str, Any, Any]] = []
    if module is None:
        return contexts
    try:
        from pytest_bdd.steps import step_function_context_registry  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover - pytest-bdd is optional
        return contexts

    for attribute, value in list(vars(module).items()):
        if not attribute.startswith("pytestbdd_stepdef_"):
            continue
        context = step_function_context_registry.get(value)
        if context is None:
            continue
        contexts.append((attribute, context, getattr(context, "step_func", None)))
    return contexts


def _all_step_contexts(request: Any) -> list[tuple[str, Any, Any]]:
    """Every step definition pytest has collected, from any module or plugin.

    The fixture manager is the only object that sees conftest, plugin and test
    module fixtures at once, which is what `register_bindings` and the
    `invoke-local` lookup need.
    """
    contexts: list[tuple[str, Any, Any]] = []
    fixturemanager = getattr(getattr(request, "session", None), "_fixturemanager", None)
    arg2fixturedefs = getattr(fixturemanager, "_arg2fixturedefs", {}) or {}
    for name, fixturedefs in arg2fixturedefs.items():
        if not name.startswith("pytestbdd_stepdef_"):
            continue
        for fixturedef in fixturedefs:
            context = _context_for(getattr(fixturedef, "func", None))
            if context is None:
                continue
            contexts.append((name, context, getattr(context, "step_func", None)))
    return contexts


def _context_for(function: Any) -> Any:
    if function is None:
        return None
    try:
        from pytest_bdd.steps import step_function_context_registry  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover
        return None
    return step_function_context_registry.get(function)


def _step_descriptors(contexts: list[tuple[str, Any, Any]]) -> list[dict[str, Any]]:
    """Descriptors for the collected step definitions, minus the catch-all."""
    descriptors: list[dict[str, Any]] = []
    seen: set[str] = set()
    for attribute, context, function in contexts:
        parser = getattr(context, "parser", None)
        name = getattr(parser, "name", None) or attribute
        if name == CATCH_ALL_PARSER_NAME or name in seen:
            continue
        seen.add(name)
        metadata = getattr(function, "ai_bdd", {}) or {}
        descriptors.append(
            _clean(
                {
                "id": f"python:pytest-bdd#{attribute}",
                "provider": "python:pytest-bdd",
                "pattern": name,
                "patternKind": "cucumber-expression",
                "kind": metadata.get("kind") or _kind_for(getattr(context, "type", None)),
                "description": metadata.get("description"),
                "examples": metadata.get("examples") or [],
                "counterExamples": metadata.get("counterExamples") or [],
                "params": metadata.get("params") or [],
                }
            )
        )
    return descriptors


def _clean(descriptor: Dict[str, Any]) -> Dict[str, Any]:
    """Drops empty optional fields: the daemon schema rejects null descriptions."""
    return {
        key: value
        for key, value in descriptor.items()
        if not (value is None or (key in ("examples", "counterExamples", "params") and value == []))
    }


@pytest.fixture(scope="function")
def ai_bdd_session(request: Any) -> Generator[Dict[str, Any], None, None]:
    """Opens one daemon session per scenario, closed in ``finally``."""
    if request.config.getoption("--ai-bdd-no-daemon", False):
        yield {"sessionId": None, "client": client}
        return

    scenario = request.node
    name = getattr(scenario, "name", "scenario")
    filename = str(getattr(scenario, "fspath", "feature"))
    tags = [marker.name for marker in getattr(scenario, "iter_markers", lambda: [])() if marker.name in {"billing"}]
    opened = client.call(
        "open_session",
        {
            "scenarioId": f"{filename}#{name}",
            "scenarioName": name,
            "tags": tags,
            "plugin": PLUGIN,
        },
    )
    contexts = _all_step_contexts(request)
    session = {
        "sessionId": opened["sessionId"],
        "client": client,
        "step_contexts": contexts,
    }
    descriptors = _step_descriptors(contexts)
    if descriptors:
        client.call("register_bindings", {"sessionId": session["sessionId"], "provider": "python:pytest-bdd", "bindings": descriptors})

    try:
        yield session
    finally:
        status = "failed" if getattr(request.node, "rep_call", None) and request.node.rep_call.failed else "passed"
        try:
            client.call("close_session", {"sessionId": session["sessionId"], "status": status})
        except DaemonError:  # pragma: no cover - the daemon may already be gone
            pass


def _kind_for(step_type: Optional[str]) -> str:
    return {"given": "setup", "when": "action", "then": "assertion"}.get(step_type or "", "action")


def catch_all(session: Dict[str, Any], text: str) -> None:
    """Resolves and runs one step through the daemon."""
    session_id = session.get("sessionId")
    daemon: DaemonClient = session["client"]
    resolved = daemon.call("resolve_step", {"sessionId": session_id, "step": {"text": text}})
    if resolved["next"] == "fail":
        error = resolved.get("error") or _error_from_resolution(resolved)
        raise AssertionError(f"{error['code']}: {error.get('message', text)}")

    resolution = resolved["resolution"]
    if resolved["next"] == "invoke-local" and resolution["type"] in ("exact", "semantic"):
        function = _local_function(session, text)
        if function is None:
            raise AssertionError(f"the plugin has no function for {resolution['bindingId']}")
        function(**dict(resolution.get("params") or {}))
        daemon.call(
            "report_binding_result",
            {
                "sessionId": session_id,
                "step": {"text": text},
                "bindingId": resolution["bindingId"],
                "status": "passed",
                "durationMs": 0,
            },
        )
        return

    result = daemon.call("run_step", {"sessionId": session_id, "step": {"text": text}})
    if result["status"] in ("passed", "healed"):
        if result["status"] == "healed":
            session.setdefault("healed", []).append(text)
        return
    error = result.get("error") or {}
    raise AssertionError(f"{error.get('code', result['status'])}: {error.get('message', text)}")


def _error_from_resolution(resolved: Dict[str, Any]) -> Dict[str, str]:
    resolution = resolved.get("resolution", {})
    if resolution.get("type") == "ambiguous":
        return {"code": "STEP_AMBIGUOUS", "message": resolution.get("message", "ambiguous step")}
    if resolution.get("type") == "unbound":
        return {"code": "SETUP_UNBOUND", "message": resolution.get("message", "no binding")}
    return {"code": "FAILED", "message": resolution.get("message", "the step failed")}


def _local_function(session: Dict[str, Any], text: str) -> Optional[Any]:
    """Finds this project's own step function for a step text.

    A step the daemon resolves to `invoke-local` may be named by the daemon after
    another provider (the conformance kit does that), so the sentence is resolved
    against the project's own step definitions as well.
    """
    for _attribute, context, function in session.get("step_contexts", []):
        parser = getattr(context, "parser", None)
        if parser is None or getattr(parser, "name", "") == CATCH_ALL_PARSER_NAME:
            continue
        try:
            if parser.is_matching(text):
                return function
        except Exception:  # noqa: BLE001 - a foreign parser may raise on odd input
            continue
    return None


def install() -> bool:
    """Returns True when pytest-bdd is available.

    The registration itself happens at **module level** below, because pytest-bdd
    injects the step fixture into the *caller's module globals*: registering from
    inside a function would put the fixture in that function's locals, where pytest
    never looks. Importing this module (which the ``pytest11`` entry point does) is
    therefore all that `install()` documents.
    """
    return HAVE_PYTEST_BDD



if HAVE_PYTEST_BDD:  # ruff: noqa: SIM108 - explicit branches document the contract
    from pytest_bdd import given, step as step_decorator, then, when

    _CATCH_ALL_PARSER = AiBddParser(CATCH_ALL_PARSER_NAME)

    def ai_bdd_step(text: str, request: Any) -> None:
        """The catch-all: resolves and runs one step through the daemon."""
        session = request.getfixturevalue("ai_bdd_session")
        session.setdefault("step_contexts", _all_step_contexts(request))
        catch_all(session, text)

    when(_CATCH_ALL_PARSER)(ai_bdd_step)
    given(_CATCH_ALL_PARSER)(ai_bdd_step)
    then(_CATCH_ALL_PARSER)(ai_bdd_step)
    step_decorator(_CATCH_ALL_PARSER)(ai_bdd_step)
else:  # pragma: no cover - pytest-bdd is optional
    def ai_bdd_step(text: str, request: Any) -> None:
        raise RuntimeError("ai-bdd-pytest requires pytest-bdd>=9 to be installed")


__all__ = [
    "AiBddParser",
    "ai_bdd_session",
    "ai_bdd_step",
    "catch_all",
    "client",
    "describe",
    "install",
    "pytest_addoption",
]


os.environ.setdefault("AI_BDD_PYTEST_PLUGIN", PLUGIN["version"])
