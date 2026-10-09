package dev.ai.bdd.cucumber;

import io.cucumber.core.backend.Backend;
import io.cucumber.core.backend.Glue;
import io.cucumber.core.backend.Snippet;
import io.cucumber.core.backend.discovery.ClassGlueDiscoverySelector;
import io.cucumber.core.backend.discovery.GlueClassNameFilter;
import io.cucumber.core.backend.discovery.GlueDiscoveryRequest;
import io.cucumber.core.backend.discovery.UriGlueDiscoverySelector;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The ai-bdd Cucumber-JVM backend.
 *
 * It registers exactly one catch-all step definition plus every
 * {@link AiBddStep}-annotated method it can find in the glue paths, and it owns the
 * per-scenario daemon session.
 *
 * Cucumber-JVM collects every definition whose pattern matches a step and raises
 * {@code AmbiguousStepDefinitionsException} when more than one does, so this
 * backend relies on the project's own definitions living in *other* backends (the
 * java backend) and on the daemon resolving the rest. When a project wants the
 * catch-all to ignore native patterns as well, it can list them in
 * {@code ai-bdd.properties} under {@code nativePatterns} and the backend will
 * compute a negative lookahead, exactly like the cucumber-js coexist mode.
 */
public class AiBddBackend implements Backend {

    private final Supplier<ClassLoader> classLoader;
    private final List<Method> annotated = new ArrayList<>();
    private final Path projectRoot;
    private AiBddRuntime runtime;
    private boolean useNegativeLookahead;

    public AiBddBackend(Supplier<ClassLoader> classLoader, Path projectRoot) {
        this.classLoader = classLoader;
        this.projectRoot = projectRoot;
    }

    @Override
    public void loadGlue(Glue glue, GlueDiscoveryRequest request) {
        List<URI> gluePaths = request
                .getSelectorsByType(UriGlueDiscoverySelector.class)
                .stream()
                .map(UriGlueDiscoverySelector::uri)
                .toList();
        AiBddOptions options = AiBddOptions.load(projectRoot);
        discover(gluePaths, request);
        registerGlue(glue, options);
    }

    @Override
    @Deprecated
    public void loadGlue(Glue glue, List<URI> gluePaths) {
        AiBddOptions options = AiBddOptions.load(projectRoot);
        discover(gluePaths, null);
        registerGlue(glue, options);
    }

    /**
     * Registers one step definition per annotated method, then the catch-all.
     *
     * The catch-all excludes the annotated patterns with a negative lookahead:
     * Cucumber-JVM reports {@code AmbiguousStepDefinitionsException} when two
     * definitions match, so a plain catch-all would shadow the project's own steps.
     */
    private void registerGlue(Glue glue, AiBddOptions options) {
        List<String> nativePatterns = new ArrayList<>(options.nativePatterns());
        AiBddRuntime runtime = runtimeFor();
        for (Method method : annotated) {
            AiBddStep annotation = method.getAnnotation(AiBddStep.class);
            if (annotation == null) {
                continue;
            }
            String bindingId = runtime.register(method, annotation, List.of());
            nativePatterns.add(annotation.pattern());
            glue.addStepDefinition(new AiBddNativeStepDefinition(runtime, method, annotation.pattern(), bindingId));
        }
        useNegativeLookahead = !nativePatterns.isEmpty();
        glue.addStepDefinition(new AiBddStepDefinition(runtime, catchAllPattern(nativePatterns)));
    }

    /** The catch-all pattern, excluding the patterns a native definition handles. */
    static String catchAllPattern(List<String> nativePatterns) {
        if (nativePatterns.isEmpty()) {
            return AiBddStepDefinition.PATTERN;
        }
        List<String> alternatives = new ArrayList<>();
        for (String pattern : nativePatterns) {
            alternatives.add("(?:" + toRegexBody(pattern) + ")");
        }
        return "^(?!" + String.join("|", alternatives) + "$)(.*)$";
    }

    /** Turns a Cucumber Expression into the regex body a lookahead needs. */
    private static String toRegexBody(String pattern) {
        String body = pattern;
        if (body.startsWith("^") && body.endsWith("$") && body.length() > 1) {
            return body.substring(1, body.length() - 1);
        }
        StringBuilder builder = new StringBuilder();
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\{([a-zA-Z0-9_]+)\\}").matcher(pattern);
        int index = 0;
        while (matcher.find()) {
            builder.append(java.util.regex.Pattern.quote(pattern.substring(index, matcher.start())));
            builder.append(".*?");
            index = matcher.end();
        }
        builder.append(java.util.regex.Pattern.quote(pattern.substring(index)));
        return builder.toString();
    }

    @Override
    public void buildWorld() {
        runtimeFor().openSession("cucumber-jvm scenario", List.of());
    }

    @Override
    public void disposeWorld() {
        if (runtime != null) {
            runtime.closeSession();
        }
    }

    @Override
    public Snippet getSnippet() {
        return new AiBddSnippet();
    }

    /** The runtime for the current run, created lazily so `doctor` can probe it. */
    public AiBddRuntime runtimeFor() {
        if (runtime == null) {
            runtime = new AiBddRuntime(projectRoot);
            for (Method method : annotated) {
                AiBddStep annotation = method.getAnnotation(AiBddStep.class);
                if (annotation != null) {
                    runtime.register(method, annotation, List.of());
                }
            }
        }
        return runtime;
    }

    /** True when the catch-all is built as a negative lookahead over native patterns. */
    public boolean usesNegativeLookahead() {
        return useNegativeLookahead;
    }

    /**
     * Finds the annotated glue classes.
     *
     * Cucumber hands a backend both file paths and {@code classpath:} URIs, plus
     * (optionally) explicit class-name selectors, so all three shapes are handled.
     * Glue that only exists inside a jar is not scanned: annotate a class in a
     * directory-based classpath, or list it in {@code ai-bdd.properties}.
     */
    private void discover(List<URI> gluePaths, GlueDiscoveryRequest request) {
        boolean debug = System.getProperty("ai-bdd.debug") != null;
        if (debug) {
            System.out.println("[ai-bdd] glue paths: " + gluePaths);
        }
        for (URI path : gluePaths) {
            String scheme = path.getScheme();
            if (scheme == null || "file".equals(scheme)) {
                inspectLocation(Path.of(path), "");
            } else if ("classpath".equals(scheme)) {
                inspectClasspath(path.getSchemeSpecificPart());
            }
        }
        if (request != null) {
            for (ClassGlueDiscoverySelector selector : request.getSelectorsByType(ClassGlueDiscoverySelector.class)) {
                try {
                    inspect(Class.forName(selector.name(), false, classLoader.get()));
                } catch (ClassNotFoundException | LinkageError ignored) {
                    // a class that cannot be loaded is not glue
                }
            }
        }
    }

    private void inspectLocation(Path candidate, String packagePrefix) {
        File file = candidate.toFile();
        if (!file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            ClassScanner.scan(candidate, classLoader.get(), packagePrefix).forEach(this::inspect);
        } else if (file.getName().endsWith(".class")) {
            ClassScanner.loadClass(file).ifPresent(this::inspect);
        }
    }

    /**
     * Scans the classpath entries a `classpath:` glue URI points at.
     *
     * The URI carries a package path (`classpath:dev/ai/bdd/cucumber/steps`), so the
     * package prefix is kept: a class name needs it to load.
     */
    private void inspectClasspath(String packagePath) {
        // Cucumber hands `classpath:/dev/ai/bdd/cucumber/steps`, and a classloader
        // resource lookup must not start with a slash.
        String normalized = packagePath == null ? "" : packagePath;
        while (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        String resource = normalized.replace('.', '/');
        String packagePrefix = resource.replace('/', '.');
        try {
            var resources = classLoader.get().getResources(resource);
            while (resources.hasMoreElements()) {
                URL url = resources.nextElement();
                if (!"file".equals(url.getProtocol())) {
                    continue;
                }
                inspectLocation(Path.of(url.toURI()), packagePrefix);
            }
            if (!resources.hasMoreElements() && !resource.isEmpty()) {
                // Fall back to the classpath roots, in case the package lives in a jar
                // layout the resource lookup cannot enumerate.
                var roots = classLoader.get().getResources("");
                while (roots.hasMoreElements()) {
                    URL root = roots.nextElement();
                    if ("file".equals(root.getProtocol())) {
                        inspectLocation(Path.of(root.toURI()).resolve(resource), packagePrefix);
                    }
                }
            }
        } catch (IOException | URISyntaxException ignored) {
            // an unreadable classpath entry is not glue
        }
    }

    private void inspect(Class<?> type) {
        boolean debug = System.getProperty("ai-bdd.debug") != null;
        if (debug) {
            System.out.println("[ai-bdd] inspecting " + type.getName());
        }
        for (Method method : type.getDeclaredMethods()) {
            if (method.isAnnotationPresent(AiBddStep.class)) {
                // The same class can be reached through a glue URI and a class-name
                // selector; a method must be registered once or Cucumber reports a
                // duplicate step definition.
                boolean known = annotated.stream().anyMatch(existing ->
                        existing.getDeclaringClass().equals(method.getDeclaringClass())
                                && existing.getName().equals(method.getName()));
                if (known) {
                    continue;
                }
                annotated.add(method);
                if (debug) {
                    System.out.println("[ai-bdd] binding " + method.getName() + " -> " + method.getAnnotation(AiBddStep.class).pattern());
                }
            }
        }
    }

    /** Exposes the annotated methods for the tests. */
    public List<Method> annotatedMethods() {
        return List.copyOf(annotated);
    }

    /** The plugin metadata sent to the daemon. */
    public Map<String, Object> pluginInfo() {
        return Map.of("name", "ai-bdd-cucumber", "version", "0.1.0", "language", "java");
    }
}
