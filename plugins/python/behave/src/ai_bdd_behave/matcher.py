"""The ``ai_bdd`` step matcher: one catch-all that forwards to the daemon.

Behave's matchers are *per definition*, so they cannot compute a global
step-to-binding margin. The plugin therefore owns only the catch-all and lets the
daemon do the global resolution behind it (section 4.5 of the specification).

The matcher must subclass ``behave.matchers.Matcher`` (behave validates that at
registration time) and is instantiated by behave as ``(func, pattern,
step_type)``; ``check_match`` receives the step text and returns a ``Match`` with
the captured ``text`` parameter, or ``None``.
"""

from __future__ import annotations

import re
from typing import Any, Optional

try:  # behave is an optional dependency at import time
    from behave.matchers import Argument, Matcher  # type: ignore[import-not-found]

    HAVE_BEHAVE = True
except ImportError:  # pragma: no cover - exercised only without behave installed
    Argument = None  # type: ignore[assignment]

    HAVE_BEHAVE = False

    class Matcher(object):  # type: ignore[no-redef]
        """Fallback base class so the module imports without behave."""

        NAME = None

        def __init__(self, func: Any = None, pattern: Any = None, step_type: Optional[str] = None) -> None:
            self.func = func
            self.pattern = pattern
            self.step_type = step_type or "step"

CATCH_ALL = re.compile(r"^(?P<text>.*)$", re.DOTALL)


class AiBddMatcher(Matcher):
    """Matches every step text and captures it as the ``text`` argument.

    Behave calls ``compile()`` while validating a definition and
    ``check_match()`` at match time; the latter returns a list of
    ``Argument`` instances (not a ``Match``), because behave wraps the result
    itself.
    """

    NAME = "ai_bdd"

    def compile(self):
        return self

    def check_match(self, step_text):
        matched = CATCH_ALL.match(step_text)
        if matched is None:
            return None
        text = matched.group("text")
        if HAVE_BEHAVE:
            return [
                Argument(
                    name="text",
                    start=0,
                    end=len(step_text),
                    original=step_text,
                    value=text,
                )
            ]
        return [{"name": "text", "value": text}]

    @property
    def regex_pattern(self) -> str:
        return CATCH_ALL.pattern

    def describe(self, schema: str = "") -> str:
        return f"ai_bdd catch-all: {CATCH_ALL.pattern}"


def match_text(step_text: str):
    """Pure helper used by the unit tests: returns the captured text or None."""
    matched = CATCH_ALL.match(step_text)
    return None if matched is None else matched.group("text")


def register_matcher() -> bool:
    """Registers the matcher class with behave. Returns False when behave is absent."""
    if not HAVE_BEHAVE:
        return False
    from behave import matchers

    factory = matchers.get_step_matcher_factory()
    registry = getattr(factory, "step_matcher_class_mapping", None) or getattr(factory, "STEP_MATCHER_CLASSES", None)
    if registry is not None and "ai_bdd" in registry:
        return True
    matchers.register_step_matcher_class("ai_bdd", AiBddMatcher)
    return True


def use_matcher(name: str = "ai_bdd") -> None:
    from behave import matchers

    matchers.use_step_matcher(name)


def describe(
    fn: Any = None,
    description: Optional[str] = None,
    examples: Optional[list[str]] = None,
    counter_examples: Optional[list[str]] = None,
    kind: Optional[str] = None,
    params: Optional[list[dict[str, Any]]] = None,
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

    # Support both `@describe(description=...)` and `@describe` usage.
    return decorate if fn is None else decorate(fn)
