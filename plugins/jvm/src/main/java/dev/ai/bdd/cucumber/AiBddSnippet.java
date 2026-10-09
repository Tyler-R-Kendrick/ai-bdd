package dev.ai.bdd.cucumber;

import io.cucumber.core.backend.Snippet;

import java.lang.reflect.Type;
import java.util.Map;

/**
 * The snippet Cucumber shows for a step nobody defined.
 *
 * It always points at the ai-bdd way of handling the step rather than suggesting an
 * empty Java method: the daemon, the lockfile and the report are what make an unbound
 * step reviewable.
 */
public class AiBddSnippet implements Snippet {

    @Override
    public java.text.MessageFormat template() {
        return new java.text.MessageFormat("// the step ''{0}'' is resolved by the ai-bdd daemon");
    }

    @Override
    public String tableHint() {
        return "  // the table is available to the daemon through the step arguments";
    }

    @Override
    public String arguments(Map<String, Type> arguments) {
        return "";
    }

    @Override
    public String escapePattern(String pattern) {
        return pattern.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
