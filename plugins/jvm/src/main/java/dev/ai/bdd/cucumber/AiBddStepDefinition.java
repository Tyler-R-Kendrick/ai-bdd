package dev.ai.bdd.cucumber;

import io.cucumber.core.backend.CucumberBackendException;
import java.lang.reflect.InvocationTargetException;
import io.cucumber.core.backend.CucumberInvocationTargetException;
import io.cucumber.core.backend.ParameterInfo;
import io.cucumber.core.backend.StepDefinition;

import java.lang.reflect.Type;
import java.util.List;
import java.util.Map;

/**
 * The catch-all step definition.
 *
 * Cucumber-JVM matches step definitions by their pattern, then hands the regex
 * groups to the definition through {@code execute}. This one matches every step
 * text, so any step without a native definition reaches the ai-bdd daemon.
 */
public class AiBddStepDefinition implements StepDefinition {

    /** Matches the whole step text and captures it. */
    public static final String PATTERN = "^(.*)$";

    private final AiBddRuntime runtime;
    private final String pattern;

    public AiBddStepDefinition(AiBddRuntime runtime) {
        this(runtime, PATTERN);
    }

    public AiBddStepDefinition(AiBddRuntime runtime, String pattern) {
        this.runtime = runtime;
        this.pattern = pattern;
    }

    @Override
    public void execute(Object[] args) throws CucumberBackendException, CucumberInvocationTargetException {
        String text = args != null && args.length > 0 && args[0] != null ? String.valueOf(args[0]) : "";
        try {
            runtime.runStep(text);
        } catch (AiBddError error) {
            // Cucumber wraps a step failure in an InvocationTargetException.
            throw new CucumberInvocationTargetException(
                    this, new InvocationTargetException(error, "ai-bdd step failed"));
        }
    }

    @Override
    public List<ParameterInfo> parameterInfos() {
        return List.of(new CatchAllParameterInfo());
    }

    @Override
    public String getPattern() {
        return pattern;
    }

    @Override
    public boolean isDefinedAt(StackTraceElement stackTraceElement) {
        return stackTraceElement.getClassName().equals(AiBddStepDefinition.class.getName());
    }

    @Override
    public String getLocation() {
        return AiBddStepDefinition.class.getName();
    }

    /** The single parameter a catch-all captures: the whole step text. */
    private static final class CatchAllParameterInfo implements ParameterInfo {

        @Override
        public Type getType() {
            return String.class;
        }

        @Override
        public boolean isTransposed() {
            return false;
        }

        @Override
        public io.cucumber.core.backend.TypeResolver getTypeResolver() {
            return new io.cucumber.core.backend.TypeResolver() {
                @Override
                public Type resolve() {
                    return String.class;
                }
            };
        }
    }

    /** Number of parameters Cucumber must hand over: exactly one. */
    public static int parameterCount() {
        return 1;
    }

    /** Convenience for the tests: the descriptor of the catch-all. */
    public Map<String, Object> describe() {
        return Map.of("pattern", pattern, "kind", "any");
    }
}
