package dev.ai.bdd.cucumber;

import io.cucumber.core.backend.CucumberBackendException;
import io.cucumber.core.backend.CucumberInvocationTargetException;
import io.cucumber.core.backend.ParameterInfo;
import io.cucumber.core.backend.StepDefinition;
import io.cucumber.core.backend.TypeResolver;
import io.cucumber.datatable.DataTable;
import io.cucumber.docstring.DocString;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A step definition backed by an {@link AiBddStep}-annotated method.
 *
 * Cucumber-JVM validates arity per definition, so a step that carries a
 * DataTable or a DocString needs a definition that declares it. Registering the
 * annotated methods natively (and excluding their patterns from the catch-all with
 * a negative lookahead) is what makes table and docstring steps work while every
 * other step still reaches the daemon.
 *
 * The execution stays in this process; the outcome is reported to the daemon so the
 * evidence chain and the report still see it.
 */
public class AiBddNativeStepDefinition implements StepDefinition {

    private final AiBddRuntime runtime;
    private final Method method;
    private final String pattern;
    private final String bindingId;
    private final List<ParameterInfo> parameterInfos;

    public AiBddNativeStepDefinition(AiBddRuntime runtime, Method method, String pattern, String bindingId) {
        this.runtime = runtime;
        this.method = method;
        this.pattern = pattern;
        this.bindingId = bindingId;
        this.parameterInfos = parameterInfosOf(method);
    }

    /** Parameter infos derived from the method signature, incl. DataTable and DocString. */
    private static List<ParameterInfo> parameterInfosOf(Method method) {
        List<ParameterInfo> infos = new ArrayList<>();
        for (Class<?> type : method.getParameterTypes()) {
            infos.add(new SimpleParameterInfo(type));
        }
        return infos;
    }

    @Override
    public void execute(Object[] args) throws CucumberBackendException, CucumberInvocationTargetException {
        String text = args != null && args.length > 0 && args[0] != null ? String.valueOf(args[0]) : pattern;
        long started = System.nanoTime();
        String status = "passed";
        Map<String, Object> error = null;
        try {
            method.setAccessible(true);
            Object target = java.lang.reflect.Modifier.isStatic(method.getModifiers()) ? null : newInstance(method.getDeclaringClass());
            Object result = method.invoke(target, args == null ? new Object[0] : args);
            if (result instanceof Boolean succeeded && !succeeded) {
                status = "failed";
                error = Map.of("message", "the binding returned false");
            }
        } catch (InvocationTargetException invocation) {
            Throwable cause = invocation.getCause() == null ? invocation : invocation.getCause();
            status = "failed";
            error = Map.of("message", cause.getMessage() == null ? cause.toString() : cause.getMessage());
        } catch (ReflectiveOperationException reflection) {
            status = "failed";
            error = Map.of("message", reflection.getMessage() == null ? reflection.toString() : reflection.getMessage());
        }

        runtime.reportLocal(bindingId, text, (int) ((System.nanoTime() - started) / 1_000_000), status, error);

        if ("failed".equals(status)) {
            AiBddError failure = new AiBddError("CHECK_FAILED", String.valueOf(error.get("message")), false);
            throw new CucumberInvocationTargetException(this, new InvocationTargetException(failure, "ai-bdd binding failed"));
        }
    }

    private static Object newInstance(Class<?> type) throws ReflectiveOperationException {
        var constructor = type.getDeclaredConstructor();
        constructor.setAccessible(true);
        return constructor.newInstance();
    }

    @Override
    public List<ParameterInfo> parameterInfos() {
        return parameterInfos;
    }

    @Override
    public String getPattern() {
        return pattern;
    }

    @Override
    public boolean isDefinedAt(StackTraceElement stackTraceElement) {
        return stackTraceElement.getClassName().equals(method.getDeclaringClass().getName())
                && stackTraceElement.getMethodName().equals(method.getName());
    }

    @Override
    public String getLocation() {
        return method.getDeclaringClass().getName() + "." + method.getName();
    }

    /** The binding id this definition reports under. */
    public String bindingId() {
        return bindingId;
    }

    /** A ParameterInfo for one Java type. */
    private record SimpleParameterInfo(Class<?> type) implements ParameterInfo {

        @Override
        public Type getType() {
            return type;
        }

        @Override
        public boolean isTransposed() {
            return false;
        }

        @Override
        public TypeResolver getTypeResolver() {
            return () -> type;
        }
    }

    /** True when the type can carry a table or a docstring argument. */
    static boolean isStepArgument(Class<?> type) {
        return DataTable.class.isAssignableFrom(type) || DocString.class.isAssignableFrom(type);
    }
}
