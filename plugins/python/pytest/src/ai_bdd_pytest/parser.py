"""The catch-all ``StepParser``.

pytest-bdd collects every matching ``fixturedef`` and injects the most specific
one (by fixture path), so a catch-all registered by this plugin is *less*
 specific than a step defined in a conftest or a test module: user steps keep
winning, which is exactly the coexistence the specification requires.
"""

from __future__ import annotations

from typing import Any

try:  # pytest-bdd is an optional dependency at import time
    from pytest_bdd.parsers import StepParser as _StepParser

    HAVE_PYTEST_BDD = True
except ImportError:  # pragma: no cover - exercised only without pytest-bdd installed
    class _StepParser(object):  # type: ignore[no-redef]
        def __init__(self, name: str) -> None:
            self.name = name

    HAVE_PYTEST_BDD = False


class AiBddParser(_StepParser):
    """Matches every step and passes the raw text through as ``text``."""

    def parse_arguments(self, name: str) -> dict[str, Any] | None:
        return {"text": name}

    def is_matching(self, name: str) -> bool:
        return True


CATCH_ALL_PARSER_NAME = "ai_bdd"
"""The parser name the catch-all step is registered under."""


def describe(
    fn: Any = None,
    *,
    description: str | None = None,
    examples: list[str] | None = None,
    counter_examples: list[str] | None = None,
    kind: str | None = None,
    params: list[dict[str, Any]] | None = None,
) -> Any:
    """Attaches the semantics the resolver needs to an ordinary step function."""
    metadata = {
        "description": description,
        "examples": examples or [],
        "counterExamples": counter_examples or [],
        "kind": kind,
        "params": params or [],
    }

    def decorate(target: Any) -> Any:
        target.ai_bdd = metadata
        return target

    return decorate if fn is None else decorate(fn)
