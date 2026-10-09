"""The project's own steps, as a real user would write them.

These are the sentences the conformance kit expects a plugin to serve locally.
"""

from behave import given, when

from ai_bdd_behave import describe


@given('Seed a workspace "{name}" on the "{plan}" plan')
@describe(description="Seeds a workspace with a name and a plan tier", kind="setup")
def seed_workspace(context, name, plan):
    context.seeded = (name, plan)


@given('there\'s a free-tier workspace called {name}')
@describe(description="Seeds a workspace with a name and a plan tier", kind="setup")
def seed_free_tier(context, name):
    context.seeded = (name, "free")


@when("Seed invoices from the table")
@describe(description="Seeds the invoices listed in the step table", kind="setup")
def seed_invoices(context):
    context.invoices = context.table


@when("Seed a workspace from a document")
@describe(description="Seeds a workspace from a docstring", kind="setup")
def seed_from_document(context):
    context.document = context.text
