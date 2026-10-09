package dev.ai.bdd.cucumber;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;

/**
 * `ai-bdd.properties` on the classpath, or in the project root.
 *
 * Supported keys:
 *
 * <ul>
 *   <li>{@code nativePatterns} — a comma-separated list of the project's own step
 *       patterns. When set, the catch-all becomes a negative lookahead over them,
 *       which is the Cucumber-JVM equivalent of cucumber-js's coexist mode: a step
 *       that a native definition already matches is left to the java backend instead
 *       of making Cucumber report {@code AmbiguousStepDefinitionsException}.</li>
 *   <li>{@code projectRoot} — overrides where the daemon lookup starts.</li>
 * </ul>
 */
public record AiBddOptions(List<String> nativePatterns, Path projectRoot) {

    public static AiBddOptions load(Path fallbackRoot) {
        Properties properties = new Properties();
        try (InputStream fromClasspath = AiBddOptions.class.getClassLoader().getResourceAsStream("ai-bdd.properties")) {
            if (fromClasspath != null) {
                properties.load(fromClasspath);
            }
        } catch (IOException ignored) {
            // a missing or unreadable file just means no options
        }
        Path root = fallbackRoot;
        Path file = fallbackRoot != null ? fallbackRoot.resolve("ai-bdd.properties") : Path.of("ai-bdd.properties");
        if (Files.exists(file)) {
            try (InputStream stream = Files.newInputStream(file)) {
                properties.load(stream);
            } catch (IOException ignored) {
                // ignore: the classpath copy already provided what it could
            }
        }
        String configuredRoot = properties.getProperty("projectRoot");
        if (configuredRoot != null && !configuredRoot.isBlank()) {
            root = Path.of(configuredRoot.trim());
        }
        String patterns = properties.getProperty("nativePatterns", "");
        List<String> nativePatterns = patterns.isBlank()
                ? List.of()
                : Arrays.stream(patterns.split(",")).map(String::trim).filter(value -> !value.isEmpty()).toList();
        return new AiBddOptions(nativePatterns, root);
    }

    public static AiBddOptions empty() {
        return new AiBddOptions(List.of(), Path.of(System.getProperty("user.dir")));
    }
}
