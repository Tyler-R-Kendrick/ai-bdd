"""ai-bdd plugin for pytest-bdd.

Minimum glue: install the package (it is a ``pytest11`` entry point) and add one
``scenarios()`` line to a test module. The project's own steps stay more specific
and therefore win over the catch-all.

    # tests/test_billing.py
    from pytest_bdd import scenarios
    scenarios('../features')
"""

from .client import Connection, DaemonClient, DaemonError
from .parser import AiBddParser, CATCH_ALL_PARSER_NAME, describe

__all__ = [
    "AiBddParser",
    "CATCH_ALL_PARSER_NAME",
    "Connection",
    "DaemonClient",
    "DaemonError",
    "describe",
]

__version__ = "0.1.0"
