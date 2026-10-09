package dev.ai.bdd.cucumber;

import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The per-scenario state: the daemon session, this backend's bindings and the step
 * outcomes Cucumber will look at.
 */
public class AiBddRuntime {

    /** The provider name bindings are published under. */
    public static final String PROVIDER = "java:cucumber-jvm";
    private static final Map<String, Object> PLUGIN = Map.of(
            "name", "ai-bdd-cucumber",
            "version", "0.1.0",
            "language", "java");

    private final AiBddClient client;
    private final AiBddBindings bindings = new AiBddBindings(PROVIDER);
    private String sessionId;
    private String traceId;
    private final List<String> healed = new ArrayList<>();
    private boolean failed;

    public AiBddRuntime(Path projectRoot) {
        this.client = new AiBddClient(projectRoot);
    }

    public AiBddRuntime(AiBddClient client) {
        this.client = client;
    }

    public AiBddClient client() {
        return client;
    }

    public AiBddBindings bindings() {
        return bindings;
    }

    public List<String> healed() {
        return healed;
    }

    public String sessionId() {
        return sessionId;
    }

    public void markFailed() {
        this.failed = true;
    }

    /** Registers an annotated method as a binding. */
    public String register(Method method, AiBddStep annotation, List<Map<String, Object>> params) {
        return bindings.add(annotation.pattern(), annotation.description(), annotation.kind(), params, method);
    }

    /** Registers a binding discovered through a native Cucumber-JVM definition. */
    public String registerNative(String pattern, String description, Method method) {
        return bindings.add(pattern, description, "", List.of(), method);
    }

    /** Opens the daemon session and publishes the bindings. */
    public void openSession(String scenarioName, List<String> tags) {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("scenarioId", "cucumber-jvm#" + scenarioName);
        input.put("scenarioName", scenarioName);
        input.put("tags", tags);
        input.put("plugin", PLUGIN);
        Map<String, Object> opened = client.call("open_session", input);
        sessionId = String.valueOf(opened.get("sessionId"));
        traceId = String.valueOf(opened.getOrDefault("traceId", ""));
        List<Map<String, Object>> descriptors = bindings.publish();
        if (!descriptors.isEmpty()) {
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("sessionId", sessionId);
            request.put("provider", PROVIDER);
            request.put("bindings", descriptors);
            client.callVoid("register_bindings", request);
        }
    }

    /** Closes the session with the scenario's status. */
    public void closeSession() {
        if (sessionId == null) {
            return;
        }
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("sessionId", sessionId);
        input.put("status", failed ? "failed" : "passed");
        try {
            client.callVoid("close_session", input);
        } catch (AiBddError ignored) {
            // closing is best effort: the daemon may already have reaped the session
        }
        sessionId = null;
    }

    /** Runs one step: resolve, then either invoke locally or let the daemon run it. */
    @SuppressWarnings("unchecked")
    public void runStep(String text) {
        Map<String, Object> step = new LinkedHashMap<>();
        step.put("text", text);
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("sessionId", sessionId);
        input.put("step", step);
        Map<String, Object> resolved = client.call("resolve_step", input);
        String next = String.valueOf(resolved.get("next"));
        Map<String, Object> resolution = (Map<String, Object>) resolved.get("resolution");

        if ("fail".equals(next)) {
            failed = true;
            throw failure(text, resolved, resolution);
        }

        if ("invoke-local".equals(next) && resolution != null
                && ("exact".equals(resolution.get("type")) || "semantic".equals(resolution.get("type")))) {
            String bindingId = String.valueOf(resolution.get("bindingId"));
            Optional<AiBddBindings.Entry> entry = bindings.find(bindingId);
            Map<String, Object> params = new LinkedHashMap<>();
            if (entry.isPresent()) {
                Object raw = resolution.get("params");
                if (raw instanceof Map<?, ?> map) {
                    ((Map<String, Object>) map).forEach(params::put);
                }
            } else {
                entry = bindings.findForStep(text);
                if (entry.isPresent()) {
                    params.putAll(entry.get().capture(text));
                }
            }
            if (entry.isEmpty()) {
                failed = true;
                throw new AiBddError("PARAM_EXTRACTION_FAILED", "the backend has no method for " + bindingId, false);
            }
            long started = System.nanoTime();
            List<String> values = entry.get().values(text);
            String status = "passed";
            Map<String, Object> error = null;
            try {
                Object result = bindings.invoke(entry.get(), values, params);
                if (result instanceof Boolean succeeded && !succeeded) {
                    status = "failed";
                    error = Map.of("message", "the binding returned false");
                }
            } catch (RuntimeException problem) {
                status = "failed";
                error = Map.of("message", problem.getMessage() == null ? problem.toString() : problem.getMessage());
            }
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("sessionId", sessionId);
            report.put("step", step);
            report.put("bindingId", bindingId);
            report.put("status", status);
            report.put("durationMs", (int) ((System.nanoTime() - started) / 1_000_000));
            if (error != null) {
                report.put("error", error);
            }
            client.callVoid("report_binding_result", report);
            if ("failed".equals(status)) {
                failed = true;
                throw new AiBddError("CHECK_FAILED", String.valueOf(error.get("message")), false);
            }
            return;
        }

        Map<String, Object> result = client.call("run_step", input);
        String status = String.valueOf(result.get("status"));
        if ("passed".equals(status)) {
            return;
        }
        if ("healed".equals(status)) {
            // A heal is a pass in Cucumber's report; the ai-bdd reporters still show
            // it as healed (R-K22).
            healed.add(text);
            return;
        }
        failed = true;
        Object error = result.get("error");
        if (error instanceof Map<?, ?> map) {
            throw new AiBddError(String.valueOf(map.get("code")), String.valueOf(map.get("message")), false);
        }
        throw new AiBddError(status.toUpperCase(), text, false);
    }

    /** Reports a locally executed binding to the daemon, so evidence sees it. */
    public void reportLocal(String bindingId, String text, int durationMs, String status, Map<String, Object> error) {
        if (sessionId == null) {
            return;
        }
        Map<String, Object> step = new LinkedHashMap<>();
        step.put("text", text);
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("sessionId", sessionId);
        report.put("step", step);
        report.put("bindingId", bindingId);
        report.put("status", status);
        report.put("durationMs", durationMs);
        if (error != null) {
            report.put("error", error);
        }
        try {
            client.callVoid("report_binding_result", report);
        } catch (AiBddError ignored) {
            // reporting is best effort: the step outcome is already decided
        }
        if ("failed".equals(status)) {
            markFailed();
        }
    }

    @SuppressWarnings("unchecked")
    private AiBddError failure(String text, Map<String, Object> resolved, Map<String, Object> resolution) {
        Object error = resolved.get("error");
        if (error instanceof Map<?, ?> map) {
            return new AiBddError(String.valueOf(map.get("code")), String.valueOf(map.get("message")), false);
        }
        if (resolution != null && "ambiguous".equals(resolution.get("type"))) {
            return new AiBddError("STEP_AMBIGUOUS", String.valueOf(resolution.get("message")), false);
        }
        if (resolution != null && "unbound".equals(resolution.get("type"))) {
            return new AiBddError("SETUP_UNBOUND", String.valueOf(resolution.get("message")), false);
        }
        return new AiBddError("FAILED", text, false);
    }
}
