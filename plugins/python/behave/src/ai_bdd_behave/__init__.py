"""ai-bdd plugin for Behave.

Minimum glue: one ``install()`` call at the end of a step module whose name sorts
last (``zz_ai_bdd.py``), so behave's first-match order keeps your own steps winning.

    # features/steps/zz_ai_bdd.py
    from ai_bdd_behave import install
    install()
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

from .client import DaemonClient, DaemonError
from .matcher import AiBddMatcher, describe, register_matcher, use_matcher

__all__ = [
    "AiBddMatcher",
    "DaemonClient",
    "DaemonError",
    "describe",
    "install",
    "resolve_step",
    "run_step",
    "open_session",
    "register_bindings",
    "close_session",
    "before_scenario",
    "after_scenario",
    "chain_hooks",
    "installed",
]

PLUGIN = {"name": "ai-bdd-behave", "version": "0.1.0", "language": "python"}
_INSTALLED = False

default_client: Optional[DaemonClient] = None


def client() -> DaemonClient:
    global default_client
    if default_client is None:
        default_client = DaemonClient()
    return default_client


def _binding_descriptors() -> list[dict[str, Any]]:
    """Collects the descriptors of every registered step function.

    behave 1.3 keeps every definition in ``registry.steps`` keyed by step type
    (``given``/``when``/``then``/``step``), so one pass over that mapping is
    enough.
    """
    descriptors: list[dict[str, Any]] = []
    try:
        from behave import step_registry
    except ImportError:  # pragma: no cover - behave is optional
        return descriptors

    registry = step_registry.registry
    seen: set[int] = set()
    for step_type, definitions in getattr(registry, "steps", {}).items():
        for definition in definitions:
            function = getattr(definition, "func", None)
            if function is None or id(function) in seen:
                continue
            seen.add(id(function))
            metadata = getattr(function, "ai_bdd", {})
            code = getattr(function, "__code__", None)
            descriptors.append(
                _clean_descriptor(
                    {
                    "id": f"python:behave#{function.__module__}:{code.co_firstlineno if code else 0}",
                    "provider": "python:behave",
                    "pattern": definition.pattern,
                    "patternKind": "cucumber-expression",
                    "kind": metadata.get("kind") or _kind_for(step_type),
                    "description": metadata.get("description"),
                    "examples": metadata.get("examples") or [],
                    "counterExamples": metadata.get("counterExamples") or [],
                    "params": metadata.get("params") or [],
                    }
                )
            )
    return descriptors


def _clean_descriptor(descriptor: dict[str, Any]) -> dict[str, Any]:
    """Drops empty optional fields: the daemon schema rejects null descriptions."""
    return {
        key: value
        for key, value in descriptor.items()
        if not (value is None or (key in ("examples", "counterExamples", "params") and value == []))
    }


def _kind_for(step_type: str) -> str:
    return {"given": "setup", "when": "action", "then": "assertion"}.get(step_type, "action")


def open_session(context: Any, scenario: Any = None) -> str:
    name = getattr(scenario, "name", None) or getattr(context, "scenario", None) and context.scenario.name or "scenario"
    filename = getattr(scenario, "filename", None) or "feature"
    tags = list(getattr(scenario, "tags", []) or [])
    opened = client().call(
        "open_session",
        {
            "scenarioId": f"{filename}#{name}",
            "scenarioName": name,
            "tags": tags,
            "plugin": PLUGIN,
        },
    )
    session_id = opened["sessionId"]
    setattr(context, "ai_bdd_session_id", session_id)
    descriptors = _binding_descriptors()
    if descriptors:
        client().call(
            "register_bindings",
            {"sessionId": session_id, "provider": "python:behave", "bindings": descriptors},
        )
    return session_id


def close_session(context: Any, status: str = "passed") -> None:
    session_id = getattr(context, "ai_bdd_session_id", None)
    if not session_id:
        return
    client().call("close_session", {"sessionId": session_id, "status": status})
    setattr(context, "ai_bdd_session_id", None)


def resolve_step(context: Any, step: Any, kind: Optional[str] = None) -> dict[str, Any]:
    text = getattr(step, "name", None) or str(step)
    body: Dict[str, Any] = {"text": text}
    if kind:
        body["kind"] = kind
    return client().call(
        "resolve_step",
        {"sessionId": getattr(context, "ai_bdd_session_id", None), "step": body},
    )


def run_step(context: Any, step: Any, kind: Optional[str] = None) -> dict[str, Any]:
    text = getattr(step, "name", None) or str(step)
    body: Dict[str, Any] = {"text": text}
    if kind:
        body["kind"] = kind
    return client().call(
        "run_step",
        {"sessionId": getattr(context, "ai_bdd_session_id", None), "step": body},
    )


def register_bindings(context: Any = None, provider: str = "python:behave") -> dict[str, Any]:
    descriptors = _binding_descriptors()
    return client().call(
        "register_bindings",
        {
            "provider": provider,
            "bindings": descriptors,
            **(
                {"sessionId": getattr(context, "ai_bdd_session_id")}
                if context is not None and getattr(context, "ai_bdd_session_id", None)
                else {}
            ),
        },
    )


def _error_from_resolution(resolved: Dict[str, Any]) -> Dict[str, str]:
    """Maps a failing resolution onto an ai-bdd error code.

    The daemon normally fills `error`, but a plugin must not depend on that to
    report the right code (and behaves's AmbiguousStep needs STEP_AMBIGUOUS).
    """
    resolution = resolved.get("resolution", {})
    if resolution.get("type") == "ambiguous":
        return {"code": "STEP_AMBIGUOUS", "message": resolution.get("message", "ambiguous step")}
    if resolution.get("type") == "unbound":
        return {"code": "SETUP_UNBOUND", "message": resolution.get("message", "no binding")}
    return {"code": "FAILED", "message": resolution.get("message", "the step failed")}


def _catch_all(context: Any, text: str) -> None:
    """The generic step: resolve, then either call locally or run on the daemon."""
    resolved = resolve_step(context, type("Step", (), {"name": text})())
    if resolved["next"] == "fail":
        error = resolved.get("error") or _error_from_resolution(resolved)
        # behave has no in-step "ambiguous" status (it reports AMBIGUOUS only when
        # two *definitions* match), so an ai-bdd ambiguity surfaces as a failure
        # whose message carries the ai-bdd code, which is what the reporters use.
        raise AssertionError(f"{error['code']}: {error.get('message', text)}")
    resolution = resolved["resolution"]
    if resolved["next"] == "invoke-local" and resolution["type"] in ("exact", "semantic"):
        binding_id = resolution["bindingId"]
        function = _find_function(binding_id) or _find_function_for_step(text)
        if function is None:
            raise AssertionError(f"the plugin has no function for {binding_id}")
        started = os.times().elapsed
        try:
            params = dict(resolution.get("params") or {})
            _invoke(function, context, params)
            client().call(
                "report_binding_result",
                {
                    "sessionId": getattr(context, "ai_bdd_session_id", None),
                    "step": {"text": text},
                    "bindingId": binding_id,
                    "status": "passed",
                    "durationMs": max(0, int((os.times().elapsed - started) * 1000)),
                },
            )
        except Exception as error:  # noqa: BLE001 - reported to the daemon, then re-raised
            client().call(
                "report_binding_result",
                {
                    "sessionId": getattr(context, "ai_bdd_session_id", None),
                    "step": {"text": text},
                    "bindingId": binding_id,
                    "status": "failed",
                    "durationMs": max(0, int((os.times().elapsed - started) * 1000)),
                    "error": {"message": str(error)},
                },
            )
            raise
        return

    result = run_step(context, type("Step", (), {"name": text})())
    if result["status"] == "healed":
        # A heal is a pass in behave's report, and the ai-bdd reporters still show
        # it as `healed` (R-K22). Recorded on the context for the plugin's report.
        healed = getattr(context, "ai_bdd_healed", [])
        healed.append(text)
        setattr(context, "ai_bdd_healed", healed)
        return
    if result["status"] != "passed":
        error = result.get("error") or {}
        raise AssertionError(f"{error.get('code', result['status'])}: {error.get('message', text)}")


def _find_function(binding_id: str) -> Optional[Any]:
    try:
        from behave import step_registry
    except ImportError:  # pragma: no cover
        return None
    for definitions in getattr(step_registry.registry, "steps", {}).values():
        for definition in definitions:
            function = getattr(definition, "func", None)
            if function is None:
                continue
            code = getattr(function, "__code__", None)
            if f"python:behave#{function.__module__}:{code.co_firstlineno if code else 0}" == binding_id:
                return function
    return None


def _find_function_for_step(step_text: str) -> Optional[Any]:
    """Finds this plugin's own definition for a step text.

    The daemon may name a binding from another provider (the conformance kit does
    exactly that). A plugin only ever executes functions it owns, so it resolves
    the sentence against its own registry and leaves the rest to `run_step`.
    """
    try:
        from behave import step_registry
    except ImportError:  # pragma: no cover
        return None
    for definitions in getattr(step_registry.registry, "steps", {}).values():
        for definition in definitions:
            matcher = getattr(definition, "matcher", None)
            if matcher is None or getattr(matcher, "NAME", None) in (None, "ai_bdd"):
                continue
            try:
                if matcher.match(step_text) is not None:
                    return getattr(definition, "func", None)
            except Exception:  # noqa: BLE001 - a foreign matcher may raise on odd input
                continue
    return None


def _invoke(function: Any, context: Any, params: Dict[str, Any]) -> None:
    """Calls a step function with behave's own argument conventions."""
    import inspect

    signature = inspect.signature(function)
    accepts_context = "context" in signature.parameters
    accepts_params = any(
        parameter.kind in (parameter.POSITIONAL_OR_KEYWORD, parameter.KEYWORD_ONLY)
        for name, parameter in signature.parameters.items()
        if name not in ("context",)
    )
    if accepts_context and accepts_params:
        function(context, **params)
    elif accepts_context:
        function(context)
    else:
        function(**params)


def install() -> bool:
    """Registers the matcher and the catch-all step.

    Call it last in the last-loaded step module so behave's first-match order
    keeps user steps winning (Behave searches the typed lists before the generic
    list, and within a list in registration order).
    """
    global _INSTALLED
    if _INSTALLED:
        return True
    if not register_matcher():
        return False
    try:
        from behave import step, use_step_matcher
    except ImportError:  # pragma: no cover - behave is optional
        return False

    use_step_matcher("ai_bdd")

    def ai_bdd_step(context: Any, text: str) -> None:  # pragma: no cover - exercised by the conformance run
        _catch_all(context, text)

    ai_bdd_step.__name__ = "ai_bdd_step"
    step("{text}")(ai_bdd_step)
    use_step_matcher("parse")
    _INSTALLED = True
    return True


def before_scenario(context: Any, scenario: Any = None) -> None:
    """Opens a daemon session. Import it into ``environment.py``."""
    open_session(context, scenario)


def after_scenario(context: Any, scenario: Any = None) -> None:
    """Closes the session, reporting the scenario's worst status."""
    status = "failed" if getattr(context, "failed", False) else "passed"
    close_session(context, status)


def chain_hooks(module: Any) -> Any:
    """Wraps the user's ``before_scenario``/``after_scenario`` without clobbering them.

    ``module`` is the ``environment`` module behave loaded (pass ``sys.modules``
    lookups when needed). Existing hooks run first, then the plugin's.
    """
    for name, hook in (("before_scenario", before_scenario), ("after_scenario", after_scenario)):
        existing = getattr(module, name, None)
        if existing is hook:
            continue
        if existing is None:
            setattr(module, name, hook)
            continue
        setattr(module, name, _make_chained(existing, hook))
    return module


def _make_chained(first: Any, second: Any) -> Any:
    def chained(context: Any, *args: Any, **kwargs: Any) -> None:
        first(context, *args, **kwargs)
        second(context, *args, **kwargs)

    return chained


def installed() -> bool:
    return _INSTALLED


def _reset_for_tests() -> None:
    global _INSTALLED, default_client
    _INSTALLED = False
    default_client = None
