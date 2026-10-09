"""The project's own steps, as a pytest-bdd 9 user would write them.

pytest-bdd 9 treats a plain string as an *exact* match, so a step with parameters
declares its parser explicitly (`parsers.parse(...)` / `parsers.cfparse(...)`).
"""

from pytest_bdd import given, parsers, when

from ai_bdd_pytest import describe


@given(parsers.parse('Seed a workspace "{name}" on the "{plan}" plan'))
@describe(description="Seeds a workspace with a name and a plan tier", kind="setup")
def seed_workspace(name, plan):
    return {"name": name, "plan": plan}


@given(parsers.cfparse("there's a free-tier workspace called {name}"))
@describe(description="Seeds a workspace with a name and a plan tier", kind="setup")
def seed_free_tier(name):
    return {"name": name, "plan": "free"}


@when("Seed invoices from the table")
@describe(description="Seeds the invoices listed in the step table", kind="setup")
def seed_invoices(datatable):
    return datatable


@when("Seed a workspace from a document")
@describe(description="Seeds a workspace from a docstring", kind="setup")
def seed_from_document(docstring):
    return docstring
