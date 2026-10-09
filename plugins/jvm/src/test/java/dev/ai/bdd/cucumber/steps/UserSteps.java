package dev.ai.bdd.cucumber.steps;

import dev.ai.bdd.cucumber.AiBddStep;
import io.cucumber.datatable.DataTable;
import io.cucumber.docstring.DocString;

/**
 * The project's own steps, as a Cucumber-JVM user writes them.
 *
 * They are discovered by the ai-bdd backend through the glue paths and published to
 * the daemon; the invocation stays here, which is what {@code invoke-local} asks for.
 */
public class UserSteps {

    @AiBddStep(pattern = "Seed a workspace {string} on the {string} plan", description = "Seeds a workspace with a name and a plan tier", kind = "setup")
    public boolean seedWorkspace(String name, String plan) {
        return name != null && !name.isEmpty() && plan != null && !plan.isEmpty();
    }

    @AiBddStep(pattern = "there's a free-tier workspace called {word}", description = "Seeds a workspace with a name and a plan tier", kind = "setup")
    public boolean seedFreeTier(String name) {
        return name != null && !name.isEmpty();
    }

    @AiBddStep(pattern = "Seed invoices from the table", description = "Seeds the invoices listed in the step table", kind = "setup")
    public boolean seedInvoices(DataTable table) {
        // The table reaches the method because the definition declares it: a
        // text-only catch-all cannot, Cucumber validates arity per definition.
        return table != null && !table.cells().isEmpty();
    }

    @AiBddStep(pattern = "Seed a workspace from a document", description = "Seeds a workspace from a docstring", kind = "setup")
    public boolean seedFromDocument(DocString document) {
        return document != null && document.getContent().contains("workspace");
    }
}
